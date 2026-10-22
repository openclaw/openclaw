import { createHash, randomUUID } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type {
  NativeSubagentAccepted,
  NativeSubagentRuntime,
  NativeSubagentSelection,
} from "../plugins/runtime/types-native-subagent.js";
import { normalizeAcceptedSessionSpawnResult } from "./accepted-session-spawn.js";
import type { AdmittedRunContext, AdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { runWithToolExecutionValidation } from "./agent-tools.execution-validation.js";
import type { InternalCodingToolsOptions } from "./agent-tools.options.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { matchesSubagentRequesterSession } from "./subagents/registry/subagent-registry-queries.js";
import {
  getSwarmRunByLaunchReplayKey,
  initSubagentRegistry,
  prepareSubagentRunsByRunIds,
  type SubagentRunRecord,
} from "./subagents/registry/subagent-registry.js";
import { loadSubagentSessionEntry } from "./subagents/registry/subagent-session-reconciliation.js";
import {
  SWARM_CODE_MODE_IDEMPOTENCY_KEY,
  SWARM_CODE_MODE_REQUEST_FINGERPRINT,
} from "./subagents/swarm/swarm-code-mode.js";
import {
  readNativeSubagentCollection,
  withNativeSubagentCollectorOwner,
} from "./tools/agents-wait-tool.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";

export type NativeSubagentRequestSource = {
  options: InternalCodingToolsOptions & {
    agentId: string;
    sessionKey: string;
    sessionId: string;
    runId: string;
  };
  lifecycleRevision?: string;
  operatorAuthority: AdmittedRunOperatorAuthority;
  assertCurrent: () => void;
  prepareSpawn: (assertCurrent: () => void) => Promise<AdmittedRunContext>;
};

/** Adapt the existing authorized native tool surface; do not create a second spawn owner. */
export function createRequestNativeSubagentRuntime(
  source: NativeSubagentRequestSource,
  guard: { pluginId: string; assertCurrent: () => void },
): NativeSubagentRuntime & { prepareCommand: () => Promise<boolean> } {
  const scope = getPluginRuntimeGatewayRequestScope();
  const resolveGatewayContext =
    scope?.resolveGatewayContext ?? scope?.context?.resolveGatewayContext;
  if (!resolveGatewayContext) {
    throw new Error("Native subagents require their request's Gateway binding.");
  }
  const assertCurrent = () => {
    guard.assertCurrent();
    source.assertCurrent();
    source.operatorAuthority.assertCurrent();
    source.options.abortSignal?.throwIfAborted();
    if (!resolveGatewayContext()) {
      throw new Error("Native subagent Gateway binding is no longer active.");
    }
  };
  const readSelection = async (
    runId: string,
    childSessionKey: string,
    requested: NativeSubagentSelection["requested"] = {},
    records?: ReadonlyMap<string, SubagentRunRecord>,
  ): Promise<NativeSubagentSelection> => {
    try {
      assertCurrent();
      let record = records?.get(runId);
      if (!records) {
        const prepared = await prepareSubagentRunsByRunIds([runId]);
        assertCurrent();
        const read = prepared.consume((runs) => runs.get(runId));
        record = read.ready ? read.value : undefined;
      }
      if (
        !record?.collect ||
        record.childSessionKey !== childSessionKey ||
        record.requesterSessionKey !== source.options.sessionKey ||
        !matchesSubagentRequesterSession(record, {
          sessionId: source.options.sessionId,
          lifecycleRevision: source.lifecycleRevision,
        })
      ) {
        return { requested };
      }
      // Optional descriptive reads cannot undo a native acceptance or completion.
      // In particular, neither tool-result hooks nor request echoes establish resolution.
      let child;
      try {
        child = await loadSubagentSessionEntry({
          childSessionKey,
          childAgentId: record.childAgentId,
          cfg: source.options.config,
          assertCurrent,
        });
      } catch {
        return { requested };
      }
      assertCurrent();
      const identity = record.childSessionIdentity;
      if (
        !child ||
        !identity ||
        child.sessionId !== identity.sessionId ||
        child.lifecycleRevision !== identity.lifecycleRevision
      ) {
        return { requested };
      }
      const resolved: NonNullable<NativeSubagentSelection["resolved"]> = {
        ...(child.modelProvider && child.model
          ? { model: `${child.modelProvider}/${child.model}` }
          : {}),
        ...(child.thinkingLevel !== undefined ? { thinking: child.thinkingLevel } : {}),
        ...(child.fastMode !== undefined ? { fastMode: child.fastMode } : {}),
      };
      // Session controls are not provider telemetry: do not infer observed facts.
      return { requested, ...(Object.keys(resolved).length > 0 ? { resolved } : {}) };
    } catch {
      // Descriptive metadata cannot revoke IDs already transferred to native custody.
      return { requested };
    }
  };
  let admitted: AdmittedRunContext | undefined;
  let preparedAdmission: Promise<AdmittedRunContext> | undefined;
  // Request/plugin-local joins leave durable replay and accepted children with the native owner.
  const inFlightSpawns = new Map<
    string,
    {
      fingerprint: string;
      result: Promise<NativeSubagentAccepted>;
    }
  >();
  const withCaller = <T>(run: () => Promise<T>) => {
    const identity = admitted
      ? createAdmittedGatewayToolCallerIdentity({
          admittedRunContext: admitted,
          agentId: source.options.agentId,
          sessionKey: source.options.sessionKey,
          receiptAuthority: assertCurrent,
        })
      : {
          agentId: source.options.agentId,
          sessionKey: source.options.sessionKey,
          operatorAuthority: source.operatorAuthority,
          receiptAuthority: assertCurrent,
          gatewayContextResolver: resolveGatewayContext,
        };
    if (!identity) {
      throw new Error("Native subagent controller admission is no longer active.");
    }
    return withGatewayToolCallerIdentity(identity, run);
  };
  let preparedTools: Promise<AnyAgentTool[]> | undefined;
  const tools = async () => {
    assertCurrent();
    preparedTools ??= withCaller(async () => {
      const { createOpenClawCodingToolsInternalAsync } = await import("./agent-tools.js");
      assertCurrent();
      return createOpenClawCodingToolsInternalAsync(
        {
          ...source.options,
          pluginExecutionAuthority: source.operatorAuthority,
          assertInvocationCurrent: assertCurrent,
        },
        undefined,
        undefined,
        undefined,
        { assertCurrent },
      );
    });
    const result = await preparedTools;
    assertCurrent();
    return result;
  };
  return {
    async prepareCommand() {
      const surface = await tools();
      if (
        !surface.some((tool) => tool.name === "sessions_spawn") ||
        !surface.some((tool) => tool.name === "agents_wait")
      ) {
        return false;
      }
      admitted = await (preparedAdmission ??= source.prepareSpawn(assertCurrent));
      assertCurrent();
      return true;
    },
    async spawn(params) {
      assertCurrent();
      if (!params.requestId?.trim()) {
        throw new Error("Native subagent spawn requires a non-empty requestId.");
      }
      const surface = await tools();
      const spawn = surface.find((tool) => tool.name === "sessions_spawn");
      if (!spawn) {
        throw new Error("sessions_spawn is not available to the current requester.");
      }
      admitted = await (preparedAdmission ??= source.prepareSpawn(assertCurrent));
      assertCurrent();
      // Explicit projection prevents undeclared JavaScript fields from supplying parent/authority.
      const args = {
        task: params.task,
        taskName: params.taskName,
        label: params.label,
        model: params.model,
        thinking: params.thinking,
        fastMode: params.fastMode,
        context: params.context,
        runTimeoutSeconds: params.runTimeoutSeconds,
        outputSchema: params.outputSchema,
        runtime: "subagent",
        mode: "run",
        collect: true,
      };
      const requested: NativeSubagentSelection["requested"] = {
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.thinking !== undefined ? { thinking: args.thinking } : {}),
        ...(args.fastMode !== undefined ? { fastMode: args.fastMode } : {}),
      };
      const replayKey = createHash("sha256")
        .update(
          JSON.stringify([
            guard.pluginId,
            source.options.sessionId,
            source.options.runId,
            params.requestId,
          ]),
        )
        .digest("hex");
      const fingerprint = createHash("sha256").update(stableStringify(args)).digest("hex");
      const inFlight = inFlightSpawns.get(replayKey);
      if (inFlight && inFlight.fingerprint !== fingerprint) {
        throw new Error("Native subagent replay does not match the admitted request.");
      }
      if (inFlight) {
        // The shared result still checks authority before acceptance. Once accepted,
        // descriptive-read cancellation cannot hide native IDs from joining callers.
        return await inFlight.result;
      }
      const result = (async (): Promise<NativeSubagentAccepted> => {
        let existing = await getSwarmRunByLaunchReplayKey(
          replayKey,
          source.options.sessionKey,
          source.options.agentId,
        );
        assertCurrent();
        if (existing) {
          if (
            !matchesSubagentRequesterSession(existing, {
              sessionId: source.options.sessionId,
              lifecycleRevision: source.lifecycleRevision,
            }) ||
            existing.swarmLaunchRequestFingerprint !== fingerprint
          ) {
            throw new Error("Native subagent replay does not match the admitted request.");
          }
          if (existing.swarmLaunchPending) {
            if (!existing.queuedLaunch) {
              throw new Error("Native subagent launch reservation cannot be recovered.");
            }
            await initSubagentRegistry();
            assertCurrent();
            existing =
              (await getSwarmRunByLaunchReplayKey(
                replayKey,
                source.options.sessionKey,
                source.options.agentId,
              )) ?? existing;
            assertCurrent();
            if (existing.swarmLaunchPending && !existing.queuedLaunch) {
              throw new Error("Native subagent launch reservation cannot be recovered.");
            }
          }
          return {
            runId: existing.swarmRunId ?? existing.runId,
            childSessionKey: existing.childSessionKey,
            completionMode: "collect",
            selection: await readSelection(existing.runId, existing.childSessionKey, requested),
          };
        }
        const toolCallId = randomUUID();
        const toolResult = await withCaller(() =>
          runWithToolExecutionValidation(
            toolCallId,
            (finalParams) => {
              assertCurrent();
              const final = asOptionalRecord(finalParams);
              // Hooks may rewrite the task, but not the native collector's completion contract.
              if (
                !final ||
                final.runtime !== "subagent" ||
                final.mode !== "run" ||
                final.collect !== true ||
                Reflect.get(final, SWARM_CODE_MODE_IDEMPOTENCY_KEY) !== replayKey ||
                Reflect.get(final, SWARM_CODE_MODE_REQUEST_FINGERPRINT) !== fingerprint
              ) {
                throw new Error(
                  "Native subagent hooks must preserve collector mode and replay identity.",
                );
              }
            },
            () =>
              spawn.execute(
                toolCallId,
                {
                  ...args,
                  [SWARM_CODE_MODE_IDEMPOTENCY_KEY]: replayKey,
                  [SWARM_CODE_MODE_REQUEST_FINGERPRINT]: fingerprint,
                },
                source.options.abortSignal,
              ),
          ),
        );
        assertCurrent();
        const accepted = normalizeAcceptedSessionSpawnResult(toolResult);
        if (!accepted) {
          const error = asOptionalRecord(toolResult.details)?.error;
          throw new Error(
            typeof error === "string" ? error : "Native subagent spawn was not accepted.",
          );
        }
        // Acceptance has transferred execution to the native collector; do not revoke it at hook exit.
        return {
          runId: accepted.runId,
          childSessionKey: accepted.childSessionKey,
          completionMode: "collect",
          selection: await readSelection(accepted.runId, accepted.childSessionKey, requested),
        };
      })();
      inFlightSpawns.set(replayKey, { fingerprint, result });
      try {
        return await result;
      } finally {
        inFlightSpawns.delete(replayKey);
      }
    },
    async collect(params) {
      const surface = await tools();
      const wait = surface.find((tool) => tool.name === "agents_wait");
      if (!wait) {
        throw new Error("agents_wait is not available to the current requester.");
      }
      const toolCallId = randomUUID();
      const result = await withCaller(() =>
        withNativeSubagentCollectorOwner(
          wait,
          toolCallId,
          {
            currentSessionKeys: new Set([source.options.sessionKey]),
            currentAgentId: source.options.agentId,
            config: source.options.config,
            expectedRequester: {
              sessionId: source.options.sessionId,
              lifecycleRevision: source.lifecycleRevision,
            },
            assertCurrent,
          },
          () =>
            wait.execute(
              toolCallId,
              {
                ids: params.ids,
                timeoutSeconds: params.timeoutSeconds,
                awaitResults: params.awaitResults,
              },
              source.options.abortSignal,
            ),
        ),
      );
      assertCurrent();
      const collection = readNativeSubagentCollection(result.details);
      let records: ReadonlyMap<string, SubagentRunRecord> = new Map();
      if (collection.completed.length > 0) {
        try {
          const prepared = await prepareSubagentRunsByRunIds(
            collection.completed.map((item) => item.runId),
          );
          assertCurrent();
          const read = prepared.consume((runs) => new Map(runs));
          if (read.ready) {
            records = read.value;
          }
        } catch {
          // Completion is authoritative even when optional metadata is unavailable.
        }
      }
      const completed = await Promise.all(
        collection.completed.map(async (completion) => ({
          ...completion,
          selection: await readSelection(completion.runId, completion.sessionKey, {}, records),
        })),
      );
      return { ...collection, completed };
    },
  };
}
