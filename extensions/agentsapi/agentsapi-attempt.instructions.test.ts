import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-registration";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { prepareAgentWorkspaceAttachments } from "openclaw/plugin-sdk/agent-workspace-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import {
  loadUserTurnTranscriptRecorderFactoryForTest,
  createMockPluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentsApiAttempt } from "./agentsapi-attempt.js";
import {
  createAttemptParams,
  createWorkspaceAttachmentFixture,
} from "./agentsapi-attempt.test-helpers.js";
import type { AgentsApiBinding } from "./agentsapi-bindings.js";
import type { AgentsApiInputFile } from "./agentsapi-client.js";
import type { AgentsApiToolSurface } from "./agentsapi-tools.js";
import { createModel } from "./agentsapi.test-support.js";

type HarnessRuntime = typeof import("openclaw/plugin-sdk/agent-harness-runtime");
const {
  fetchWithSsrFGuardMock,
  prepareAgentWorkspaceContextMock,
  watchedSessionsContextMock,
  openModelContextAsyncMock,
  promptFixture,
  resolvePromptMock,
  fileMocks,
} = vi.hoisted(() => ({
  fetchWithSsrFGuardMock:
    vi.fn<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>(),
  prepareAgentWorkspaceContextMock: vi.fn<HarnessRuntime["prepareAgentWorkspaceContext"]>(),
  watchedSessionsContextMock: vi.fn<HarnessRuntime["prepareWatchedSessionsHarnessContext"]>(),
  openModelContextAsyncMock: vi.fn(async () => ({
    buildSessionContext: () => ({ messages: [{ role: "user", content: "Earlier request" }] }),
  })),
  resolvePromptMock: vi.fn<HarnessRuntime["resolveAgentHarnessBeforePromptBuildResult"]>(),
  fileMocks: {
    prepareInputs: vi.fn<typeof import("./agentsapi-files.js").prepareInputs>(),
    uploadInputs: vi.fn<typeof import("./agentsapi-files.js").uploadInputs>(),
    collectOutputs: vi.fn<typeof import("./agentsapi-files.js").collectOutputs>(),
  },
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
  watchedSessionsContextMock.mockImplementation(bootstrap.prepareWatchedSessionsHarnessContext);
  resolvePromptMock.mockImplementation(bootstrap.resolveAgentHarnessBeforePromptBuildResult);
  return {
    ...bootstrap,
    resolveAgentHarnessBeforePromptBuildResult: resolvePromptMock,
    prepareAgentWorkspaceContext: prepareAgentWorkspaceContextMock,
    prepareWatchedSessionsHarnessContext: watchedSessionsContextMock,
    embeddedAgentLog: { warn: vi.fn(), debug: vi.fn() },
    formatErrorMessage: String,
    setActiveEmbeddedRun: vi.fn(),
    clearActiveEmbeddedRun: vi.fn(),
    buildAgentHookContextChannelFields: () => ({}),
    buildEmbeddedForegroundPromptContext: () => ({}),
    runAgentHarnessLlmOutputHook: vi.fn(),
    awaitAgentEndSideEffects: vi.fn(),
    runAgentEndSideEffectsAsync: vi.fn(async () => {}),
  };
});

vi.mock("openclaw/plugin-sdk/agent-sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-sessions")>()),
  SessionManager: {
    openAsync: async () => ({ buildSessionContext: () => ({ messages: [] }) }),
    openModelContextAsync: openModelContextAsyncMock,
  },
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
    prepareInputs: fileMocks.prepareInputs.mockImplementation(files.prepareInputs),
    uploadInputs: fileMocks.uploadInputs.mockImplementation(files.uploadInputs),
    collectOutputs: fileMocks.collectOutputs.mockResolvedValue([]),
  };
});

vi.mock("./agentsapi-messages.js", () => ({
  AgentsApiMessageProjection: class {
    reply = {};
    recordUsage = vi.fn();
    commit = vi.fn();
    toolMetas = [];
    itemLifecycle = { startedCount: 0, completedCount: 0, activeCount: 0 };
  },
}));

// mock-isolation: instruction fixtures stub turn submission; agentsapi-session.test.ts owns lifecycle.
vi.mock("./agentsapi-session.js", () => ({
  createAgentsApiSession: (
    options: Parameters<typeof import("./agentsapi-session.js").createAgentsApiSession>[0],
  ) => ({
    run: async (input: string, persistInput: () => Promise<void>, onSubmitted: () => void) => {
      promptFixture.turnInputs.push(input);
      await persistInput();
      await options.client.message(options.sessionId, input, options.signal);
      onSubmitted();
      return { turn: { id: "turn-fixture" }, cancelled: false };
    },
    readUsageTurns: async () => [],
    close: async () => {},
    wasSubmitted: () => true,
  }),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(async () => {
  const runtime = await vi.importActual<HarnessRuntime>(
    "openclaw/plugin-sdk/agent-harness-runtime",
  );
  const files =
    await vi.importActual<typeof import("./agentsapi-files.js")>("./agentsapi-files.js");
  prepareAgentWorkspaceContextMock.mockImplementation(runtime.prepareAgentWorkspaceContext);
  resolvePromptMock.mockImplementation(runtime.resolveAgentHarnessBeforePromptBuildResult);
  fileMocks.prepareInputs.mockReset().mockImplementation(files.prepareInputs);
  fileMocks.uploadInputs.mockReset().mockImplementation(files.uploadInputs);
  fileMocks.collectOutputs.mockReset().mockResolvedValue([]);
  fetchWithSsrFGuardMock.mockImplementation(async ({ url }) => ({
    response: new URL(url).pathname.endsWith("/items")
      ? Response.json({ data: [], has_more: false })
      : Response.json({ id: "session-fixture" }),
    finalUrl: url,
    release: async () => {},
  }));
});
afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
  prepareAgentWorkspaceContextMock.mockClear();
  watchedSessionsContextMock.mockClear();
  openModelContextAsyncMock.mockReset();
  resetGlobalHookRunner();
  promptFixture.declarations = [];
  promptFixture.turnInputs = [];
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("captures plugin system instructions once and refreshes plugin context on resume", async () => {
  const fixture = await createFixture({
    trigger: "user",
    toolAuthorityFingerprint: "fixture-prompt-authority",
    contextTokenBudget: 32_000,
  });
  promptFixture.declarations = toolDeclarations("memory_search", "memory_get");
  const hook = vi.fn().mockReturnValue({
    prependSystemContext: "Plugin system guidance one.",
    prependContext: "Reminder one.",
    appendContext: "Plugin trailing context.",
  });
  const recall = vi.fn().mockReturnValue({ prependContext: "Authorized recall context." });
  promptHooks({ handler: hook }, { handler: recall, requiresToolAuthority: true });

  const binding = await fixture.run();
  expect(openModelContextAsyncMock).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      limits: { maxBytes: 256_000, maxEvents: 10_000, toolResultOverflow: "omit" },
    }),
  );
  expect(hook).toHaveBeenCalledWith(
    expect.objectContaining({ messages: [{ role: "user", content: "Earlier request" }] }),
    expect.anything(),
  );
  expect(fixture.requests[0]?.agent.instructions).toContain("Plugin system guidance one.");
  expect(promptFixture.turnInputs[0]).toContain(
    "Reminder one.\n\nAuthorized recall context.\n\nFixture prompt\n\nPlugin trailing context.",
  );
  hook.mockReturnValue({
    prependSystemContext: "Plugin system guidance two.",
    prependContext: "Reminder two.",
  });
  await fixture.run(binding, { prompt: "Continued request" });
  expect(fixture.requests[1]).toEqual({ agent: { reasoning: { effort: null } } });
  expect(promptFixture.turnInputs[1]).toContain(
    "Reminder two.\n\nAuthorized recall context.\n\nContinued request",
  );

  await fixture.run();
  expect(fixture.requests[2]?.agent.instructions).toContain("Plugin system guidance two.");
});

it("keeps ordinary context but grants no Gateway tool authority when forwarding is disabled", async () => {
  const fixture = await createFixture(
    { toolAuthorityFingerprint: "fixture-prompt-authority" },
    { forwarding: { gatewayTools: false, mcpServers: false } },
  );
  promptFixture.declarations = toolDeclarations("memory_search", "memory_get");
  const allowed: boolean[] = [];
  const recall = vi
    .fn()
    .mockImplementation(
      (_event, ctx: { toolAuthority?: { allows: (name: string) => boolean } }) => {
        allowed.push(ctx.toolAuthority?.allows("memory_search") ?? true);
      },
    );
  promptHooks(
    { handler: () => ({ prependContext: "Ordinary plugin context." }) },
    { requiresToolAuthority: true, handler: recall },
  );
  await fixture.run();
  expect(allowed).toEqual([false]);
  expect(promptFixture.turnInputs[0]).toContain("Ordinary plugin context.");
  expect(fixture.requests[0]?.agent.instructions).toContain("Extra fixture instructions");
  expect(prepareAgentWorkspaceContextMock).toHaveBeenCalledWith(
    expect.objectContaining({
      memoryToolRouted: false,
      memoryTools: expect.objectContaining({ toolNames: [] }),
    }),
  );
});

it("continues without transcript access when no prompt hook needs history", async () => {
  const fixture = await createFixture();
  openModelContextAsyncMock.mockRejectedValue(new Error("History is unavailable"));
  await fixture.run();
  expect(promptFixture.turnInputs[0]).toContain("Fixture prompt");
});

it.each([
  { resumed: false, toolsAllow: [] },
  { resumed: true, toolsAllow: [] },
  { resumed: false, toolsAllow: ["memory_search"] },
  { resumed: true, toolsAllow: ["memory_search"] },
])(
  "continues with plugin context when tool restrictions cannot be enforced ($resumed, $toolsAllow)",
  async ({ resumed, toolsAllow }) => {
    const fixture = await createFixture({ toolAuthorityFingerprint: "fixture-prompt-authority" });
    const binding = resumed ? await fixture.run() : undefined;
    const requestCount = fixture.requests.length;
    const inputCount = promptFixture.turnInputs.length;
    const recall = vi.fn().mockReturnValue({ prependContext: "Authorized recall context." });
    promptHooks(
      { handler: () => ({ toolsAllow, prependContext: "Ordinary plugin context." }) },
      { handler: recall, requiresToolAuthority: true },
    );
    await fixture.run(binding);
    expect(fixture.requests).toHaveLength(requestCount + 1);
    expect(promptFixture.turnInputs).toHaveLength(inputCount + 1);
    expect(promptFixture.turnInputs[inputCount]).toContain(
      "Ordinary plugin context.\n\nAuthorized recall context.\n\nFixture prompt",
    );
    expect(recall).toHaveBeenCalledOnce();
  },
);

it.each([false, true])(
  "preserves a workspace snapshot through resume (blank: %s)",
  async (blank) => {
    const fixture = await createFixture();
    const instructionsPath = path.join(fixture.workspace, "AGENTS.md");
    const original = blank ? " \n\t" : "Follow the Gateway fixture operating rules.\n";
    const updated = blank
      ? "Rules added after session creation."
      : "Follow the updated Gateway fixture rules.";
    const contextFiles: Record<string, string> = blank
      ? {}
      : {
          "SOUL.md": "Use the fixture's calm, direct voice.",
          "IDENTITY.md": "Your fixture name is Orchard.",
          "USER.md": "The fixture human prefers concise replies.",
          "BOOTSTRAP.md": "Complete the fixture workspace introduction.",
          "MEMORY.md": "The fixture's durable project is Cedar.",
        };
    await fixture.write({ "AGENTS.md": original, ...contextFiles });
    expect(await fs.readdir(fixture.executionWorkspace)).toEqual([]);

    const binding = await fixture.run();
    const firstInstructions = fixture.requests[0]?.agent.instructions;
    expect(firstInstructions).toContain("Extra fixture instructions");
    if (blank) {
      expect(firstInstructions).not.toContain("OpenClaw Agent Workspace Instructions");
    } else {
      expect(firstInstructions).toContain(`### ${instructionsPath}\n\n${original}`);
      expect(
        firstInstructions?.match(/Follow the Gateway fixture operating rules\./g),
      ).toHaveLength(1);
    }
    for (const content of Object.values(contextFiles)) {
      expect(firstInstructions).toContain(content);
    }

    await fixture.write({
      "AGENTS.md": updated + (blank ? "" : "\n"),
      "SOUL.md": "Use the updated fixture voice.",
    });
    // A resumed attempt needs only its binding, with no local instruction cache.
    const resumedBinding = structuredClone(binding);
    await fixture.run(resumedBinding);
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests[1]).toEqual({ agent: { reasoning: { effort: null } } });

    await fixture.run();
    expect(fixture.requests[2]?.agent.instructions).toContain(updated);
    if (!blank) {
      expect(fixture.requests[2]?.agent.instructions).not.toContain(original.trim());
    }
    expect(fixture.requests[2]?.agent.instructions).toContain("Use the updated fixture voice.");
  },
);

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
  await fixture.write({
    "SOUL.md": "Channel fixture persona.",
    "MEMORY.md": "Private fixture memory.",
  });
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
  expect(instructions).toContain("Permission blocks:");
  expect(instructions).toContain("Omit unverified remediation advice");
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
  watchedSessionsContextMock.mockResolvedValueOnce("Watched fixture session: fixture-one");
  const binding = await fixture.run();
  expect(promptFixture.turnInputs[0]).toContain("Current date: 2026-09-25");
  expect(promptFixture.turnInputs[0]).toContain("Time zone: America/Los_Angeles");
  expect(promptFixture.turnInputs[0]).toContain(
    "OpenClaw delivers your final response automatically to the caller.",
  );
  expect(promptFixture.turnInputs[0]).toContain("Watched fixture session: fixture-one");
  expect(promptFixture.turnInputs[0]).toContain("Fixture prompt");

  now.mockReturnValue(Date.parse("2026-09-26T12:00:00-07:00"));
  watchedSessionsContextMock.mockResolvedValueOnce("Watched fixture session: fixture-two");
  await fixture.run(binding, {
    sourceReplyDeliveryMode: "message_tool_only",
    messageChannel: "telegram",
    currentChannelId: "123",
    messageToolFinalByDefault: false,
  });
  expect(promptFixture.turnInputs[1]).toContain("Current date: 2026-09-26");
  expect(promptFixture.turnInputs[1]).toContain("Use `message(action=send)`");
  expect(promptFixture.turnInputs[1]).toContain("A send ends this turn only with `final=true`.");
  expect(promptFixture.turnInputs[1]).toContain("Watched fixture session: fixture-two");
  expect(watchedSessionsContextMock).toHaveBeenLastCalledWith(
    expect.objectContaining({
      sessionKey: "agent:main:main",
      toolNames: new Set(["message", "sessions_history"]),
    }),
  );
  expect(fixture.requests[1]).toEqual({ agent: { reasoning: { effort: null } } });
});

it.each([
  { bootstrapMaxChars: 300, bootstrapTotalMaxChars: 600, budget: 300 },
  { bootstrapMaxChars: 600, bootstrapTotalMaxChars: 300, budget: 300 },
])("applies the configured bootstrap limits (%j)", async ({ budget, ...limits }) => {
  const fixture = await createFixture({ config: { agents: { defaults: limits } } });
  await fixture.write({ "AGENTS.md": "Bounded fixture rules.\n".repeat(100) });
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
  await fixture.write({ "AGENTS.md": "Full bootstrap fixture rules." });
  await fixture.run();
  expect(fixture.requests[0]?.agent.instructions).not.toContain("Full bootstrap fixture rules.");
  expect(fixture.requests[0]?.agent.instructions).toContain("Extra fixture instructions");
  expect(promptFixture.turnInputs).toEqual(["Fixture prompt"]);
});

it("retries a failed first capture before creating or binding a native session", async () => {
  const fixture = await createFixture();
  await fixture.write({ "AGENTS.md": "Retryable Gateway fixture rules." });
  const failure = new Error("Workspace access changed while preparing bootstrap context");
  prepareAgentWorkspaceContextMock.mockRejectedValueOnce(failure);
  await expect(fixture.run()).rejects.toBe(failure);
  expect(fixture.requests).toEqual([]);
  await fixture.run();
  expect(fixture.requests[0]?.agent.instructions).toContain("Retryable Gateway fixture rules.");
});
type InstructionRequest = {
  agent: { instructions?: string; reasoning?: { effort: string | null } };
};

async function createFixture(
  overrides: Partial<AgentHarnessAttemptParamsV2> = {},
  pluginConfig: Record<string, unknown> = {},
) {
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
      if (!pathname.endsWith("/events")) {
        requests.push(await new Request(request.url, request.init).json());
      }
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
  const params = createAttemptParams({
    ...target,
    sessionTarget: target,
    workspaceDir: executionWorkspace,
    bootstrapWorkspaceDir: workspace,
    agentDir: root,
    sessionFile: path.join(root, "transcript"),
    extraSystemPrompt: "Extra fixture instructions",
    timeoutMs: 60_000,
    modelId: "model-fixture",
    model: createModel({ id: "model-fixture" }),
    // Credentials and catalog are unused by the stubbed Gateway tool surface.
    authStorage: {} as AgentHarnessAttemptParamsV2["authStorage"],
    modelRegistry: {} as AgentHarnessAttemptParamsV2["modelRegistry"],
    ...overrides,
  });
  return {
    workspace,
    executionWorkspace,
    requests,
    write: (files: Record<string, string>) =>
      Promise.all(
        Object.entries(files).map(([name, text]) => fs.writeFile(path.join(workspace, name), text)),
      ),
    async run(
      binding?: AgentsApiBinding,
      turnOverrides: Partial<AgentHarnessAttemptParamsV2> = {},
    ) {
      const { result, bind } = await attempt({
        ...params,
        config: params.config,
        ...turnOverrides,
        binding,
        target,
        pluginConfig,
      });
      if (result.terminal.kind === "failed") {
        throw result.terminal.error;
      }
      expect(result.terminal).toEqual({ kind: "ok" });
      const saved = bind.mock.calls[0]?.[0] ?? binding;
      if (!saved) {
        throw new Error("Expected a saved native binding");
      }
      return saved;
    },
  };
}

function promptHooks(
  ...hooks: Omit<Parameters<typeof createMockPluginRegistry>[0][number], "hookName">[]
) {
  initializeGlobalHookRunner(
    createMockPluginRegistry(
      hooks.map((hook) => Object.assign({ hookName: "before_prompt_build" }, hook)),
    ),
  );
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

describe("Agents API attempt environment selection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
    prepareAgentWorkspaceContextMock.mockResolvedValue(emptyWorkspaceContext());
    resolvePromptMock.mockImplementation(async ({ prompt, developerInstructions }) => ({
      prompt,
      developerInstructions:
        typeof developerInstructions === "string"
          ? developerInstructions
          : (developerInstructions.build({ hasToolRestrictions: false }) ?? ""),
    }));
    fileMocks.prepareInputs.mockResolvedValue({ files: [], mappingText: "" });
    fileMocks.uploadInputs.mockResolvedValue({ status: "uploaded" });
  });
  it.each<Partial<AgentHarnessAttemptParamsV2>>([
    { config: { tools: { web: { search: { enabled: false } } } } },
    { toolOverrides: { webSearch: false } },
  ])("enforces the effective search disable on creation and resume (%j)", async (overrides) => {
    const run = (binding?: AgentsApiBinding, policy = overrides) => attempt({ binding, ...policy });
    const created = await run();
    expect(created.result.terminal).toEqual({ kind: "ok" });
    expect(await requestBody(0)).toHaveProperty("agent.tools", [
      { type: "programmatic_tool_calling", enabled: true },
    ]);
    const binding = created.bind.mock.calls[0]![0];
    fetchWithSsrFGuardMock.mockClear();
    expect((await run(binding)).result.terminal).toEqual({ kind: "ok" });
    expect(await requestBody(0)).toEqual({ agent: { reasoning: { effort: null } } });
    fetchWithSsrFGuardMock.mockClear();
    for (const [saved, policy] of [
      [savedBinding(undefined), overrides],
      [binding, {}],
    ] as const) {
      const rejected = await run(saved, policy);
      expect(rejected.result.terminal).toMatchObject({
        kind: "failed",
        error: expect.objectContaining({
          message: expect.stringContaining("web-search, or forwarding policy changed"),
        }),
      });
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
      expect(rejected.bind).not.toHaveBeenCalled();
    }
  });

  it("continues two self-hosted sessions with the rotated key and original native IDs", async () => {
    const environment = "self_hosted";
    let createdCount = 0;
    fetchWithSsrFGuardMock.mockImplementation(async ({ url }) => {
      const pathname = new URL(url).pathname;
      const response = pathname.endsWith("/items")
        ? Response.json({ data: [], has_more: false })
        : Response.json({
            id: pathname.endsWith("/agents/sessions")
              ? `rotation-session-${++createdCount}`
              : pathname.split("/").at(-1),
          });
      return { response, finalUrl: url, release: async () => {} };
    });
    const bindings: AgentsApiBinding[] = [];
    for (const sessionId of ["local-first", "local-second"]) {
      const created = await attempt({ environment, sessionId });
      expect(created.result).toMatchObject({ terminal: { kind: "ok" } });
      bindings.push(created.bind.mock.calls[0]![0]);
    }
    fetchWithSsrFGuardMock.mockClear();
    for (const [index, binding] of bindings.entries()) {
      const continued = await attempt({
        environment,
        binding,
        sessionId: index === 0 ? "local-first" : "local-second",
        resolvedApiKey: "fixture-rotated-api-key",
      });
      expect(continued.result).toMatchObject({ terminal: { kind: "ok" } });
    }
    expect(createdCount).toBe(2);
    expect(
      fetchWithSsrFGuardMock.mock.calls.map(([request]) => ({
        path: new URL(request.url).pathname,
        auth: new Headers(request.init?.headers).get("authorization"),
      })),
    ).toEqual(
      bindings.flatMap(({ sessionId }) =>
        ["", "/events", "/items"].map((suffix) => ({
          path: `/v1/agents/sessions/${sessionId}${suffix}`,
          auth: "Bearer fixture-rotated-api-key",
        })),
      ),
    );
  });

  it("retains ordinary HTTP 403 access errors and the existing binding", async () => {
    const status = 403;
    const binding = await hostedBinding();
    fetchWithSsrFGuardMock.mockClear();
    fetchWithSsrFGuardMock.mockImplementation(async ({ url }) =>
      errorResponse(url, status, "authentication_error", "Fixture key cannot access session"),
    );
    const denied = await attempt({
      environment: "openai_hosted",
      binding,
      resolvedApiKey: "fixture-denied-api-key",
    });
    expect(denied.result).toMatchObject({
      terminal: { kind: "failed", error: expect.objectContaining({ status }) },
    });
    expect(
      fetchWithSsrFGuardMock.mock.calls.map(([request]) => new URL(request.url).pathname),
    ).toEqual([`/v1/agents/sessions/${binding.sessionId}`]);
    expect(denied.bind).not.toHaveBeenCalled();
  });

  it.each([
    {
      operation: "input submission",
      status: 404,
      type: "not_found_error",
      backendMessage: "No managed agent resource found: session-fixture",
      userMessage:
        "Agents API could not find the saved session or this API key cannot access it. Check that the key belongs to the session's project and has the required permissions, then retry.",
    },
    {
      operation: "input submission with the original-key requirement",
      status: 403,
      type: "forbidden",
      backendMessage: "hosted session input requires the API key that created its CCA thread",
      userMessage:
        "Agents API currently requires the original API key to send input to this hosted session. Restore that key, then retry to continue the same session.",
    },
  ])(
    "reports inaccessible saved sessions during $operation as a terminal preflight",
    async ({ status, type, backendMessage, userMessage }) => {
      const binding = await hostedBinding();
      const fetch = fetchWithSsrFGuardMock.getMockImplementation()!;
      fetchWithSsrFGuardMock.mockImplementation(async (request) => {
        if (new URL(request.url).pathname === `/v1/agents/sessions/${binding.sessionId}/events`) {
          return errorResponse(request.url, status, type, backendMessage);
        }
        return fetch(request);
      });

      const { result } = await attempt({ environment: "openai_hosted", binding });

      assert(result.terminal.kind === "failed", "Expected the saved-session request to fail");
      expect(result.terminal.error).toBeInstanceOf(AgentHarnessPreflightError);
      expect(result.terminal.error).toMatchObject({
        message: expect.stringContaining(backendMessage),
        userMessage,
        cause: expect.objectContaining({ status, type }),
      });
    },
  );

  it("carries hosted attachments through session creation, input mapping, and reply delivery", async () => {
    const media = [{ path: "/fixture/input.txt" }];
    const file: AgentsApiInputFile = {
      type: "inline",
      path: "/workspace/inputs/input.txt",
      data: Buffer.from("fixture attachment").toString("base64"),
    };
    const mappingText = "Input attachment: /workspace/inputs/input.txt";
    const outputUrl = "/fixture/outbound/report.txt";
    fileMocks.prepareInputs.mockResolvedValueOnce({ files: [file], mappingText });
    fileMocks.collectOutputs.mockResolvedValueOnce([outputUrl]);

    const network = { access: "restricted", allowed_domains: ["api.github.com"] };
    const { result } = await attempt({
      environment: "openai_hosted",
      media,
      pluginConfig: {
        openai_host: { network },
        forwarding: { gatewayTools: false, mcpServers: false },
      },
    });

    expect(result).toMatchObject({
      terminal: { kind: "ok" },
      toolMediaUrls: [outputUrl],
      hostOwnedToolMediaUrls: [outputUrl],
      toolTrustedLocalMedia: true,
    });
    expect(fileMocks.prepareInputs).toHaveBeenCalledExactlyOnceWith(
      media,
      "/fixture/project",
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(await requestBody(0)).toMatchObject({
      environment: { type: "openai_hosted", files: [file], network },
    });
    expect(await requestBody(1)).toMatchObject({
      events: [
        {
          type: "agent.session.input.message",
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: expect.stringContaining(`Fixture prompt\n\n${mappingText}`),
                },
              ],
            },
          ],
        },
      ],
    });
    expect(fileMocks.collectOutputs).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "prepared prompt", replacePrompt: false },
    {
      name: "inline document pages with a hook-replaced prompt",
      replacePrompt: true,
      images: [{ type: "image" as const, data: "cGFnZQ==", mimeType: "image/png" }],
    },
  ])(
    "stages managed attachments for new and resumed self-hosted turns with $name",
    async ({ replacePrompt, images }) => {
      const fixture = await createWorkspaceAttachmentFixture(
        tempDirs.make("agentsapi-self-hosted-attachments-"),
      );
      let binding: AgentsApiBinding | undefined;
      for (const job of ["initial-import", "continued-import"]) {
        const contents = [
          Buffer.from(
            `INFO import queued\nINFO import completed job_id=${job} rows_processed=42\n`,
          ),
          Buffer.from(`ERROR job_id=${job} record 9 has an invalid amount\n`),
        ];
        const media = await Promise.all(
          contents.map(async (bytes, index) => {
            const saved = await saveMediaBuffer(bytes, "text/plain", "inbound");
            return {
              path: saved.path,
              url: `media://inbound/${saved.id}`,
              fileName: `import-job-${index}.log`,
              contentType: "text/plain",
              sizeBytes: bytes.length,
            };
          }),
        );
        const originalMedia = structuredClone(media);
        const prompt = `Check ${job} with grep.`;
        const priorNote = await prepareAgentWorkspaceAttachments({
          workspaceDir: fixture.gatewayRoot,
          turn: { media, timeoutMs: 1_000 },
          assertCurrent: () => {},
        });
        if (replacePrompt) {
          resolvePromptMock.mockImplementation(async ({ developerInstructions }) => ({
            prompt,
            developerInstructions:
              typeof developerInstructions === "string"
                ? developerInstructions
                : (developerInstructions.build({ hasToolRestrictions: false }) ?? ""),
          }));
        }
        const submitted = await attempt({
          environment: "self_hosted",
          binding,
          workspaceDir: fixture.gatewayRoot,
          media,
          prompt: priorNote ? `${prompt}\n\n${priorNote}` : prompt,
          images,
        });

        expect(submitted.result.terminal).toEqual({ kind: "ok" });
        const request = (await requestBody(1)) as {
          events: Array<{ input: Array<{ content: Array<{ text: string }> }> }>;
        };
        const text = request.events[0]!.input[0]!.content[0]!.text;
        const attachmentPaths = [...text.matchAll(/\[media attached: ([^\]]+)\]/gu)].map(
          (match) => match[1]!,
        );
        expect(attachmentPaths).toHaveLength(2);
        expect(text).toContain(`${prompt}\n\n[media attached: ${attachmentPaths[0]}]`);
        for (const [index, attachmentPath] of attachmentPaths.entries()) {
          expect(attachmentPath.startsWith(`${fixture.remoteRoot}${path.sep}`)).toBe(true);
          expect(await fs.readFile(attachmentPath)).toEqual(contents[index]);
        }
        if (images) {
          expect(text).toContain("The Agents API harness does not support inline image inputs.");
          expect(text).toContain(
            "Original attachments are available at the prepared execution paths above.",
          );
          expect(text).toContain(
            "inspect those files with available tools to try another approach",
          );
        }
        expect(media).toEqual(originalMedia);
        binding ??= submitted.bind.mock.calls[0]![0];
        fetchWithSsrFGuardMock.mockClear();
      }
    },
  );

  it("keeps text-only transcript recorders usable with a stopped workspace", async () => {
    const fixture = await createWorkspaceAttachmentFixture(
      tempDirs.make("agentsapi-self-hosted-attachments-"),
    );
    const workspaceDir = fixture.gatewayRoot;
    fixture.release();
    const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
    const recorder = createRecorder({
      target: () => undefined,
      resolveInput: async () => ({ text: "Text-only request" }),
    });
    const { result } = await attempt({
      environment: "self_hosted",
      workspaceDir,
      prompt: "Text-only request",
      userTurnTranscriptRecorder: recorder,
    });
    expect(result.terminal).toEqual({ kind: "ok" });
  });
  it("explains the missing self-hosted attachment provider", async () => {
    const { result } = await attempt({
      environment: "self_hosted",
      media: [{ path: "/fixture/input.txt" }],
    });

    expect(result).toMatchObject({
      terminal: {
        kind: "failed",
        error: expect.objectContaining({
          message:
            "Workspace attachments require a registered attachment provider; configure one for this execution environment before retrying",
        }),
      },
    });
  });

  it("preserves the workspace provider's managed-source boundary", async () => {
    const fixture = await createWorkspaceAttachmentFixture(
      tempDirs.make("agentsapi-self-hosted-attachments-"),
    );
    const source = path.join(fixture.gatewayRoot, "private-project-file.txt");
    await fs.writeFile(source, "private project bytes");
    const { result } = await attempt({
      environment: "self_hosted",
      workspaceDir: fixture.gatewayRoot,
      media: [{ path: source, fileName: "import-job.log" }],
    });

    expect(result).toMatchObject({
      terminal: {
        kind: "failed",
        error: expect.objectContaining({ code: "path-not-allowed" }),
      },
    });
  });
});

async function attempt({
  environment,
  binding,
  pluginConfig,
  target,
  ...overrides
}: Partial<AgentHarnessAttemptParamsV2> & {
  environment?: string;
  binding?: AgentsApiBinding;
  pluginConfig?: Record<string, unknown>;
  target?: Parameters<typeof runAgentsApiAttempt>[5];
} = {}) {
  const params = createAttemptParams({
    // Per-run plugin overrides do not own live plugin settings.
    config: {
      plugins: { entries: { agentsapi: { config: { environment: "invalid-run-override" } } } },
    },
    hostCapabilities: {
      assertActive: vi.fn(),
      reportOutputTokens: vi.fn(),
    },
    ...overrides,
  });
  const bind = vi.fn<(next: AgentsApiBinding) => Promise<void>>(async () => {});
  const result = await runAgentsApiAttempt(
    params,
    binding,
    bind,
    vi.fn<() => void>(),
    vi.fn(),
    target ?? {
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey!,
      storePath: "/fixture/sessions.json",
    },
    () => ({ ...(environment === undefined ? {} : { environment }), ...pluginConfig }),
    new WeakMap(),
  );
  return { result, bind };
}

async function hostedBinding() {
  return (await attempt({ environment: "openai_hosted" })).bind.mock.calls[0]![0];
}

function errorResponse(url: string, status: number, type: string, message: string) {
  return {
    response: Response.json({ error: { message, type } }, { status }),
    finalUrl: url,
    release: async () => {},
  };
}

function savedBinding(environment: string | undefined) {
  const identity: unknown[] = ["fixture-model"];
  if (environment === "self_hosted") {
    identity.push({ type: "self_hosted", workspace_directory: "/fixture/project" });
  }
  return {
    sessionId: "session-fixture",
    configFingerprint: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
  };
}

async function requestBody(index: number): Promise<unknown> {
  const request = fetchWithSsrFGuardMock.mock.calls[index]?.[0];
  if (!request) {
    throw new Error("Expected a fixture SDK request");
  }
  return new Request(request.url, request.init).json();
}
