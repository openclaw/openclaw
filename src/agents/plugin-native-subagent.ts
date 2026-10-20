import { createHash, randomUUID } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type {
  NativeSubagentAccepted,
  NativeSubagentRuntime,
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
} from "./subagents/registry/subagent-registry.js";
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
): NativeSubagentRuntime {
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
        const accepted = await inFlight.result;
        assertCurrent();
        return accepted;
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
        };
      })();
      inFlightSpawns.set(replayKey, { fingerprint, result });
      try {
        const accepted = await result;
        assertCurrent();
        return accepted;
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
      return readNativeSubagentCollection(result.details);
    },
  };
}
