import { readPositiveIntegerParam, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { listAgentIds } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
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

function readGatewayParams(value: unknown, rollback: boolean) {
  const params = paramsRecord(value);
  assertOnlyKeys(params, new Set(rollback ? ["agentId"] : ["agentId", "from", "to", "limitDays"]));
  const agentId = normalizeAgentId(readStringParam(params, "agentId", { required: true }));
  if (rollback) {
    return { agentId };
  }
  const selection = normalizeSessionBackfillSelection(
    {
      from: readOptionalSessionBoundary(params, "from"),
      to: readOptionalSessionBoundary(params, "to"),
      limitDays: readPositiveIntegerParam(params, "limitDays"),
    },
    { from: "from", to: "to", limitDays: "limitDays" },
  );
  return { agentId, ...selection };
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
    api.registerGatewayMethod(
      `memory.sessionBackfill.${operation}`,
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        let request: ReturnType<typeof readGatewayParams>;
        try {
          request = readGatewayParams(params, rollback);
        } catch (error) {
          respondInvalid(respond, error);
          return;
        }
        try {
          const context = resolveExecutionContext(api, request.agentId);
          const { executeSessionBackfillBatch } = await loadSessionBackfillGatewayRuntime();
          const { result, continuation } = await executeSessionBackfillBatch({
            ...request,
            ...context,
            ...(apply ? { apply: true } : {}),
            ...(rollback ? { rollback: true } : {}),
          });
          respond(
            true,
            rollback
              ? {
                  removedDiaryEntries: result.rollback?.removedDiaryEntries ?? 0,
                  removedStagedEntries: result.rollback?.removedStagedEntries ?? 0,
                }
              : gatewayResult(result, { includeCursor: apply, continuation }),
          );
        } catch (error) {
          if (error instanceof InvalidSessionBackfillRequestError) {
            respondInvalid(respond, error);
          } else {
            const message = error instanceof Error ? error.message : String(error);
            respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
          }
        }
      },
      { scope: operation === "preview" ? "operator.read" : "operator.admin" },
    );
  }
}
