import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedRunAttemptResult } from "./pi-embedded-runner/run/types.js";

const runEmbeddedAttemptMock = vi.fn<Promise<EmbeddedRunAttemptResult>, [unknown]>();

vi.mock("./pi-embedded-runner/run/attempt.js", () => ({
  runEmbeddedAttempt: (params: unknown) => runEmbeddedAttemptMock(params),
}));

const resolveModelMock = vi.fn();

vi.mock("./pi-embedded-runner/model.js", () => ({
  resolveModel: (...args: unknown[]) => resolveModelMock(...args),
}));

const hookRunner = {
  hasHooks: (name: string) => name === "before_agent_start",
  runBeforeAgentStart: vi.fn(async () => ({
    providerOverride: "openai",
    modelOverride: "gpt-4o-mini",
  })),
};

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookRunner,
}));

let runEmbeddedPiAgent: typeof import("./pi-embedded-runner.js").runEmbeddedPiAgent;

beforeAll(async () => {
  ({ runEmbeddedPiAgent } = await import("./pi-embedded-runner.js"));
});

let prevOpenAiKey: string | undefined;

beforeEach(() => {
  runEmbeddedAttemptMock.mockReset();
  resolveModelMock.mockReset();
  hookRunner.runBeforeAgentStart.mockClear();

  // This test expects to get as far as model resolution; ensure auth lookup doesn't fail first.
  prevOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-openai-key";
});

afterEach(() => {
  if (prevOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = prevOpenAiKey;
});

describe("before_agent_start run-scoped model/provider override", () => {
  it("applies override before resolving model (fail-closed)", async () => {
    // resolveModel is called twice when override is present: probe + actual.
    resolveModelMock.mockImplementation((_provider: string, _modelId: string) => {
      return {
        model: {
          provider: "openai",
          api: "openai-responses",
          contextWindow: 128000,
          input: ["text"],
        },
        error: undefined,
        authStorage: {
          setRuntimeApiKey: vi.fn(),
        },
        modelRegistry: {},
      };
    });

    runEmbeddedAttemptMock.mockResolvedValue({
      aborted: false,
      timedOut: false,
      promptError: null,
      sessionIdUsed: "session:test",
      systemPromptReport: undefined,
      messagesSnapshot: [],
      assistantTexts: [],
      toolMetas: [],
      lastAssistant: undefined,
      didSendViaMessagingTool: false,
      messagingToolSentTexts: [],
      messagingToolSentTargets: [],
      cloudCodeAssistFormatError: false,
    });

    await runEmbeddedPiAgent({
      // required
      sessionId: "session:test",
      prompt: "hello",
      provider: "openai",
      model: "gpt-5.2",
      // minimal config/workspace
      config: {},
      workspaceDir: "./tmp/test-workspace",
      agentDir: "./tmp/test-agent",
      runId: "run:test",
      timeoutMs: 1000,
    } as unknown as Parameters<typeof runEmbeddedPiAgent>[0]);

    // Called once for probe + once for actual resolve
    expect(resolveModelMock).toHaveBeenCalled();
    const calls = resolveModelMock.mock.calls;
    const last = calls[calls.length - 1];
    expect(last[0]).toBe("openai");
    expect(last[1]).toBe("gpt-4o-mini");

    expect(hookRunner.runBeforeAgentStart).toHaveBeenCalledTimes(1);
  });
});
