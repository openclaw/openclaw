import { createHash, randomUUID } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { getRuntimeConfig } from "../config/io.runtime.js";
import type { OpenClawConfig } from "../config/types.js";
import { capturePluginLifecycleAuthority } from "../plugins/registry-lifecycle.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type {
  NativeSubagentAccepted,
  NativeSubagentRuntime,
  NativeSubagentSelection,
} from "../plugins/runtime/types-native-subagent.js";
import type { PluginCommandScheduledTurns } from "../plugins/runtime/types-scheduled-turns.js";
import { normalizeAcceptedSessionSpawnResult } from "./accepted-session-spawn.js";
import type { AdmittedRunContext } from "./admitted-run-context.js";
import { runWithToolExecutionValidation } from "./agent-tools.execution-validation.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import type { NativeSubagentRequestSource } from "./plugin-native-subagent.types.js";
import { preparePluginCommandScheduledTurns } from "./plugin-scheduled-command.js";
import { matchesSubagentRequesterSession } from "./subagents/registry/subagent-registry-queries.js";
import {
  getSwarmRunByLaunchReplayKey,
  initSubagentRegistry,
  listCollectorRunsForRequesterIncarnation,
  prepareSubagentRunsByRunIds,
  type SubagentRunRecord,
} from "./subagents/registry/subagent-registry.js";
import { loadSubagentSessionEntry } from "./subagents/registry/subagent-session-reconciliation.js";
import {
  SWARM_CODE_MODE_IDEMPOTENCY_KEY,
  SWARM_CODE_MODE_REQUEST_FINGERPRINT,
} from "./subagents/swarm/swarm-code-mode.js";
import {
  runWithJoinedCollectorSpawn,
  bindJoinedCollectorInvocation,
  isCallableCollectorReader,
} from "./subagents/swarm/swarm-collector-capability.js";
import {
  readNativeSubagentCollection,
  withNativeSubagentCollectorOwner,
} from "./tools/agents-wait-tool.js";
import { AUTOMATIONS_TOOL_NAME } from "./tools/automations-tool-name.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";

/** Resolve only in the admitted request's registry; no global or cross-plugin fallback. */
function captureNativeSubagentProfile(pluginId: string, id: string) {
  const registry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const record = registry?.plugins.find((entry) => entry.id === pluginId);
  const profile = registry?.subagentProfiles.find(
    (entry) => entry.pluginId === pluginId && entry.id === id,
  );
  if (!registry || !record?.contracts?.subagentProfiles?.includes(id) || !profile) {
    throw new Error(`Unknown or undeclared subagent profile for this plugin: ${id}`);
  }
  const isCurrent = capturePluginLifecycleAuthority(registry, record, { scopedRuntime: true });
  const assertCurrent = () => {
    if (!isCurrent?.()) {
      throw new Error("Subagent profile plugin is no longer active.");
    }
  };
  assertCurrent();
  return { profile, assertCurrent };
}

/** Adapt the existing authorized native tool surface; do not create a second spawn owner. */
export function createRequestNativeSubagentRuntime(
  source: NativeSubagentRequestSource,
  guard: { pluginId: string; assertCurrent: () => void },
): NativeSubagentRuntime & {
  prepareCommand: () => Promise<boolean>;
  prepareScheduledTurns: (channel: string) => Promise<PluginCommandScheduledTurns | undefined>;
} {
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
  const tools = async (currentConfig?: OpenClawConfig) => {
    assertCurrent();
    const prepare = () =>
      withCaller(async () => {
        const { createOpenClawCodingToolsInternalAsync } = await import("./agent-tools.js");
        assertCurrent();
        if (
          currentConfig &&
          source.options.conversationCapabilityProfile &&
          !source.prepareCurrentCapabilityProfile
        ) {
          throw new Error("Current native subagent policy preparation is unavailable.");
        }
        const currentProfile =
          currentConfig && source.prepareCurrentCapabilityProfile
            ? await source.prepareCurrentCapabilityProfile(currentConfig)
            : undefined;
        assertCurrent();
        return createOpenClawCodingToolsInternalAsync(
          {
            ...source.options,
            ...(currentConfig
              ? { config: currentConfig, conversationCapabilityProfile: currentProfile }
              : {}),
            pluginExecutionAuthority: source.operatorAuthority,
            assertInvocationCurrent: assertCurrent,
          },
          undefined,
          undefined,
          undefined,
          { assertCurrent },
        );
      });
    const result = await (currentConfig ? prepare() : (preparedTools ??= prepare()));
    assertCurrent();
    return result;
  };
  return {
    async prepareScheduledTurns(channel) {
      const surface = await tools();
      if (!admitted || !surface.some((tool) => tool.name === AUTOMATIONS_TOOL_NAME)) {
        return undefined;
      }
      return preparePluginCommandScheduledTurns({
        source,
        pluginId: guard.pluginId,
        channel,
        assertCurrent,
        tools,
        withCaller,
      });
    },
    async prepareCommand() {
      const surface = await tools();
      if (
        !surface.some((tool) => tool.name === "sessions_spawn") ||
        !isCallableCollectorReader(surface.find((tool) => tool.name === "agents_wait"))
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
      const capturedProfile =
        params.profile !== undefined
          ? captureNativeSubagentProfile(guard.pluginId, params.profile)
          : undefined;
      const profile = capturedProfile?.profile;
      const assertSpawnCurrent = () => {
        assertCurrent();
        capturedProfile?.assertCurrent();
      };
      if (profile?.outputSchema && params.outputSchema !== undefined) {
        throw new Error("A subagent profile outputSchema cannot be replaced by spawn arguments.");
      }
      const surface = await tools();
      assertSpawnCurrent();
      const spawn = surface.find((tool) => tool.name === "sessions_spawn");
      if (!spawn) {
        throw new Error("sessions_spawn is not available to the current requester.");
      }
      // The provenance join must not grant collector access absent from the native surface.
      if (!isCallableCollectorReader(surface.find((tool) => tool.name === "agents_wait"))) {
        throw new Error("agents_wait is not available to the current requester.");
      }
      admitted = await (preparedAdmission ??= source.prepareSpawn(assertSpawnCurrent));
      assertSpawnCurrent();
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
        outputSchema: profile?.outputSchema ?? params.outputSchema,
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
      const fingerprint = createHash("sha256")
        .update(stableStringify(profile ? { ...args, profile } : args))
        .digest("hex");
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
        assertSpawnCurrent();
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
            assertSpawnCurrent();
            existing =
              (await getSwarmRunByLaunchReplayKey(
                replayKey,
                source.options.sessionKey,
                source.options.agentId,
              )) ?? existing;
            assertSpawnCurrent();
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
          runWithJoinedCollectorSpawn(
            spawn,
            assertSpawnCurrent,
            async () => {
              bindJoinedCollectorInvocation(spawn, toolCallId);
              return runWithToolExecutionValidation(
                toolCallId,
                (finalParams) => {
                  assertSpawnCurrent();
                  const final = asOptionalRecord(finalParams);
                  // Hooks may rewrite the task, but not the native collector's completion contract.
                  if (
                    !final ||
                    final.runtime !== "subagent" ||
                    final.mode !== "run" ||
                    final.collect !== true ||
                    (profile?.outputSchema !== undefined &&
                      stableStringify(final.outputSchema) !==
                        stableStringify(profile.outputSchema)) ||
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
              );
            },
            {
              version: 1,
              pluginId: guard.pluginId,
              requesterProfileId: source.operatorAuthority.profileId,
              requestId: params.requestId,
            },
            profile,
          ),
        );
        assertSpawnCurrent();
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
    async list(params) {
      // Listing does not execute agents_wait, so prepare the current native policy
      // rather than trusting the invocation's cached tool surface.
      assertCurrent();
      if (
        params?.status !== undefined &&
        ![
          "queued",
          "running",
          "interrupted",
          "terminal",
          "done",
          "failed",
          "killed",
          "timeout",
        ].includes(params.status)
      ) {
        throw new Error("Unknown native subagent status.");
      }
      const config = getRuntimeConfig();
      const assertPolicyCurrent = () => {
        assertCurrent();
        if (getRuntimeConfig() !== config) {
          throw new Error("Native subagent tool policy changed; retry the listing.");
        }
      };
      const surface = await tools(config);
      assertPolicyCurrent();
      if (!isCallableCollectorReader(surface.find((tool) => tool.name === "agents_wait"))) {
        throw new Error("agents_wait is not available to the current requester.");
      }
      const records = await listCollectorRunsForRequesterIncarnation({
        sessionKey: source.options.sessionKey,
        agentId: source.options.agentId,
        sessionId: source.options.sessionId,
        lifecycleRevision: source.lifecycleRevision,
      });
      assertPolicyCurrent();
      return records
        .toSorted((a, b) => {
          const aId = a.swarmRunId ?? a.runId;
          const bId = b.swarmRunId ?? b.runId;
          return b.createdAt - a.createdAt || (aId < bId ? -1 : aId > bId ? 1 : 0);
        })
        .flatMap((entry) => {
          const owner = entry.nativePluginOwner;
          if (
            entry.collect !== true ||
            owner?.version !== 1 ||
            owner.pluginId !== guard.pluginId ||
            owner.requesterProfileId !== source.operatorAuthority.profileId ||
            typeof owner.requestId !== "string" ||
            owner.requestId.trim().length === 0
          ) {
            return [];
          }
          return [
            {
              runId: entry.swarmRunId ?? entry.runId,
              childSessionKey: entry.childSessionKey,
              requestId: owner.requestId,
              ...(entry.label !== undefined ? { label: entry.label } : {}),
              status: entry.collectorCompletion?.status ?? entry.execution.status,
            },
          ];
        })
        .filter((entry) => params?.status === undefined || entry.status === params.status)
        .slice(0, 200);
    },
    async collect(params) {
      const surface = await tools();
      const wait = surface.find((tool) => tool.name === "agents_wait");
      if (!wait || !isCallableCollectorReader(wait)) {
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
