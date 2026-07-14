import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "../../llm/types.js";
import { AuthStorage } from "./auth-storage.js";
import { createExtensionRuntime } from "./extensions/loader.js";
import type { LoadExtensionsResult } from "./extensions/types.js";
import { ModelRegistry } from "./model-registry.js";
import type { ResourceLoader } from "./resource-loader.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { createSyntheticSourceInfo } from "./source-info.js";

const smallModel: Model = {
  id: "small-context",
  name: "Small Context",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16000,
  maxTokens: 4000,
};

function resourceLoaderWith(
  handlers: Map<string, Array<(...args: unknown[]) => Promise<unknown>>>,
): ResourceLoader {
  const extensionsResult: LoadExtensionsResult = {
    extensions:
      handlers.size > 0
        ? [
            {
              path: "<test-extension>",
              resolvedPath: "<test-extension>",
              sourceInfo: createSyntheticSourceInfo("<test-extension>", { source: "temporary" }),
              handlers,
              tools: new Map(),
              messageRenderers: new Map(),
              commands: new Map(),
              flags: new Map(),
              shortcuts: new Map(),
            },
          ]
        : [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  return {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function keepAllSessionManager(): SessionManager {
  const sessionManager = SessionManager.inMemory();
  sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "hi there" }],
    timestamp: Date.now(),
  } as Parameters<SessionManager["appendMessage"]>[0]);
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "hello, how can I help?" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: smallModel.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as Parameters<SessionManager["appendMessage"]>[0]);
  return sessionManager;
}

async function buildSession(params: {
  sessionManager: SessionManager;
  resourceLoader: ResourceLoader;
}): Promise<{
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  calls: () => number;
}> {
  const { session } = await createAgentSession({
    model: smallModel,
    resourceLoader: params.resourceLoader,
    sessionManager: params.sessionManager,
    settingsManager: SettingsManager.inMemory(),
    modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
  });

  let summarizationCalls = 0;
  session.agent.streamFn = ((_model: Model, _context: Context, _options?: SimpleStreamOptions) => {
    summarizationCalls += 1;
    const summaryMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "SUMMARY-OF-NOTHING" }],
      api: smallModel.api,
      provider: smallModel.provider,
      model: smallModel.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message: summaryMessage });
    stream.end();
    return stream;
  }) as typeof session.agent.streamFn;

  return { session, calls: () => summarizationCalls };
}

function runCompaction(session: unknown, settings: unknown) {
  return (
    session as {
      runCompactionWork: (options: {
        settings: unknown;
        signal: AbortSignal;
        mode: "manual" | "auto";
      }) => Promise<{ status: string }>;
    }
  ).runCompactionWork({ settings, signal: new AbortController().signal, mode: "auto" });
}

describe("runCompactionWork with nothing to summarize", () => {
  it("skips the no-op compaction when no session_before_compact handler is registered", async () => {
    const sessionManager = keepAllSessionManager();
    const { session, calls } = await buildSession({
      sessionManager,
      resourceLoader: resourceLoaderWith(new Map()),
    });
    const settings = SettingsManager.inMemory().getCompactionSettings();

    const outcome = await runCompaction(session, settings);

    expect(outcome.status).toBe("skipped");
    expect(calls()).toBe(0);
    expect(sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
  });

  it("still delivers the empty preparation to a registered session_before_compact handler", async () => {
    let deliveredMessages = -1;
    let deliveredTurnPrefix = -1;
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      [
        "session_before_compact",
        [
          async (event: unknown) => {
            const typed = event as {
              preparation: {
                messagesToSummarize: unknown[];
                turnPrefixMessages: unknown[];
                firstKeptEntryId: string;
                tokensBefore: number;
              };
            };
            deliveredMessages = typed.preparation.messagesToSummarize.length;
            deliveredTurnPrefix = typed.preparation.turnPrefixMessages.length;
            return {
              compaction: {
                summary: "from-handler",
                firstKeptEntryId: typed.preparation.firstKeptEntryId,
                tokensBefore: typed.preparation.tokensBefore,
              },
            };
          },
        ],
      ],
    ]);
    const sessionManager = keepAllSessionManager();
    const { session, calls } = await buildSession({
      sessionManager,
      resourceLoader: resourceLoaderWith(handlers),
    });
    const settings = SettingsManager.inMemory().getCompactionSettings();

    const outcome = await runCompaction(session, settings);

    expect(deliveredMessages).toBe(0);
    expect(deliveredTurnPrefix).toBe(0);
    expect(outcome.status).toBe("compacted");
    expect(calls()).toBe(0);
    expect(sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
  });
});
