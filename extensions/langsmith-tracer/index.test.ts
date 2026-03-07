/**
 * Tests for the LangSmith tracer extension.
 *
 * Unit tests use a fake RunNode factory injected via the _runNodeFactory
 * constructor option — no real LangSmith account or module mocking needed.
 *
 * Live tests (describeLive block) require LANGSMITH_API_KEY + OPENCLAW_LIVE_TEST=1.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── fake RunNode ──────────────────────────────────────────────────────────────

type FakeRun = {
  name: string;
  run_type: string;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  error?: string;
  children: FakeRun[];
  postRun: ReturnType<typeof vi.fn>;
  patchRun: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  createChild: ReturnType<typeof vi.fn>;
};

function makeFakeRun(cfg: Record<string, unknown> = {}): FakeRun {
  const children: FakeRun[] = [];
  const run: FakeRun = {
    name: (cfg["name"] as string) ?? "fake-run",
    run_type: (cfg["run_type"] as string) ?? "chain",
    inputs: (cfg["inputs"] as Record<string, unknown>) ?? {},
    children,
    postRun: vi.fn().mockResolvedValue(undefined),
    patchRun: vi.fn().mockResolvedValue(undefined),
    end: vi.fn().mockImplementation(async (outputs?: Record<string, unknown>, error?: string) => {
      run.outputs = outputs;
      run.error = error;
    }),
    createChild: vi.fn().mockImplementation((childCfg: Record<string, unknown>) => {
      const child = makeFakeRun(childCfg);
      children.push(child);
      return child;
    }),
  };
  return run;
}

// ── LangSmithTracer unit tests ────────────────────────────────────────────────

describe("LangSmithTracer", () => {
  let LangSmithTracer: typeof import("./src/tracer.js").LangSmithTracer;
  const mockLogger = { warn: vi.fn(), info: vi.fn() };
  const mockClient = {} as import("langsmith").Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ LangSmithTracer } = await import("./src/tracer.js"));
  });

  function makeTracer(rootRun: FakeRun) {
    return new LangSmithTracer({
      client: mockClient,
      projectName: "test",
      logger: mockLogger,
      _runNodeFactory: () => rootRun,
    });
  }

  // ── test 3: happy path ─────────────────────────────────────────────────────
  it("happy path: full single-turn sequence creates correct run hierarchy", async () => {
    const rootRun = makeFakeRun({ name: "openclaw-agent", run_type: "chain" });
    const tracer = makeTracer(rootRun);
    const sessionId = "sess-1";

    // before_agent_start → root run posted
    await tracer.onAgentStart(sessionId, { prompt: "hello" });
    expect(rootRun.postRun).toHaveBeenCalledTimes(1);
    expect(tracer.activeSessionCount).toBe(1);

    // llm_input → child llm run created under root
    await tracer.onLlmInput(sessionId, {
      runId: "run-1",
      sessionId,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      prompt: "hello",
      historyMessages: [],
      imagesCount: 0,
    });
    expect(rootRun.createChild).toHaveBeenCalledTimes(1);
    const llmRun = rootRun.children[0];
    expect(llmRun).toBeDefined();
    expect(llmRun.postRun).toHaveBeenCalledTimes(1);
    expect(llmRun.run_type).toBe("llm");

    // before_tool_call → grandchild tool run under llm run
    await tracer.onBeforeToolCall(sessionId, { toolName: "bash", params: { cmd: "ls" } });
    expect(llmRun.createChild).toHaveBeenCalledTimes(1);
    const toolRun = llmRun.children[0];
    expect(toolRun).toBeDefined();
    expect(toolRun.postRun).toHaveBeenCalledTimes(1);
    expect(toolRun.run_type).toBe("tool");

    // after_tool_call → tool run closed with result
    await tracer.onAfterToolCall(sessionId, {
      toolName: "bash",
      params: { cmd: "ls" },
      result: "file.ts",
    });
    expect(toolRun.end).toHaveBeenCalledWith({ output: "file.ts" }, undefined);
    expect(toolRun.patchRun).toHaveBeenCalledTimes(1);

    // llm_output → llm run closed with texts + usage
    await tracer.onLlmOutput(sessionId, {
      runId: "run-1",
      sessionId,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      assistantTexts: ["done"],
      usage: { input: 100, output: 20 },
    });
    expect(llmRun.end).toHaveBeenCalledWith(expect.objectContaining({ generations: ["done"] }));
    expect(llmRun.patchRun).toHaveBeenCalledTimes(1);

    // agent_end → root run closed, session removed
    await tracer.onAgentEnd(sessionId, { messages: [], success: true });
    expect(rootRun.end).toHaveBeenCalledWith({ success: true }, undefined);
    expect(rootRun.patchRun).toHaveBeenCalledTimes(1);
    expect(tracer.activeSessionCount).toBe(0);
  });

  // ── test 4: multi-turn ────────────────────────────────────────────────────
  it("multi-turn: two LLM calls create two child runs under the root", async () => {
    const rootRun = makeFakeRun({ name: "openclaw-agent", run_type: "chain" });
    const tracer = makeTracer(rootRun);
    const sessionId = "sess-multi";

    await tracer.onAgentStart(sessionId, { prompt: "multi" });

    // Turn 1
    await tracer.onLlmInput(sessionId, {
      runId: "r1",
      sessionId,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      prompt: "multi",
      historyMessages: [],
      imagesCount: 0,
    });
    await tracer.onLlmOutput(sessionId, {
      runId: "r1",
      sessionId,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      assistantTexts: ["turn1"],
    });

    // Turn 2
    await tracer.onLlmInput(sessionId, {
      runId: "r2",
      sessionId,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      prompt: "multi",
      historyMessages: [],
      imagesCount: 0,
    });
    await tracer.onLlmOutput(sessionId, {
      runId: "r2",
      sessionId,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      assistantTexts: ["turn2"],
    });

    await tracer.onAgentEnd(sessionId, { messages: [], success: true });

    // Two separate child LLM runs created under the root
    expect(rootRun.createChild).toHaveBeenCalledTimes(2);
    expect(rootRun.children).toHaveLength(2);
    expect(tracer.activeSessionCount).toBe(0);
  });

  // ── test 5: error resilience ──────────────────────────────────────────────
  it("error in postRun is caught and logged — does not throw", async () => {
    const rootRun = makeFakeRun();
    rootRun.postRun.mockRejectedValue(new Error("network error"));
    const tracer = makeTracer(rootRun);

    await expect(tracer.onAgentStart("sess-err", { prompt: "fail" })).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("onAgentStart failed"));
  });

  // ── test 5b: unknown session is a no-op ──────────────────────────────────
  it("hooks for unknown sessionId are silently ignored", async () => {
    const rootRun = makeFakeRun();
    const tracer = makeTracer(rootRun);

    // Never called onAgentStart — session does not exist
    await tracer.onLlmInput("ghost-session", {
      runId: "r",
      sessionId: "ghost-session",
      provider: "x",
      model: "y",
      prompt: "z",
      historyMessages: [],
      imagesCount: 0,
    });
    expect(rootRun.createChild).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  // ── test: after_tool_call with no matching start ───────────────────────────
  it("after_tool_call with no pending tool run is a no-op", async () => {
    const rootRun = makeFakeRun();
    const tracer = makeTracer(rootRun);

    await tracer.onAgentStart("sess-notool", { prompt: "p" });
    await tracer.onAfterToolCall("sess-notool", {
      toolName: "bash",
      params: {},
      result: "out",
    });
    // No tool was started, so nothing should be patched
    expect(rootRun.patchRun).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  // ── test: failed agent run sets error on root run ────────────────────────
  it("agent_end with success=false sets error on root run", async () => {
    const rootRun = makeFakeRun();
    const tracer = makeTracer(rootRun);

    await tracer.onAgentStart("sess-fail", { prompt: "p" });
    await tracer.onAgentEnd("sess-fail", {
      messages: [],
      success: false,
      error: "timeout",
    });
    expect(rootRun.end).toHaveBeenCalledWith(undefined, "timeout");
    expect(tracer.activeSessionCount).toBe(0);
  });
});

// ── config unit tests ─────────────────────────────────────────────────────────

describe("config", () => {
  // Save and restore env around each test.
  let savedApiKey: string | undefined;
  let savedProject: string | undefined;
  let savedEndpoint: string | undefined;

  beforeEach(() => {
    savedApiKey = process.env["LANGSMITH_API_KEY"];
    savedProject = process.env["LANGSMITH_PROJECT"];
    savedEndpoint = process.env["LANGSMITH_ENDPOINT"];
    delete process.env["LANGSMITH_API_KEY"];
    delete process.env["LANGSMITH_PROJECT"];
    delete process.env["LANGSMITH_ENDPOINT"];
  });

  afterEach(() => {
    if (savedApiKey !== undefined) process.env["LANGSMITH_API_KEY"] = savedApiKey;
    else delete process.env["LANGSMITH_API_KEY"];
    if (savedProject !== undefined) process.env["LANGSMITH_PROJECT"] = savedProject;
    else delete process.env["LANGSMITH_PROJECT"];
    if (savedEndpoint !== undefined) process.env["LANGSMITH_ENDPOINT"] = savedEndpoint;
    else delete process.env["LANGSMITH_ENDPOINT"];
  });

  // ── test 6a ───────────────────────────────────────────────────────────────
  it("isEnabled returns false when LANGSMITH_API_KEY is absent", async () => {
    const { isEnabled } = await import("./src/config.js");
    expect(isEnabled()).toBe(false);
  });

  it("isEnabled returns true when LANGSMITH_API_KEY is set", async () => {
    process.env["LANGSMITH_API_KEY"] = "ls__test";
    const { isEnabled } = await import("./src/config.js");
    expect(isEnabled()).toBe(true);
  });

  it("isEnabled returns true when apiKey is in pluginConfig", async () => {
    const { isEnabled } = await import("./src/config.js");
    expect(isEnabled({ apiKey: "ls__fromconfig" })).toBe(true);
  });

  // ── test 6b ───────────────────────────────────────────────────────────────
  it("resolveConfig uses defaults when env vars are absent", async () => {
    const { resolveConfig } = await import("./src/config.js");
    const cfg = resolveConfig();
    expect(cfg.project).toBe("openclaw-agent-runs");
    expect(cfg.endpoint).toBe("https://api.smith.langchain.com");
    expect(cfg.apiKey).toBe("");
  });

  it("resolveConfig respects LANGSMITH_PROJECT env var", async () => {
    process.env["LANGSMITH_PROJECT"] = "my-project";
    const { resolveConfig } = await import("./src/config.js");
    const cfg = resolveConfig();
    expect(cfg.project).toBe("my-project");
  });

  it("resolveConfig prefers env var over pluginConfig", async () => {
    process.env["LANGSMITH_PROJECT"] = "from-env";
    const { resolveConfig } = await import("./src/config.js");
    const cfg = resolveConfig({ project: "from-config" });
    expect(cfg.project).toBe("from-env");
  });
});

// ── plugin registration tests ─────────────────────────────────────────────────

describe("plugin registration", () => {
  let savedApiKey: string | undefined;

  beforeEach(() => {
    savedApiKey = process.env["LANGSMITH_API_KEY"];
    delete process.env["LANGSMITH_API_KEY"];
  });

  afterEach(() => {
    if (savedApiKey !== undefined) process.env["LANGSMITH_API_KEY"] = savedApiKey;
    else delete process.env["LANGSMITH_API_KEY"];
  });

  function makeMockApi(pluginConfig?: Record<string, unknown>) {
    return {
      pluginConfig,
      logger: { info: vi.fn(), warn: vi.fn() },
      on: vi.fn(),
    };
  }

  // ── test 1: no-op without API key ─────────────────────────────────────────
  it("does not register hooks when LANGSMITH_API_KEY is absent", async () => {
    const { default: plugin } = await import("./index.js");
    const api = makeMockApi();
    plugin.register(api as unknown as import("openclaw/plugin-sdk").OpenClawPluginApi);
    expect(api.on).not.toHaveBeenCalled();
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("disabled"));
  });
});

// ── live test (test 7) ────────────────────────────────────────────────────────

const liveEnabled =
  Boolean(process.env["LANGSMITH_API_KEY"]) && process.env["OPENCLAW_LIVE_TEST"] === "1";
const describeLive = liveEnabled ? describe : describe.skip;

describeLive("live: full round-trip to LangSmith", () => {
  it("agent turn produces a readable trace in LangSmith", async () => {
    const { buildClient, resolveConfig } = await import("./src/config.js");
    const { LangSmithTracer } = await import("./src/tracer.js");

    const cfg = resolveConfig();
    const client = buildClient(cfg);
    const tracer = new LangSmithTracer({
      client,
      projectName: cfg.project,
      logger: { warn: console.warn, info: console.info },
    });

    const sessionId = `live-test-${Date.now()}`;

    await tracer.onAgentStart(sessionId, { prompt: "live test prompt" });
    await tracer.onLlmInput(sessionId, {
      runId: sessionId,
      sessionId,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      prompt: "live test prompt",
      historyMessages: [{ role: "user", content: "live test prompt" }],
      imagesCount: 0,
    });
    await tracer.onBeforeToolCall(sessionId, {
      toolName: "bash",
      params: { command: "echo hello" },
    });
    await tracer.onAfterToolCall(sessionId, {
      toolName: "bash",
      params: { command: "echo hello" },
      result: "hello\n",
      durationMs: 42,
    });
    await tracer.onLlmOutput(sessionId, {
      runId: sessionId,
      sessionId,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      assistantTexts: ["The command output was: hello"],
      usage: { input: 50, output: 10, total: 60 },
    });
    await tracer.onAgentEnd(sessionId, { messages: [], success: true, durationMs: 500 });

    expect(tracer.activeSessionCount).toBe(0);
    console.info(`Live test done — check project "${cfg.project}" in LangSmith`);
  });
});
