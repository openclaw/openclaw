import { readPositiveIntegerParam, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  ErrorCodes,
  errorShape,
  runWithLocalStateMutationOwner,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  listAgentIds,
  resolveDefaultAgentId,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveMemoryRemDreamingConfig } from "openclaw/plugin-sdk/memory-core-host-status";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import type { SessionBackfillResult } from "./session-backfill-contract.js";
import { normalizeSessionBackfillSelection } from "./session-backfill-selection.js";

class InvalidSessionBackfillRequestError extends Error {}

const loadSessionBackfillGatewayRuntime = createLazyRuntimeModule(
  () => import("./session-backfill-gateway.runtime.js"),
);

function paramsRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("params must be an object.");
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(params: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const unexpected = Object.keys(params).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(`unexpected parameter: ${unexpected[0]}`);
  }
}

function readOptionalSessionBoundary(params: Record<string, unknown>, key: "from" | "to") {
  const raw = params[key];
  if (raw !== undefined && typeof raw !== "string") {
    throw new Error(`${key} must be a string.`);
  }
  return readStringParam(params, key);
}

function readGatewayParams(value: unknown, rollback: boolean, defaultAgentId: () => string) {
  const params = paramsRecord(value);
  const cliResult = params.cliResult === true;
  const ownerId =
    params.expectedOwnerId === undefined
      ? undefined
      : readStringParam(params, "expectedOwnerId", { required: true });
  if (cliResult && !ownerId) {
    throw new Error("CLI backfill results require a selected Gateway owner");
  }
  if (params.operationOwnerId !== undefined && params.operationOwnerId !== ownerId) {
    throw new Error(
      "Gateway owner changed during session backfill; inspect its result before retrying",
    );
  }
  assertOnlyKeys(
    params,
    new Set([
      "expectedOwnerId",
      "operationOwnerId",
      "cliResult",
      ...(rollback ? ["agentId"] : ["agentId", "from", "to", "limitDays"]),
    ]),
  );
  const agentId = normalizeAgentId(
    readStringParam(params, "agentId", { required: !cliResult || params.agentId !== undefined }) ??
      defaultAgentId(),
  );
  if (rollback) {
    return { agentId, ownerId, cliResult };
  }
  const selection = normalizeSessionBackfillSelection(
    {
      from: readOptionalSessionBoundary(params, "from"),
      to: readOptionalSessionBoundary(params, "to"),
      limitDays: readPositiveIntegerParam(params, "limitDays"),
    },
    { from: "from", to: "to", limitDays: "limitDays" },
  );
  return { agentId, ...selection, ownerId, cliResult };
}

function resolveExecutionContext(api: OpenClawPluginApi, agentId: string) {
  const config = api.runtime.config.current() as OpenClawConfig;
  const configuredAgentIds = listAgentIds(config);
  if (!configuredAgentIds.includes(agentId)) {
    throw new InvalidSessionBackfillRequestError(`Unknown agent id "${agentId}".`);
  }
  const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(config, agentId);
  const pluginConfig = resolvePluginConfigObject(config, "memory-core");
  const remConfig = resolveMemoryRemDreamingConfig({
    cfg: config,
    pluginConfig,
  });
  return {
    workspaceDir,
    ...(pluginConfig ? { pluginConfig } : {}),
    ...(remConfig.timezone !== undefined ? { timezone: remConfig.timezone } : {}),
  };
}

function gatewayResult(
  result: SessionBackfillResult,
  options: {
    includeCursor: boolean;
    continuation: { advanced: boolean; hasMore: boolean };
  },
) {
  return {
    days: result.days.length,
    candidates: result.candidateCount,
    perDay: result.days.map((day) => ({
      day: day.day,
      candidateCount: day.candidateCount,
      sample: day.topCandidates.slice(0, 3),
    })),
    staged: result.stagedEntries,
    ...(!options.includeCursor ? { truncated: options.continuation.hasMore } : {}),
    ...(options.includeCursor
      ? {
          cursor: {
            advanced: options.continuation.advanced,
            exhausted: result.candidateCount === 0 && !options.continuation.hasMore,
            hasMore: options.continuation.hasMore,
          },
        }
      : {}),
  };
}

function respondInvalid(respond: GatewayRequestHandlerOptions["respond"], error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
}

export function registerSessionBackfillGatewayMethods(api: OpenClawPluginApi): void {
  for (const operation of ["preview", "apply", "rollback"] as const) {
    const apply = operation === "apply";
    const rollback = operation === "rollback";
    for (const ownerBound of [false, true]) {
      api.registerGatewayMethod(
        `memory.sessionBackfill.${operation}${ownerBound ? ".owner" : ""}`,
        async (invocation: GatewayRequestHandlerOptions) => {
          const { params, respond } = invocation;
          let request: ReturnType<typeof readGatewayParams>;
          try {
            if (
              ownerBound &&
              (typeof params.expectedOwnerId !== "string" || !params.expectedOwnerId.trim())
            ) {
              throw new Error("expectedOwnerId must be a non-empty string");
            }
            request = readGatewayParams(params, rollback, () =>
              resolveDefaultAgentId(invocation.context.getRuntimeConfig()),
            );
          } catch (error) {
            respondInvalid(respond, error);
            return;
          }
          try {
            const { ownerId, cliResult, ...selection } = request;
            let assertOwnerCurrent: (() => void) | undefined;
            const run = async (assertCurrent?: () => void) => {
              assertOwnerCurrent = assertCurrent;
              const context = resolveExecutionContext(api, request.agentId);
              const { executeSessionBackfillBatch } = await loadSessionBackfillGatewayRuntime();
              assertCurrent?.();
              const execution = await executeSessionBackfillBatch({
                ...selection,
                ...context,
                ...(assertCurrent ? { assertCurrent } : {}),
                ...(apply ? { apply: true } : {}),
                ...(rollback ? { rollback: true } : {}),
              });
              const { result, continuation } = execution;
              assertCurrent?.();
              return cliResult
                ? { execution, ownerId }
                : rollback
                  ? {
                      removedDiaryEntries: result.rollback?.removedDiaryEntries ?? 0,
                      removedStagedEntries: result.rollback?.removedStagedEntries ?? 0,
                    }
                  : gatewayResult(result, { includeCursor: apply, continuation });
            };
            const payload = ownerId
              ? await runWithLocalStateMutationOwner(ownerId, invocation, run)
              : await run();
            assertOwnerCurrent?.();
            respond(true, payload);
          } catch (error) {
            if (error instanceof InvalidSessionBackfillRequestError) {
              respondInvalid(respond, error);
            } else {
              const message = error instanceof Error ? error.message : String(error);
              respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
            }
          }
        },
        { scope: !ownerBound && operation === "preview" ? "operator.read" : "operator.admin" },
      );
    }
  }
}
