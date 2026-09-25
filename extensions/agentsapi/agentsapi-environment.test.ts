import { createHash } from "node:crypto";
import path from "node:path";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentsApiAttempt } from "./agentsapi-attempt.js";
import type { AgentsApiBinding } from "./agentsapi-bindings.js";
import type { AgentsApiFunctionDeclaration } from "./agentsapi-client.js";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>(),
  commit: vi.fn(async () => {}),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: mocks.fetch }));
vi.mock("openclaw/plugin-sdk/agent-harness-attempt-runtime", () => ({
  buildCurrentInboundPrompt: ({ prompt }: { prompt: string }) => prompt,
  createAgentHarnessAttemptCancellation: () => {
    const controller = new AbortController();
    return {
      controller,
      abortExplicitly: (error: Error) => controller.abort(error),
      freezeTerminalOutcome: vi.fn(),
      dispose: vi.fn(),
    };
  },
  createAgentHarnessAttemptDeadlineController: () => ({
    beginSettlement: vi.fn(),
    dispose: vi.fn(),
  }),
  createAgentHarnessAttemptLifecycle: () => ({
    emitLifecycleStart: vi.fn(),
    emitLifecycleTerminal: vi.fn(),
  }),
  emitAgentHarnessAttemptEvent: vi.fn(),
  selectSupportedReasoningEffort: vi.fn(),
  AgentHarnessProjectionSettlement: class {
    constructor(readonly params: AgentHarnessAttemptParamsV2) {}
    async drain() {}
  },
  racePromiseWithAbortSignal: (promise: Promise<unknown>) => promise,
}));
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  agentHarnessAttemptTerminal: { normalize: () => ({ kind: "ok" }) },
  awaitAgentEndSideEffects: vi.fn(async () => {}),
  buildAgentHookContextChannelFields: () => ({}),
  buildEmbeddedForegroundPromptContext: () => ({}),
  clearActiveEmbeddedRun: vi.fn(),
  embeddedAgentLog: { warn: vi.fn() },
  formatErrorMessage: (error: unknown) => String(error),
  resolveAgentDir: () => "/fixture/agent",
  runAgentEndSideEffects: vi.fn(),
  runAgentHarnessLlmOutputHook: vi.fn(),
  sanitizeToolArgs: (args: unknown) => args,
  setActiveEmbeddedRun: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/agent-sessions", () => ({
  AuthStorage: { inMemory: () => ({}) },
  ModelRegistry: { inMemory: () => ({}) },
  SessionManager: { open: () => ({ buildSessionContext: () => ({ messages: [] }) }) },
}));
vi.mock("openclaw/plugin-sdk/llm", () => ({
  resolveOpenAIModelReasoningEfforts: vi.fn(),
  resolveOpenAIReasoningEffortMap: vi.fn(),
  resolveOpenAIReasoningEffortMapping: vi.fn(),
}));
vi.mock("./agentsapi-tools.js", () => ({
  buildAgentsApiToolSurface: () => ({ declarations: [], toolMetas: [], delivery: {} }),
}));
vi.mock("./agentsapi-transcript.js", () => ({ recordAgentsApiNativeToolTranscript: vi.fn() }));
vi.mock("./agentsapi-messages.js", () => ({
  createAgentsApiMessageProjection: () => ({
    reply: {},
    toolMetas: [],
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    recordUsage: vi.fn(),
    commit: mocks.commit,
  }),
}));
vi.mock("./agentsapi-session.js", () => ({
  createAgentsApiSession: (
    options: Parameters<typeof import("./agentsapi-session.js").createAgentsApiSession>[0],
  ) => ({
    async run(prompt: string, persistInput: () => Promise<void>, onSubmitted: () => void) {
      await persistInput();
      await options.client.message(options.sessionId, prompt, options.signal);
      onSubmitted();
      return { turn: { id: "turn-fixture", status: "completed" }, cancelled: false };
    },
    readUsageTurns: async () => [],
    close: async () => {},
    wasSubmitted: () => true,
  }),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
  mocks.fetch.mockImplementation(async ({ url }) => {
    const pathname = new URL(url).pathname;
    const response = pathname.endsWith("/items")
      ? Response.json({ data: [], has_more: false })
      : Response.json({ id: "session-fixture" });
    return { response, finalUrl: url, release: async () => {} };
  });
});
afterEach(() => {
  mocks.fetch.mockReset();
  mocks.commit.mockClear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Agents API attempt environment selection", () => {
  it.each([undefined, "openai_hosted", "self_hosted"])(
    "uses configured environment %s in the SDK session-create request",
    async (environment) => {
      const workspaceDir = "fixture-workspace/../fixture-project";
      const { result, bind } = await attempt(environment, undefined, workspaceDir);

      expect(result).toMatchObject({ terminal: { kind: "ok" } });
      expect(mocks.fetch.mock.calls[0]?.[0].init?.method).toBe("POST");
      const createRequest = await requestBody(0);
      expect(createRequest).toMatchObject({
        environment:
          environment === "self_hosted"
            ? { type: "self_hosted", workspace_directory: path.resolve(workspaceDir) }
            : { type: "openai_hosted" },
        agent: { model: "fixture-model", tools: [{ type: "web_search", mode: "live" }] },
      });
      expect(bind).toHaveBeenCalledOnce();
      expect(bind.mock.calls[0]?.[0].sessionId).toBe("session-fixture");
      expect(mocks.commit).toHaveBeenCalledWith(
        expect.objectContaining({ id: "turn-fixture" }),
        [],
      );
    },
  );

  it.each([undefined, "openai_hosted", "self_hosted"])(
    "continues a compatible %s binding without creating or rewriting its remote identity",
    async (environment) => {
      const binding = savedBinding(environment);
      const { result, bind } = await attempt(
        environment,
        binding,
        environment === "self_hosted" ? "/fixture/sibling/../project" : undefined,
      );

      expect(result).toMatchObject({ terminal: { kind: "ok" } });
      expect(
        mocks.fetch.mock.calls.map(([request]) => ({
          method: new Request(request.url, request.init).method,
          pathname: new URL(request.url).pathname,
        })),
      ).toEqual([
        { method: "POST", pathname: "/v1/agents/sessions/session-fixture" },
        { method: "POST", pathname: "/v1/agents/sessions/session-fixture/events" },
        { method: "GET", pathname: "/v1/agents/sessions/session-fixture/items" },
      ]);
      expect(bind).not.toHaveBeenCalled();
      expect(await requestBody(1)).toMatchObject({
        events: [{ type: "agent.session.input.message" }],
      });
    },
  );

  it.each([
    { name: "hosted to self-hosted", previous: undefined, next: "self_hosted" },
    {
      name: "legacy hosted to self-hosted",
      previous: undefined,
      next: "self_hosted",
      legacy: true,
    },
    { name: "self-hosted to hosted", previous: "self_hosted", next: "openai_hosted" },
    {
      name: "self-hosted workspace change",
      previous: "self_hosted",
      next: "self_hosted",
      workspaceDir: "/fixture/other-project",
    },
  ])(
    "requires reset for $name before native writes",
    async ({ previous, next, workspaceDir, legacy }) => {
      const { result, bind } = await attempt(
        next,
        savedBinding(previous, legacy ? [] : undefined),
        workspaceDir,
      );

      expect(result).toMatchObject({
        terminal: {
          kind: "failed",
          error: expect.objectContaining({
            message: expect.stringContaining("reset the OpenClaw session"),
          }),
        },
      });
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(bind).not.toHaveBeenCalled();
    },
  );

  it("adopts a hosted legacy tool fingerprint without changing the remote session", async () => {
    const binding = savedBinding(undefined, []);
    const { result, bind } = await attempt("openai_hosted", binding);

    expect(result).toMatchObject({ terminal: { kind: "ok" } });
    expect(bind).toHaveBeenCalledWith(savedBinding(undefined));
    expect(
      new Request(mocks.fetch.mock.calls[0]![0].url, mocks.fetch.mock.calls[0]![0].init).method,
    ).toBe("POST");
    expect(new URL(mocks.fetch.mock.calls[0]![0].url).pathname).toBe(
      "/v1/agents/sessions/session-fixture",
    );
  });

  it("rejects an invalid runtime environment setting before native writes", async () => {
    const { result, bind } = await attempt("hosted");

    expect(result).toMatchObject({
      terminal: {
        kind: "failed",
        error: expect.objectContaining({ message: expect.stringContaining("environment") }),
      },
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
  });
});

async function attempt(
  environment: string | undefined,
  binding?: AgentsApiBinding,
  workspaceDir = "/fixture/project",
) {
  // Authentication/tool construction are host-prepared and mocked at their boundaries.
  const authStorage = AuthStorage.inMemory();
  const params: AgentHarnessAttemptParamsV2 = {
    sessionId: "local-fixture",
    sessionKey: "agent:main:fixture",
    sessionFile: "/fixture/session.jsonl",
    agentId: "main",
    workspaceDir,
    runId: "run-fixture",
    timeoutMs: 1_000,
    prompt: "Fixture prompt",
    provider: "openai",
    modelId: "fixture-model",
    model: {
      id: "fixture-model",
      name: "Fixture Model",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1024,
      maxTokens: 512,
    },
    authStorage,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: ModelRegistry.inMemory(authStorage),
    thinkLevel: "off",
    resolvedApiKey: "fixture-not-a-real-api-key",
    // Per-run plugin overrides do not own live plugin settings.
    config: {
      plugins: { entries: { agentsapi: { config: { environment: "invalid-run-override" } } } },
    },
    hostCapabilities: {
      kind: "agent-harness-host-capability",
      version: 1,
      assertActive: vi.fn(),
      reportOutputTokens: vi.fn(),
      bindToolSurface: (tools) => tools,
      runBeforeToolCall: async ({ params: toolParams }) => ({
        blocked: false,
        params: toolParams,
      }),
      requestApproval: async () => undefined,
      waitForApproval: async () => undefined,
    },
  };
  const bind = vi.fn<(next: AgentsApiBinding) => Promise<void>>(async () => {});
  const result = await runAgentsApiAttempt(
    params,
    binding,
    bind,
    vi.fn(),
    vi.fn(),
    {
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey!,
      storePath: "/fixture/sessions.json",
    },
    () => (environment === undefined ? undefined : { environment }),
  );
  return { result, bind };
}

function savedBinding(
  environment: string | undefined,
  legacyTools?: AgentsApiFunctionDeclaration[],
) {
  const identity: unknown[] = ["fixture-model", "fixture-not-a-real-api-key"];
  if (environment === "self_hosted") {
    identity.push({ type: "self_hosted", workspace_directory: "/fixture/project" });
  }
  if (legacyTools) {
    identity.push(legacyTools);
  }
  return {
    sessionId: "session-fixture",
    authFingerprint: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
  };
}

async function requestBody(index: number): Promise<unknown> {
  const request = mocks.fetch.mock.calls[index]?.[0];
  if (!request) {
    throw new Error("Expected a fixture SDK request");
  }
  return new Request(request.url, request.init).json();
}
