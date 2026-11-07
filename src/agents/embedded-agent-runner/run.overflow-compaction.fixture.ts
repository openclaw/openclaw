/**
 * Test fixtures for embedded-run overflow compaction scenarios.
 */
import { vi } from "vitest";
import type { ContextEngineSessionTarget } from "../../context-engine/types.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { normalizeAgentRunAttemptTerminal } from "../agent-run-terminal-outcome.js";
import type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimeLeaseOptions,
} from "../prepared-model-runtime.types.js";
import type { AgentRuntimePlan } from "../runtime-plan/types.js";
import { isAgentToolReplaySafe } from "../tool-replay-safety.js";
import type { EmbeddedRunAttemptWithReceiptEvidence } from "./run/attempt-result.js";
import { buildAttemptReplayMetadata } from "./run/attempt-terminal-evidence.js";

const emptyPluginMetadataSnapshot = createPluginMetadataSnapshotFixture();

export async function acquireOverflowCompactionPreparedModelRuntime(
  input: PreparedModelRuntimeInput,
  options?: PreparedModelRuntimeLeaseOptions,
) {
  const admitted = options?.pluginGeneration;
  const pluginRegistry = admitted ? admitted.pluginRegistry : getActivePluginRegistry();
  const metadataSnapshot = admitted
    ? admitted.pluginMetadataSnapshot
    : { ...emptyPluginMetadataSnapshot, workspaceDir: input.workspaceDir };
  const snapshot = {
    agentId: input.agentId,
    agentDir: input.agentDir,
    config: input.config,
    workspaceDir: input.workspaceDir,
    pluginRegistry: pluginRegistry
      ? { ...pluginRegistry, agentHarnesses: [...pluginRegistry.agentHarnesses] }
      : undefined,
    metadataSnapshot,
    createStores: () => ({ authStorage: {}, modelRegistry: {} }),
  };
  return {
    snapshot,
    pluginGeneration: admitted ?? {
      remoteCatalog: null,
      pluginMetadataSnapshot: metadataSnapshot,
      pluginRegistry: snapshot.pluginRegistry,
      configuredCatalogEntries: [],
      inlineProviderModels: [],
    },
    run: <T>(run: () => T): T => run(),
    [Symbol.asyncDispose]: vi.fn(async () => {}),
  };
}

const DEFAULT_OVERFLOW_ERROR_MESSAGE =
  "request_too_large: Request size exceeds model context window";

export function makeOverflowError(message: string = DEFAULT_OVERFLOW_ERROR_MESSAGE): Error {
  return new Error(message);
}

type MockRuntimePlan = Pick<AgentRuntimePlan, "auth"> & {
  transport: Pick<AgentRuntimePlan["transport"], "resolveExtraParams">;
  observability: Pick<AgentRuntimePlan["observability"], "harnessId">;
};

export function makeMockRuntimePlan(): MockRuntimePlan {
  return {
    auth: {
      authProfileProviderForAuth: "openai",
      providerForAuth: "openai",
    },
    observability: {
      harnessId: "codex",
    },
    transport: {
      resolveExtraParams: () => ({}),
    },
  };
}

export function makeCompactionSuccess(params: {
  summary: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  sessionId?: string;
  sessionFile?: string;
  sessionTarget?: ContextEngineSessionTarget;
}) {
  return {
    ok: true as const,
    compacted: true as const,
    result: {
      summary: params.summary,
      ...(params.firstKeptEntryId ? { firstKeptEntryId: params.firstKeptEntryId } : {}),
      ...(params.tokensBefore !== undefined ? { tokensBefore: params.tokensBefore } : {}),
      ...(params.tokensAfter !== undefined ? { tokensAfter: params.tokensAfter } : {}),
      ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
      ...(params.sessionFile !== undefined ? { sessionFile: params.sessionFile } : {}),
      ...(params.sessionTarget !== undefined ? { sessionTarget: params.sessionTarget } : {}),
    },
  };
}

type AttemptResultOverrides = Partial<EmbeddedRunAttemptWithReceiptEvidence> &
  Parameters<typeof normalizeAgentRunAttemptTerminal>[0];

function resolveFixtureTerminal(overrides: AttemptResultOverrides) {
  return overrides.terminal ?? normalizeAgentRunAttemptTerminal(overrides);
}

export function makeAttemptResult(
  overrides: AttemptResultOverrides = {},
): EmbeddedRunAttemptWithReceiptEvidence {
  const toolMetas = (overrides.toolMetas ?? []).map((entry) =>
    Object.assign({}, entry, {
      replaySafe: entry.replaySafe ?? isAgentToolReplaySafe({ name: entry.toolName }),
    }),
  );
  const didSendViaMessagingTool = overrides.didSendViaMessagingTool ?? false;
  const messagingToolSentTexts = overrides.messagingToolSentTexts ?? [];
  const messagingToolSentMediaUrls = overrides.messagingToolSentMediaUrls ?? [];
  const messagingToolSentTargets = overrides.messagingToolSentTargets ?? [];
  const successfulCronAdds = overrides.successfulCronAdds;
  const acceptedSessionSpawns = overrides.acceptedSessionSpawns ?? [];
  const {
    aborted: _aborted,
    externalAbort: _externalAbort,
    idleTimedOut: _idleTimedOut,
    promptError: _promptError,
    promptErrorSource: _promptErrorSource,
    timedOut: _timedOut,
    timedOutByRunBudget: _timedOutByRunBudget,
    timedOutDuringCompaction: _timedOutDuringCompaction,
    timedOutDuringToolExecution: _timedOutDuringToolExecution,
    ...canonicalOverrides
  } = overrides;
  return {
    terminal: resolveFixtureTerminal(overrides),
    sessionIdUsed: "test-session",
    assistantTexts: ["Hello!"],
    acceptedSessionSpawns,
    lastAssistant: undefined,
    currentAttemptCompletedAssistant:
      overrides.currentAttemptCompletedAssistant ?? overrides.currentAttemptAssistant,
    messagesSnapshot: [],
    replayMetadata:
      overrides.replayMetadata ??
      buildAttemptReplayMetadata({
        toolMetas,
        didSendViaMessagingTool,
        messagingToolSentTexts,
        messagingToolSentMediaUrls,
        messagingToolSentTargets,
        acceptedSessionSpawns,
        successfulCronAdds,
      }),
    itemLifecycle: {
      startedCount: 0,
      completedCount: 0,
      activeCount: 0,
    },
    didSendViaMessagingTool,
    messagingToolSentTexts,
    messagingToolSentMediaUrls,
    messagingToolSentTargets,
    cloudCodeAssistFormatError: false,
    ...canonicalOverrides,
    toolMetas,
  };
}
