import fs from "node:fs/promises";
import path from "node:path";
import "./test-helpers/fast-coding-tools.js";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedRunAttemptResult } from "./pi-embedded-runner/run/types.js";
import {
  cleanupEmbeddedPiRunnerTestWorkspace,
  createEmbeddedPiRunnerOpenAiConfig,
  createEmbeddedPiRunnerTestWorkspace,
  type EmbeddedPiRunnerTestWorkspace,
  immediateEnqueue,
} from "./test-helpers/pi-embedded-runner-e2e-fixtures.js";

const runEmbeddedAttemptMock = vi.fn<(params: unknown) => Promise<EmbeddedRunAttemptResult>>();

function createMockUsage(input: number, output: number) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();

  const buildAssistantMessage = (model: { api: string; provider: string; id: string }) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "ok" }],
    stopReason: "stop" as const,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createMockUsage(1, 1),
    timestamp: Date.now(),
  });

  const buildAssistantErrorMessage = (model: { api: string; provider: string; id: string }) => ({
    role: "assistant" as const,
    content: [],
    stopReason: "error" as const,
    errorMessage: "boom",
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createMockUsage(0, 0),
    timestamp: Date.now(),
  });

  return {
    ...actual,
    complete: async (model: { api: string; provider: string; id: string }) => {
      if (model.id === "mock-error") {
        return buildAssistantErrorMessage(model);
      }
      return buildAssistantMessage(model);
    },
    completeSimple: async (model: { api: string; provider: string; id: string }) => {
      if (model.id === "mock-error") {
        return buildAssistantErrorMessage(model);
      }
      return buildAssistantMessage(model);
    },
    streamSimple: (model: { api: string; provider: string; id: string }) => {
      const stream = actual.createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message:
            model.id === "mock-error"
              ? buildAssistantErrorMessage(model)
              : buildAssistantMessage(model),
        });
        stream.end();
      });
      return stream;
    },
  };
});

const installRunEmbeddedMocks = () => {
  vi.doMock("../plugins/hook-runner-global.js", () => ({
    getGlobalHookRunner: vi.fn(() => undefined),
    getGlobalPluginRegistry: vi.fn(() => null),
    hasGlobalHooks: vi.fn(() => false),
    initializeGlobalHookRunner: vi.fn(),
    resetGlobalHookRunner: vi.fn(),
  }));
  vi.doMock("../context-engine/index.js", () => ({
    ensureContextEnginesInitialized: vi.fn(),
    resolveContextEngine: vi.fn(async () => ({
      dispose: async () => undefined,
    })),
  }));
  vi.doMock("./runtime-plugins.js", () => ({
    ensureRuntimePluginsLoaded: vi.fn(),
  }));
  vi.doMock("./pi-embedded-runner/run/attempt.js", () => ({
    runEmbeddedAttempt: (params: unknown) => runEmbeddedAttemptMock(params),
  }));
  vi.doMock("./pi-embedded-runner/model.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./pi-embedded-runner/model.js")>();
    return {
      ...actual,
      resolveModelAsync: async (provider: string, modelId: string) => ({
        model: {
          id: modelId,
          name: modelId,
          api: "openai-responses",
          provider,
          baseUrl: `https://example.com/${provider}`,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 16_000,
          maxTokens: 2048,
        },
        error: undefined,
        authStorage: {
          setRuntimeApiKey: vi.fn(),
        },
        modelRegistry: {},
      }),
    };
  });
  vi.doMock("../plugins/provider-runtime.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../plugins/provider-runtime.js")>();
    return {
      ...actual,
      prepareProviderRuntimeAuth: vi.fn(async () => undefined),
    };
  });
  vi.doMock("./models-config.js", async (importOriginal) => {
    const mod = await importOriginal<typeof import("./models-config.js")>();
    return {
      ...mod,
      ensureOpenClawModelsJson: vi.fn(async () => ({ wrote: false })),
    };
  });
};

let runEmbeddedPiAgent: typeof import("./pi-embedded-runner/run.js").runEmbeddedPiAgent;
let SessionManager: typeof import("@mariozechner/pi-coding-agent").SessionManager;
let e2eWorkspace: EmbeddedPiRunnerTestWorkspace | undefined;
let agentDir: string;
let workspaceDir: string;
let sessionCounter = 0;
let runCounter = 0;

beforeAll(async () => {
  vi.useRealTimers();
  vi.resetModules();
  installRunEmbeddedMocks();
  ({ runEmbeddedPiAgent } = await import("./pi-embedded-runner/run.js"));
  ({ SessionManager } = await import("@mariozechner/pi-coding-agent"));
  e2eWorkspace = await createEmbeddedPiRunnerTestWorkspace("openclaw-embedded-agent-");
  ({ agentDir, workspaceDir } = e2eWorkspace);
}, 180_000);

afterAll(async () => {
  await cleanupEmbeddedPiRunnerTestWorkspace(e2eWorkspace);
  e2eWorkspace = undefined;
});

beforeEach(() => {
  vi.useRealTimers();
  runEmbeddedAttemptMock.mockReset();
  runEmbeddedAttemptMock.mockImplementation(async () => {
    throw new Error("unexpected extra runEmbeddedAttempt call");
  });
});

const nextSessionFile = () => {
  sessionCounter += 1;
  return path.join(workspaceDir, `session-${sessionCounter}.jsonl`);
};
const nextRunId = (prefix = "run-embedded-test") => `${prefix}-${++runCounter}`;
const nextSessionKey = () => `agent:test:embedded:${nextRunId("session-key")}`;

const baseUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const buildAssistant = (overrides: Partial<AssistantMessage>): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "openai-responses",
  provider: "openai",
  model: "mock-1",
  usage: baseUsage,
  stopReason: "stop",
  timestamp: Date.now(),
  ...overrides,
});

const makeAttempt = (overrides: Partial<EmbeddedRunAttemptResult>): EmbeddedRunAttemptResult => ({
  aborted: false,
  timedOut: false,
  timedOutDuringCompaction: false,
  promptError: null,
  sessionIdUsed: "session:test",
  systemPromptReport: undefined,
  messagesSnapshot: [],
  assistantTexts: [],
  toolMetas: [],
  lastAssistant: undefined,
  didSendViaMessagingTool: false,
  messagingToolSentTexts: [],
  messagingToolSentMediaUrls: [],
  messagingToolSentTargets: [],
  cloudCodeAssistFormatError: false,
  ...overrides,
});

const runWithOrphanedSingleUserMessage = async (text: string, sessionKey: string) => {
  const sessionFile = nextSessionFile();
  const sessionManager = SessionManager.open(sessionFile);
  sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  });

  runEmbeddedAttemptMock.mockResolvedValueOnce(
    makeAttempt({
      assistantTexts: ["ok"],
      lastAssistant: buildAssistant({
        content: [{ type: "text", text: "ok" }],
      }),
    }),
  );

  const cfg = createEmbeddedPiRunnerOpenAiConfig(["mock-1"]);
  return await runEmbeddedPiAgent({
    sessionId: "session:test",
    sessionKey,
    sessionFile,
    workspaceDir,
    config: cfg,
    prompt: "hello",
    provider: "openai",
    model: "mock-1",
    timeoutMs: 5_000,
    agentDir,
    runId: nextRunId("orphaned-user"),
    enqueue: immediateEnqueue,
  });
};

const textFromContent = (content: unknown) => {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content) && content[0]?.type === "text") {
    return (content[0] as { text?: string }).text;
  }
  return undefined;
};

const readSessionEntries = async (sessionFile: string) => {
  const raw = await fs.readFile(sessionFile, "utf-8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; customType?: string; data?: unknown });
};

const readSessionMessages = async (sessionFile: string) => {
  const entries = await readSessionEntries(sessionFile);
  return entries
    .filter((entry) => entry.type === "message")
    .map(
      (entry) => (entry as { message?: { role?: string; content?: unknown } }).message,
    ) as Array<{ role?: string; content?: unknown }>;
};

const runDefaultEmbeddedTurn = async (sessionFile: string, prompt: string, sessionKey: string) => {
  const cfg = createEmbeddedPiRunnerOpenAiConfig(["mock-error"]);
  runEmbeddedAttemptMock.mockResolvedValueOnce(
    makeAttempt({
      assistantTexts: ["ok"],
      lastAssistant: buildAssistant({
        content: [{ type: "text", text: "ok" }],
      }),
    }),
  );
  await runEmbeddedPiAgent({
    sessionId: "session:test",
    sessionKey,
    sessionFile,
    workspaceDir,
    config: cfg,
    prompt,
    provider: "openai",
    model: "mock-error",
    timeoutMs: 5_000,
    agentDir,
    runId: nextRunId("default-turn"),
    enqueue: immediateEnqueue,
  });
};

describe("runEmbeddedPiAgent", () => {
  it("handles prompt error paths without dropping user state", async () => {
    const sessionFile = nextSessionFile();
    const cfg = createEmbeddedPiRunnerOpenAiConfig(["mock-error"]);
    const sessionKey = nextSessionKey();
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeAttempt({
        promptError: new Error("boom"),
      }),
    );
    await expect(
      runEmbeddedPiAgent({
        sessionId: "session:test",
        sessionKey,
        sessionFile,
        workspaceDir,
        config: cfg,
        prompt: "boom",
        provider: "openai",
        model: "mock-error",
        timeoutMs: 5_000,
        agentDir,
        runId: nextRunId("prompt-error"),
        enqueue: immediateEnqueue,
      }),
    ).rejects.toThrow("boom");

    try {
      const messages = await readSessionMessages(sessionFile);
      const userIndex = messages.findIndex(
        (message) => message?.role === "user" && textFromContent(message.content) === "boom",
      );
      expect(userIndex).toBeGreaterThanOrEqual(0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        throw err;
      }
    }
  });

  it(
    "preserves existing transcript entries across an additional turn",
    { timeout: 7_000 },
    async () => {
      const sessionFile = nextSessionFile();
      const sessionKey = nextSessionKey();

      const sessionManager = SessionManager.open(sessionFile);
      sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "seed user" }],
        timestamp: Date.now(),
      });
      sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "seed assistant" }],
        stopReason: "stop",
        api: "openai-responses",
        provider: "openai",
        model: "mock-1",
        usage: createMockUsage(1, 1),
        timestamp: Date.now(),
      });

      await runDefaultEmbeddedTurn(sessionFile, "hello", sessionKey);

      const messages = await readSessionMessages(sessionFile);
      const seedUserIndex = messages.findIndex(
        (message) => message?.role === "user" && textFromContent(message.content) === "seed user",
      );
      const seedAssistantIndex = messages.findIndex(
        (message) =>
          message?.role === "assistant" && textFromContent(message.content) === "seed assistant",
      );
      expect(seedUserIndex).toBeGreaterThanOrEqual(0);
      expect(seedAssistantIndex).toBeGreaterThan(seedUserIndex);
      expect(messages.length).toBeGreaterThanOrEqual(2);
    },
  );

  it("repairs orphaned user messages and continues", async () => {
    const result = await runWithOrphanedSingleUserMessage("orphaned user", nextSessionKey());

    expect(result.meta.error).toBeUndefined();
    expect(result.payloads?.length ?? 0).toBeGreaterThan(0);
  });
});
