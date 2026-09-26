import fs from "node:fs/promises";
import path from "node:path";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgentsApiAttempt } from "./agentsapi-attempt.js";
import type { AgentsApiBinding } from "./agentsapi-bindings.js";
import type { AgentsApiToolSurface } from "./agentsapi-tools.js";

const {
  fetchWithSsrFGuardMock,
  prepareAgentWorkspaceContextMock,
  watchedSessionsContextMock,
  promptFixture,
} = vi.hoisted(() => ({
  fetchWithSsrFGuardMock:
    vi.fn<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>(),
  prepareAgentWorkspaceContextMock:
    vi.fn<
      typeof import("openclaw/plugin-sdk/agent-harness-runtime").prepareAgentWorkspaceContext
    >(),
  watchedSessionsContextMock:
    vi.fn<
      typeof import("openclaw/plugin-sdk/agent-harness-runtime").buildWatchedSessionsHarnessContext
    >(),
  promptFixture: {
    declarations: [] as AgentsApiToolSurface["declarations"],
    turnInputs: [] as string[],
  },
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

// Keep workspace preparation and the SDK request real; unrelated turn projection,
// Gateway tool execution, and output transfers have their own boundary tests.
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async () => {
  const bootstrap = await vi.importActual<
    typeof import("openclaw/plugin-sdk/agent-harness-runtime")
  >("openclaw/plugin-sdk/agent-harness-runtime");
  prepareAgentWorkspaceContextMock.mockImplementation(bootstrap.prepareAgentWorkspaceContext);
  watchedSessionsContextMock.mockImplementation(bootstrap.buildWatchedSessionsHarnessContext);
  return {
    ...bootstrap,
    prepareAgentWorkspaceContext: prepareAgentWorkspaceContextMock,
    buildWatchedSessionsHarnessContext: watchedSessionsContextMock,
    embeddedAgentLog: { warn: vi.fn(), debug: vi.fn() },
    formatErrorMessage: String,
    setActiveEmbeddedRun: vi.fn(),
    clearActiveEmbeddedRun: vi.fn(),
    buildAgentHookContextChannelFields: () => ({}),
    buildEmbeddedForegroundPromptContext: () => ({}),
    runAgentHarnessLlmOutputHook: vi.fn(),
    awaitAgentEndSideEffects: vi.fn(),
    runAgentEndSideEffects: vi.fn(),
  };
});

vi.mock("openclaw/plugin-sdk/agent-sessions", () => ({
  SessionManager: { open: () => ({ buildSessionContext: () => ({ messages: [] }) }) },
}));

vi.mock("./agentsapi-tools.js", () => ({
  buildAgentsApiToolSurface: (): AgentsApiToolSurface => ({
    declarations: promptFixture.declarations,
    execute: vi.fn<AgentsApiToolSurface["execute"]>(),
    delivery: {
      didSendViaMessagingTool: false,
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      messagingToolSourceReplyPayloads: [],
      toolMediaUrls: [],
    },
    runtimeFacts: { acceptedSessionSpawns: [] },
    toolMetas: [],
    lastToolError: undefined,
  }),
}));

vi.mock("./agentsapi-files.js", async () => {
  const files =
    await vi.importActual<typeof import("./agentsapi-files.js")>("./agentsapi-files.js");
  return {
    ...files,
    collectOutputs: async () => ({ toolMediaUrls: [], hostOwnedToolMediaUrls: [] }),
  };
});

vi.mock("./agentsapi-messages.js", () => ({
  createAgentsApiMessageProjection: () => ({
    reply: {},
    recordUsage: vi.fn(),
    commit: vi.fn(),
    toolMetas: [],
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
  }),
}));

vi.mock("./agentsapi-session.js", () => ({
  createAgentsApiSession: () => ({
    run: async (input: string) => {
      promptFixture.turnInputs.push(input);
      return { turn: { id: "turn-fixture" }, cancelled: false };
    },
    readUsageTurns: async () => [],
    close: async () => {},
    wasSubmitted: () => true,
  }),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => fetchWithSsrFGuardMock.mockReset());
afterEach(() => prepareAgentWorkspaceContextMock.mockClear());
afterEach(() => watchedSessionsContextMock.mockClear());
afterEach(() => {
  promptFixture.declarations = [];
  promptFixture.turnInputs = [];
  vi.restoreAllMocks();
});

describe("Agents API agent workspace instructions", () => {
  it("sends the Gateway workspace snapshot once, preserves it on resume, and refreshes it for a new session", async () => {
    const fixture = await createFixture();
    const instructionsPath = path.join(fixture.workspace, "AGENTS.md");
    const original = "Follow the Gateway fixture operating rules.\n";
    await fs.writeFile(instructionsPath, original);
    const contextFiles = {
      "SOUL.md": "Use the fixture's calm, direct voice.",
      "IDENTITY.md": "Your fixture name is Orchard.",
      "USER.md": "The fixture human prefers concise replies.",
      "BOOTSTRAP.md": "Complete the fixture workspace introduction.",
      "MEMORY.md": "The fixture's durable project is Cedar.",
    };
    for (const [name, content] of Object.entries(contextFiles)) {
      await fs.writeFile(path.join(fixture.workspace, name), content);
    }
    expect(await fs.readdir(fixture.executionWorkspace)).toEqual([]);

    const binding = await fixture.run();
    const firstInstructions = fixture.requests[0]?.agent.instructions;
    expect(firstInstructions).toContain(`### ${instructionsPath}\n\n${original}`);
    expect(firstInstructions).toContain("Extra fixture instructions");
    expect(firstInstructions?.match(/Follow the Gateway fixture operating rules\./g)).toHaveLength(
      1,
    );
    for (const content of Object.values(contextFiles)) {
      expect(firstInstructions).toContain(content);
    }

    await fs.writeFile(instructionsPath, "Follow the updated Gateway fixture rules.\n");
    await fs.writeFile(path.join(fixture.workspace, "SOUL.md"), "Use the updated fixture voice.");
    // A resumed attempt needs only its binding, with no local instruction cache.
    const resumedBinding = structuredClone(binding);
    await fixture.run(resumedBinding);
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests[1]).toEqual({ agent: { reasoning: { effort: null } } });

    await fixture.run();
    expect(fixture.requests[2]?.agent.instructions).toContain(
      "Follow the updated Gateway fixture rules.",
    );
    expect(fixture.requests[2]?.agent.instructions).not.toContain(original.trim());
    expect(fixture.requests[2]?.agent.instructions).toContain("Use the updated fixture voice.");
  });

  it("forwards the selected personal profile and serializes its prepared persona", async () => {
    const fixture = await createFixture({ bootstrapUserProfileId: "alice" });
    // The shared owner tests authenticated selection and precedence. This seam
    // protects the adapter's profile forwarding and native instruction carrier.
    prepareAgentWorkspaceContextMock.mockResolvedValueOnce({
      ...emptyWorkspaceContext(),
      personaInstructions: "Prepared shared and personal fixture preferences.",
    });
    await fixture.run();
    expect(prepareAgentWorkspaceContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "full",
        workspaceDir: fixture.workspace,
        bootstrapUserProfileId: "alice",
      }),
    );
    expect(fixture.requests[0]?.agent.instructions).toContain(
      "Prepared shared and personal fixture preferences.",
    );
  });

  it("preserves channel memory privacy when preparing the full initial snapshot", async () => {
    const fixture = await createFixture({ chatType: "channel" });
    await fs.writeFile(path.join(fixture.workspace, "SOUL.md"), "Channel fixture persona.");
    await fs.writeFile(path.join(fixture.workspace, "MEMORY.md"), "Private fixture memory.");
    await fixture.run();
    expect(fixture.requests[0]?.agent.instructions).toContain("Channel fixture persona.");
    expect(fixture.requests[0]?.agent.instructions).not.toContain("Private fixture memory.");
  });

  it("routes workspace memory through callable Gateway memory tools and plugin guidance", async () => {
    const fixture = await createFixture();
    promptFixture.declarations = toolDeclarations("memory_search", "memory_get");
    const memoryPath = path.join(fixture.workspace, "MEMORY.md");
    prepareAgentWorkspaceContextMock.mockResolvedValueOnce({
      ...emptyWorkspaceContext(),
      memoryReferenceFiles: [
        { path: memoryPath, content: "Private fixture memory remains tool-routed." },
      ],
      memoryRecallInstructions:
        "Fixture memory plugin guidance: search durable memories when relevant.",
    });
    await fixture.run(undefined, {
      config: { agents: { defaults: { workspace: fixture.workspace } } },
    });
    const instructions = fixture.requests[0]?.agent.instructions;
    expect(prepareAgentWorkspaceContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryToolRouted: true,
        memoryTools: expect.objectContaining({ toolNames: ["memory_search", "memory_get"] }),
      }),
    );
    expect(instructions).toContain(memoryPath);
    expect(instructions).toContain("memory_search");
    expect(instructions).toContain("Fixture memory plugin guidance");
    expect(instructions).not.toContain("Private fixture memory remains tool-routed.");
  });

  it("includes shared policies for the admitted Gateway tools in the initial instructions", async () => {
    const fixture = await createFixture({
      sessionKey: "agent:main:main",
      gitCoauthorPrompt: "Fixture Git co-authors: Example <example@example.test>.",
    });
    promptFixture.declarations = toolDeclarations(
      "screen",
      "skill_workshop",
      "sessions_spawn",
      "sessions_send",
      "subagents",
      "gateway",
    );
    await fixture.run();
    const instructions = fixture.requests[0]?.agent.instructions;
    expect(instructions).toContain("## UI Presentation");
    expect(instructions).toContain("## Skill Workshop");
    expect(instructions).toContain("## Delegation");
    expect(instructions).toContain("Use or store credentials the user supplies as requested");
    expect(instructions).toContain("Fixture Git co-authors: Example <example@example.test>.");
    expect(instructions).toContain("Extra fixture instructions");
  });

  it("refreshes temporal, delivery, and watched-session context on resumed turns", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-25T12:00:00-07:00"));
    const fixture = await createFixture({
      sessionKey: "agent:main:main",
      config: { agents: { defaults: { userTimezone: "America/Los_Angeles" } } },
    });
    promptFixture.declarations = toolDeclarations("message", "sessions_history");
    watchedSessionsContextMock.mockReturnValueOnce("Watched fixture session: fixture-one");
    const binding = await fixture.run();
    expect(promptFixture.turnInputs[0]).toContain("Current date: 2026-09-25");
    expect(promptFixture.turnInputs[0]).toContain("Time zone: America/Los_Angeles");
    expect(promptFixture.turnInputs[0]).toContain(
      "OpenClaw delivers your final response automatically.",
    );
    expect(promptFixture.turnInputs[0]).toContain("Watched fixture session: fixture-one");
    expect(promptFixture.turnInputs[0]).toContain("Fixture prompt");

    now.mockReturnValue(Date.parse("2026-09-26T12:00:00-07:00"));
    watchedSessionsContextMock.mockReturnValueOnce("Watched fixture session: fixture-two");
    await fixture.run(binding, { sourceReplyDeliveryMode: "message_tool_only" });
    expect(promptFixture.turnInputs[1]).toContain("Current date: 2026-09-26");
    expect(promptFixture.turnInputs[1]).toContain("Use `message(action=send)`");
    expect(promptFixture.turnInputs[1]).toContain("Watched fixture session: fixture-two");
    expect(watchedSessionsContextMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        toolNames: new Set(["message", "sessions_history"]),
      }),
    );
    expect(fixture.requests[1]).toEqual({ agent: { reasoning: { effort: null } } });
  });

  it.each([undefined, " \n\t"])(
    "keeps an empty snapshot when AGENTS.md is missing or blank (%s)",
    async (content) => {
      const fixture = await createFixture();
      const instructionsPath = path.join(fixture.workspace, "AGENTS.md");
      if (content !== undefined) {
        await fs.writeFile(instructionsPath, content);
      }
      const binding = await fixture.run();
      const initialInstructions = fixture.requests[0]?.agent.instructions;
      expect(initialInstructions).toContain("Extra fixture instructions");
      expect(initialInstructions).not.toContain("OpenClaw Agent Workspace Instructions");
      await fs.writeFile(instructionsPath, "Rules added after session creation.");
      await fixture.run(binding);
      expect(fixture.requests[1]).toEqual({ agent: { reasoning: { effort: null } } });
      await fixture.run();
      expect(fixture.requests[2]?.agent.instructions).toContain(
        "Rules added after session creation.",
      );
    },
  );

  it.each([
    { bootstrapMaxChars: 300, bootstrapTotalMaxChars: 600, budget: 300 },
    { bootstrapMaxChars: 600, bootstrapTotalMaxChars: 300, budget: 300 },
  ])("applies the configured bootstrap limits (%j)", async ({ budget, ...limits }) => {
    const fixture = await createFixture({ config: { agents: { defaults: limits } } });
    await fs.writeFile(
      path.join(fixture.workspace, "AGENTS.md"),
      "Bounded fixture rules.\n".repeat(100),
    );
    await fixture.run();
    const instructions = fixture.requests[0]?.agent.instructions;
    expect(instructions).toContain("Bounded fixture rules.");
    expect(instructions).toContain("truncated");
    const retainedRules = instructions?.match(/Bounded fixture rules\./g) ?? [];
    expect(retainedRules.length * "Bounded fixture rules.".length).toBeLessThanOrEqual(budget);
  });

  it("keeps lightweight cron bootstrap context empty", async () => {
    const fixture = await createFixture({
      bootstrapContextMode: "lightweight",
      bootstrapContextRunKind: "cron",
    });
    await fs.writeFile(path.join(fixture.workspace, "AGENTS.md"), "Full bootstrap fixture rules.");
    await fixture.run();
    expect(fixture.requests[0]?.agent.instructions).not.toContain("Full bootstrap fixture rules.");
    expect(fixture.requests[0]?.agent.instructions).toContain("Extra fixture instructions");
    expect(promptFixture.turnInputs).toEqual(["Fixture prompt"]);
  });

  it("retries a failed first capture before creating or binding a native session", async () => {
    const fixture = await createFixture();
    await fs.writeFile(
      path.join(fixture.workspace, "AGENTS.md"),
      "Retryable Gateway fixture rules.",
    );
    const failure = new Error("Workspace access changed while preparing bootstrap context");
    prepareAgentWorkspaceContextMock.mockRejectedValueOnce(failure);
    await expect(fixture.run()).rejects.toBe(failure);
    expect(fixture.requests).toEqual([]);
    await fixture.run();
    expect(fixture.requests[0]?.agent.instructions).toContain("Retryable Gateway fixture rules.");
  });
});

type InstructionRequest = {
  agent: { instructions?: string; reasoning?: { effort: string | null } };
};

async function createFixture(overrides: Partial<AgentHarnessAttemptParamsV2> = {}) {
  const root = tempDirs.make("openclaw-agentsapi-instructions-");
  const workspace = path.join(root, "gateway-workspace");
  const executionWorkspace = path.join(root, "execution-workspace");
  await fs.mkdir(workspace);
  await fs.mkdir(executionWorkspace);
  const requests: InstructionRequest[] = [];
  fetchWithSsrFGuardMock.mockImplementation(async (request) => {
    request.beforeRequest?.();
    const pathname = new URL(request.url).pathname;
    let response: Response;
    if (request.init?.method === "POST") {
      requests.push(await new Request(request.url, request.init).json());
      response = Response.json({ id: "session-fixture" });
    } else if (pathname.endsWith("/items")) {
      response = Response.json({ data: [], has_more: false });
    } else {
      throw new Error(`Unexpected fixture request: ${request.init?.method} ${pathname}`);
    }
    return { response, finalUrl: request.url, release: async () => {} };
  });
  const target = {
    agentId: "main",
    sessionId: "local-fixture",
    sessionKey: overrides.sessionKey ?? `agent:main:${root}`,
    storePath: path.join(root, "agent.sqlite"),
  };
  const params: AgentHarnessAttemptParamsV2 = {
    ...target,
    sessionTarget: target,
    workspaceDir: executionWorkspace,
    bootstrapWorkspaceDir: workspace,
    agentDir: root,
    sessionFile: path.join(root, "transcript"),
    prompt: "Fixture prompt",
    extraSystemPrompt: "Extra fixture instructions",
    runId: "run-fixture",
    timeoutMs: 60_000,
    provider: "openai",
    modelId: "model-fixture",
    model: {
      id: "model-fixture",
      name: "Fixture Model",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1024,
      maxTokens: 512,
    },
    thinkLevel: "off",
    resolvedApiKey: "fixture-not-a-real-api-key",
    authProfileStore: { version: 1, profiles: {} },
    // Credentials and catalog are unused by the stubbed Gateway tool surface.
    authStorage: {} as AgentHarnessAttemptParamsV2["authStorage"],
    modelRegistry: {} as AgentHarnessAttemptParamsV2["modelRegistry"],
    hostCapabilities: {
      kind: "agent-harness-host-capability",
      version: 1,
      assertActive: () => {},
      bindToolSurface: (tools) => tools,
      runBeforeToolCall: async ({ params: toolParams }) => ({ blocked: false, params: toolParams }),
      requestApproval: async () => undefined,
      waitForApproval: async () => undefined,
    },
    ...overrides,
  };
  return {
    workspace,
    executionWorkspace,
    requests,
    async run(
      binding?: AgentsApiBinding,
      turnOverrides: Partial<AgentHarnessAttemptParamsV2> = {},
    ) {
      let saved = binding;
      const result = await runAgentsApiAttempt(
        { ...params, ...turnOverrides },
        binding,
        async (next) => {
          saved = next;
        },
        () => {},
        () => {},
        target,
      );
      if (result.terminal.kind === "failed") {
        throw result.terminal.error;
      }
      expect(result.terminal).toEqual({ kind: "ok" });
      if (!saved) {
        throw new Error("Expected a saved native binding");
      }
      return saved;
    },
  };
}

function toolDeclarations(...names: string[]): AgentsApiToolSurface["declarations"] {
  return names.map((name) => ({
    type: "function",
    name,
    description: `Fixture ${name} tool`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
  }));
}

function emptyWorkspaceContext(): Awaited<ReturnType<typeof prepareAgentWorkspaceContextMock>> {
  return {
    bootstrapFiles: [],
    contextFiles: [],
    instructionSnapshot: { files: [], instructions: "" },
    personaFiles: [],
    promptContextFiles: [],
    memoryReferenceFiles: [],
    memoryToolRoutedBootstrapFiles: [],
  };
}
