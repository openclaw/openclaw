import { join } from "node:path";
import { vi, type Mock } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngineRuntimeContext } from "../../context-engine/types.js";
import {
  createAssistant,
  createAssistantResultStream,
  type testModel,
} from "../sessions/agent-session-loop-correctness.test-support.js";
import type { ProviderConfigInput } from "../sessions/model-registry.js";
import type { loadCompactHooksHarness } from "./compact.hooks.harness.js";

type FixtureDependencies = {
  workspaceDir: string;
  sessions: typeof import("../sessions/index.js");
  accessor: typeof import("../../config/sessions/session-accessor.js");
  model: typeof testModel & { contextWindow: number };
  summary: string;
  resolveModelMock: typeof import("./compact.hooks.harness.js").resolveModelMock;
  streamResolution: typeof import("./stream-resolution.js");
  applyExtraParamsToAgentMock: typeof import("./compact.hooks.harness.js").applyExtraParamsToAgentMock;
  requestPreparedCompaction: Mock<
    typeof import("@openclaw/ai/transports").requestPreparedOpenAIResponsesCompaction
  >;
  replay: typeof import("../openai-transport-stream.test-support.js").testing;
  configRuntime: typeof import("../../config/runtime-snapshot.js");
  accounting: typeof import("./run/compaction-accounting-bridge.js");
};
export type DelegateFixtureOptions = {
  archivedTurns?: number;
  previousSummary?: string;
  liveOutputChars?: number;
  projectedCustomHistory?: boolean;
  retainedCacheMetadata?: boolean;
};

export async function createDelegateCompactionFixture(
  dependencies: FixtureDependencies,
  operation: "summary" | "endpoint",
  globalAlias = false,
  options: DelegateFixtureOptions = {},
) {
  const {
    workspaceDir,
    sessions,
    accessor,
    model,
    summary,
    resolveModelMock,
    streamResolution,
    applyExtraParamsToAgentMock,
    requestPreparedCompaction,
    replay,
    configRuntime,
    accounting,
  } = dependencies;
  const target = {
    agentId: globalAlias ? "marketing" : "main",
    sessionId: "compaction-session",
    sessionKey: globalAlias ? "global" : "agent:main:compaction-session",
    storePath: join(workspaceDir, "alternate", "openclaw-agent.sqlite"),
  };
  const configuredStore = join(workspaceDir, "configured", "openclaw-agent.sqlite");
  await accessor.upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  // The same physical id in another store must not redirect partial-target resolution.
  const decoy = { ...target, storePath: configuredStore };
  await accessor.upsertSessionEntryCore(decoy, { sessionId: target.sessionId, updatedAt: 1 });
  const decoyManager = sessions.SessionManager.open(decoy, workspaceDir);
  decoyManager.appendMessage({ role: "user", content: "Unrelated store history", timestamp: 1 });
  decoyManager.flushPendingPersistence();
  const sessionManager = sessions.SessionManager.open(target, workspaceDir);
  await sessionManager.appendModelChange(model.provider, model.id);
  await sessionManager.appendThinkingLevelChange("off");
  // A long-lived session keeps its id across resets, so the archive behind the
  // latest reset stays in the same transcript and must not be hydrated to compact.
  for (let index = 0; index < (options.archivedTurns ?? 0); index += 1) {
    await sessionManager.appendMessageAsync({
      role: "user",
      content: `Archived request ${index}`,
      timestamp: 1,
    });
    await sessionManager.appendMessageAsync(
      createAssistant(model, [{ type: "text", text: `Archived output ${index} `.repeat(6_000) }]),
    );
  }
  if (options.archivedTurns) {
    await sessionManager.appendResetBoundaryAsync("new");
  }
  if (options.previousSummary) {
    await sessionManager.appendMessageAsync({
      role: "user",
      content: "Earlier request",
      timestamp: 1,
    });
    const firstKeptEntryId = sessionManager.getEntries().at(-1)!.id;
    await sessionManager.appendCompactionAsync(options.previousSummary, firstKeptEntryId, 100);
  }
  for (const content of [
    "Review the deployment checklist.",
    "Compare the remaining options.",
    "Keep the rollout notes.",
  ]) {
    sessionManager.appendMessage({ role: "user", content, timestamp: 1 });
    if (options.projectedCustomHistory) {
      await sessionManager.appendCustomMessageEntryAsync(
        "fixture-progress",
        "A visible contextual finding: " + content,
        true,
      );
    }
    if (options.retainedCacheMetadata && content === "Keep the rollout notes.") {
      await sessionManager.appendCustomEntryAsync("openclaw.cache-ttl", {
        prunedToolResults: [],
        ambiguousToolResultBaseKeys: [],
        frozenToolResults: [
          {
            key: "fixture:result:1",
            sourceHash: "fixture-source",
            texts: ["projection context ".repeat(12_000)],
          },
        ],
      });
    }
    const repeat = Math.max(1, Math.ceil((options.liveOutputChars ?? 0) / (content.length + 11)));
    sessionManager.appendMessage(
      createAssistant(model, [{ type: "text", text: `Recorded: ${content} `.repeat(repeat) }]),
    );
  }
  sessionManager.flushPendingPersistence();
  const originalMessages = sessionManager.buildSessionContext().messages;
  const originalEntries = sessionManager.getEntries();
  const stream = vi.fn<NonNullable<ProviderConfigInput["streamSimple"]>>((activeModel) =>
    createAssistantResultStream(createAssistant(activeModel, [{ type: "text", text: summary }])),
  );
  const authStorage = sessions.AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(model.provider, "test-api-key");
  const modelRegistry = sessions.ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider(model.provider, { api: model.api, streamSimple: stream });
  resolveModelMock.mockImplementation((provider = model.provider, modelId = model.id) => ({
    logicalRef: { provider, model: modelId },
    model,
    error: null,
    authStorage,
    modelRegistry,
  }));
  vi.mocked(streamResolution.resolveEmbeddedAgentStream).mockReturnValue({
    streamFn: stream,
    strategy: "session-custom",
  });
  applyExtraParamsToAgentMock.mockReturnValue({
    effectiveExtraParams: { responsesCompactEndpoint: operation === "endpoint" },
  });
  requestPreparedCompaction.mockResolvedValue({
    item: { type: "compaction", id: "cmp_fixture", encrypted_content: "opaque-fixture" },
    output: [{ type: "compaction", id: "cmp_fixture", encrypted_content: "opaque-fixture" }],
    historyMode: "compacted-prefix",
    usage: { input_tokens: 1_000, output_tokens: 200 },
    model,
    replayMetadata: replay.buildOpenAIResponsesReasoningReplayMetadata(model, {
      sessionId: target.sessionId,
    }),
  });
  const runtimeContext = {
    workspaceDir,
    provider: model.provider,
    model: model.id,
    trigger: "manual",
    thinkLevel: "off",
    config: {
      session: { store: configuredStore },
      agents: {
        ownership: "explicit",
        entries: { main: {}, marketing: {} },
        defaults: { compaction: { mode: "default", keepRecentTokens: 1, postIndexSync: "off" } },
      },
    },
  } satisfies ContextEngineRuntimeContext & { config: OpenClawConfig };
  configRuntime.setRuntimeConfigSnapshot(runtimeContext.config);
  const recordUsage = vi.fn();
  const recordCompaction = vi.fn();
  accounting.attachCompactionAccountingRecorder(runtimeContext, { recordUsage, recordCompaction });
  return {
    queuedParams: {
      ...target,
      sessionTarget: target,
      sessionFile: target.sessionKey,
      workspaceDir,
      config: runtimeContext.config,
      provider: model.provider,
      model: model.id,
      agentHarnessId: "openclaw",
      trigger: "manual",
      enqueue: async (task) => await task(),
    } satisfies Parameters<
      Awaited<ReturnType<typeof loadCompactHooksHarness>>["compactEmbeddedAgentSession"]
    >[0],
    delegateParams: {
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      sessionTarget: target,
      runtimeContext,
    },
    target,
    decoy,
    originalEntries,
    originalMessages,
    runtimeContext,
    stream,
    recordUsage,
    recordCompaction,
  };
}
