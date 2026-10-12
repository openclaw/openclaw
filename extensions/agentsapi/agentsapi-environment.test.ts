import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-registration";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import {
  createWorkspaceAttachmentPreparer,
  prepareAgentWorkspaceAttachments,
  registerAgentWorkspaceAccess,
  type AgentWorkspaceAccess,
} from "openclaw/plugin-sdk/agent-workspace-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { loadUserTurnTranscriptRecorderFactoryForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentsApiAttempt } from "./agentsapi-attempt.js";
import type { AgentsApiBinding } from "./agentsapi-bindings.js";
import type { AgentsApiInputFile } from "./agentsapi-client.js";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>(),
  commit: vi.fn(async () => {}),
  prepareInputs: vi.fn<typeof import("./agentsapi-files.js").prepareInputs>(),
  uploadInputs: vi.fn<typeof import("./agentsapi-files.js").uploadInputs>(),
  collectOutputs: vi.fn<typeof import("./agentsapi-files.js").collectOutputs>(),
  resolvePrompt: vi.fn<(prompt: string) => string>(),
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
  resolveAgentHarnessHistoryLimits: vi.fn(),
  resolveAgentWorkspaceMemoryRouting: () => ({ memoryToolNames: [], memoryToolRouted: false }),
  shouldIncludeAgentHarnessRuntimeContext: () => true,
  selectSupportedReasoningEffort: vi.fn(),
  AgentHarnessProjectionSettlement: class {
    constructor(readonly params: AgentHarnessAttemptParamsV2) {}
    async drain() {}
  },
  racePromiseWithAbortSignal: (promise: Promise<unknown>) => promise,
}));
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  agentHarnessAttemptTerminal: { normalize: () => ({ kind: "ok" }) },
  loadAgentHarnessMcpConfig: async () => ({
    config: { mcpServers: {} },
    diagnostics: [],
    requesterScopedServerNames: [],
  }),
  resolveAgentHarnessBeforePromptBuildResult: async ({
    prompt,
    developerInstructions,
  }: {
    prompt: string;
    developerInstructions: string;
  }) => ({ prompt: mocks.resolvePrompt(prompt), developerInstructions }),
  prepareAgentWorkspaceContext: async () => ({
    instructionSnapshot: { instructions: "" },
    personaInstructions: "",
    promptContextFiles: [],
    memoryRecallInstructions: "",
    memoryReferenceFiles: [],
  }),
  SKILL_WORKSHOP_TOOL_NAME: "skill_workshop",
  resolveMainSessionDelegationMode: () => "default",
  buildDelegationGuidanceSection: () => [],
  buildSkillWorkshopPromptSection: () => [],
  buildCredentialSafetyPrompt: () => "",
  buildUiPresentationPrompt: () => "",
  buildTemporalContextText: () => "",
  buildHarnessVisibleReplyGuidance: () => "",
  prepareWatchedSessionsHarnessContext: async () => "",
  awaitAgentEndSideEffects: vi.fn(async () => {}),
  buildAgentHookContextChannelFields: () => ({}),
  buildEmbeddedForegroundPromptContext: () => ({}),
  clearActiveEmbeddedRun: vi.fn(),
  embeddedAgentLog: { warn: vi.fn() },
  formatErrorMessage: (error: unknown) => String(error),
  resolveAgentDir: () => "/fixture/agent",
  runAgentEndSideEffectsAsync: vi.fn(async () => {}),
  runAgentHarnessLlmOutputHook: vi.fn(),
  sanitizeToolArgs: (args: unknown) => args,
  setActiveEmbeddedRun: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/agent-sessions", () => ({
  AuthStorage: { inMemory: () => ({}) },
  ModelRegistry: { inMemory: () => ({}) },
  SessionManager: { openAsync: async () => ({ buildSessionContext: () => ({ messages: [] }) }) },
}));
vi.mock("openclaw/plugin-sdk/llm", () => ({
  resolveOpenAIModelReasoningEfforts: vi.fn(),
  resolveOpenAIReasoningEffortMap: vi.fn(),
  resolveOpenAIReasoningEffortMapping: vi.fn(),
}));
vi.mock("./agentsapi-tools.js", () => ({
  buildAgentsApiToolSurface: () => ({ declarations: [], toolMetas: [], delivery: {} }),
}));
vi.mock("./agentsapi-files.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agentsapi-files.js")>()),
  prepareInputs: mocks.prepareInputs,
  uploadInputs: mocks.uploadInputs,
  collectOutputs: mocks.collectOutputs,
}));
vi.mock("./agentsapi-transcript.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agentsapi-transcript.js")>()),
  recordAgentsApiNativeToolTranscript: vi.fn(),
}));
vi.mock("./agentsapi-messages.js", () => ({
  AgentsApiMessageProjection: class {
    reply = {};
    toolMetas = [];
    itemLifecycle = { startedCount: 0, completedCount: 0, activeCount: 0 };
    recordUsage = vi.fn();
    commit = mocks.commit;
  },
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
  mocks.prepareInputs.mockReset().mockResolvedValue({ files: [], mappingText: "" });
  mocks.uploadInputs.mockReset().mockResolvedValue({ status: "uploaded" });
  mocks.collectOutputs.mockReset().mockResolvedValue([]);
  mocks.resolvePrompt.mockReset().mockImplementation((prompt) => prompt);
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
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("Agents API attempt environment selection", () => {
  it.each<Partial<AgentHarnessAttemptParamsV2>>([
    { config: { tools: { web: { search: { enabled: false } } } } },
    { toolOverrides: { webSearch: false } },
  ])("enforces the effective search disable on creation and resume (%j)", async (overrides) => {
    const run = (binding?: AgentsApiBinding, policy = overrides) =>
      attempt(
        undefined,
        binding,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        policy,
      );
    const created = await run();
    expect(created.result.terminal).toEqual({ kind: "ok" });
    expect(await requestBody(0)).toHaveProperty("agent.tools", [
      { type: "programmatic_tool_calling", enabled: true },
    ]);
    const binding = created.bind.mock.calls[0]![0];
    mocks.fetch.mockClear();
    expect((await run(binding)).result.terminal).toEqual({ kind: "ok" });
    expect(await requestBody(0)).toEqual({ agent: { reasoning: { effort: null } } });
    mocks.fetch.mockClear();
    for (const [saved, policy] of [
      [savedBinding(undefined), overrides],
      [binding, {}],
    ] as const) {
      const rejected = await run(saved, policy);
      expect(rejected.result.terminal).toMatchObject({
        kind: "failed",
        error: expect.objectContaining({
          message: expect.stringContaining("web-search policy changed"),
        }),
      });
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(rejected.bind).not.toHaveBeenCalled();
    }
  });

  it.each([
    {
      name: "domains changed",
      previous: { access: "restricted", allowed_domains: ["api.github.com"] },
      next: { access: "restricted", allowed_domains: ["pypi.org"] },
    },
  ])("requires reset when hosted network policy is $name", async ({ previous, next }) => {
    const created = await attempt(undefined, undefined, undefined, undefined, {
      openai_host: { network: previous },
    });
    expect(created.result).toMatchObject({ terminal: { kind: "ok" } });
    mocks.fetch.mockClear();

    const { result, bind } = await attempt(
      undefined,
      created.bind.mock.calls[0]![0],
      undefined,
      undefined,
      { openai_host: { network: next } },
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
  });

  it.each([
    { name: "hosted to self-hosted", previous: undefined, next: "self_hosted" },
    {
      name: "self-hosted workspace change",
      previous: "self_hosted",
      next: "self_hosted",
      workspaceDir: "/fixture/other-project",
    },
  ])("requires reset for $name before native writes", async ({ previous, next, workspaceDir }) => {
    const { result, bind } = await attempt(next, savedBinding(previous), workspaceDir);

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
  });

  it.each(["self_hosted"])(
    "continues two %s sessions with the rotated key and original native IDs",
    async (environment) => {
      let createdCount = 0;
      mocks.fetch.mockImplementation(async ({ url }) => {
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
        const created = await attempt(
          environment,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { sessionId },
        );
        expect(created.result).toMatchObject({ terminal: { kind: "ok" } });
        bindings.push(created.bind.mock.calls[0]![0]);
      }
      mocks.fetch.mockClear();
      for (const [index, binding] of bindings.entries()) {
        const continued = await attempt(
          environment,
          binding,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          {
            sessionId: index === 0 ? "local-first" : "local-second",
            resolvedApiKey: "fixture-rotated-api-key",
          },
        );
        expect(continued.result).toMatchObject({ terminal: { kind: "ok" } });
      }
      expect(createdCount).toBe(2);
      expect(
        mocks.fetch.mock.calls.map(([request]) => ({
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
    },
  );

  it.each([403])(
    "retains ordinary HTTP %s access errors and the existing binding",
    async (status) => {
      const created = await attempt("openai_hosted");
      const binding = created.bind.mock.calls[0]![0];
      mocks.fetch.mockClear();
      mocks.fetch.mockImplementation(async ({ url }) => ({
        response: Response.json(
          { error: { message: "Fixture key cannot access session", type: "authentication_error" } },
          { status },
        ),
        finalUrl: url,
        release: async () => {},
      }));
      const denied = await attempt(
        "openai_hosted",
        binding,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { resolvedApiKey: "fixture-denied-api-key" },
      );
      expect(denied.result).toMatchObject({
        terminal: { kind: "failed", error: expect.objectContaining({ status }) },
      });
      expect(mocks.fetch.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual([
        `/v1/agents/sessions/${binding.sessionId}`,
      ]);
      expect(denied.bind).not.toHaveBeenCalled();
    },
  );

  it.each([
    ...[{ operation: "input submission", suffix: "/events" }].map(({ operation, suffix }) => ({
      operation,
      suffix,
      status: 404,
      type: "not_found_error",
      backendMessage: "No managed agent resource found: session-fixture",
      userMessage:
        "Agents API could not find the saved session or this API key cannot access it. Check that the key belongs to the session's project and has the required permissions, then retry.",
    })),
    {
      operation: "input submission with the original-key requirement",
      suffix: "/events",
      status: 403,
      type: "forbidden",
      backendMessage: "hosted session input requires the API key that created its CCA thread",
      userMessage:
        "Agents API currently requires the original API key to send input to this hosted session. Restore that key, then retry to continue the same session.",
    },
  ])(
    "reports inaccessible saved sessions during $operation as a terminal preflight",
    async ({ suffix, status, type, backendMessage, userMessage }) => {
      const created = await attempt("openai_hosted");
      const binding = created.bind.mock.calls[0]![0];
      const fetch = mocks.fetch.getMockImplementation()!;
      mocks.fetch.mockImplementation(async (request) => {
        if (new URL(request.url).pathname === `/v1/agents/sessions/${binding.sessionId}${suffix}`) {
          return {
            response: Response.json({ error: { message: backendMessage, type } }, { status }),
            finalUrl: request.url,
            release: async () => {},
          };
        }
        return fetch(request);
      });

      const { result } = await attempt("openai_hosted", binding);

      expect(result.terminal.kind).toBe("failed");
      if (result.terminal.kind !== "failed") {
        throw new Error("Expected the saved-session request to fail");
      }
      expect(result.terminal.error).toBeInstanceOf(AgentHarnessPreflightError);
      expect(result.terminal.error).toMatchObject({
        message: expect.stringContaining(backendMessage),
        userMessage,
        cause: expect.objectContaining({ status, type }),
      });
    },
  );

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

  it("carries hosted attachments through session creation, input mapping, and reply delivery", async () => {
    const media = [{ path: "/fixture/input.txt" }];
    const file: AgentsApiInputFile = {
      type: "inline",
      path: "/workspace/inputs/input.txt",
      data: Buffer.from("fixture attachment").toString("base64"),
    };
    const mappingText = "Input attachment: /workspace/inputs/input.txt";
    const outputUrl = "/fixture/outbound/report.txt";
    mocks.prepareInputs.mockResolvedValueOnce({ files: [file], mappingText });
    mocks.collectOutputs.mockResolvedValueOnce([outputUrl]);

    const network = { access: "restricted", allowed_domains: ["api.github.com"] };
    const { result } = await attempt("openai_hosted", undefined, undefined, media, {
      openai_host: { network },
    });

    expect(result).toMatchObject({
      terminal: { kind: "ok" },
      toolMediaUrls: [outputUrl],
      hostOwnedToolMediaUrls: [outputUrl],
      toolTrustedLocalMedia: true,
    });
    expect(mocks.prepareInputs).toHaveBeenCalledExactlyOnceWith(
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
    expect(mocks.collectOutputs).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "prepared prompt", preparedPrompt: true, replacePrompt: false, recorderMedia: false },
    {
      name: "deferred transcript media",
      preparedPrompt: false,
      replacePrompt: false,
      recorderMedia: true,
    },
    {
      name: "inline document pages with a hook-replaced prompt",
      preparedPrompt: true,
      replacePrompt: true,
      recorderMedia: false,
      images: [{ type: "image" as const, data: "cGFnZQ==", mimeType: "image/png" }],
    },
  ])(
    "stages managed attachments for new and resumed self-hosted turns with $name",
    async ({ preparedPrompt, replacePrompt, recorderMedia, images }) => {
      const fixture = await workspaceAttachmentFixture();
      let binding: AgentsApiBinding | undefined;
      try {
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
          const createRecorder = recorderMedia
            ? await loadUserTurnTranscriptRecorderFactoryForTest()
            : undefined;
          const recorder = createRecorder?.({
            target: () => undefined,
            resolveInput: async () => ({ text: prompt, media }),
          });
          const priorNote = preparedPrompt
            ? await prepareAgentWorkspaceAttachments({
                workspaceDir: fixture.gatewayRoot,
                turn: { media, timeoutMs: 1_000 },
                assertCurrent: () => {},
              })
            : undefined;
          if (replacePrompt) {
            mocks.resolvePrompt.mockReturnValue(prompt);
          }
          const submitted = await attempt(
            "self_hosted",
            binding,
            fixture.gatewayRoot,
            recorderMedia ? undefined : media,
            undefined,
            priorNote ? `${prompt}\n\n${priorNote}` : prompt,
            recorder,
            images,
          );

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
          mocks.fetch.mockClear();
        }
      } finally {
        fixture.release();
      }
    },
  );

  it.each(["stopped"])(
    "keeps text-only transcript recorders usable with a %s workspace",
    async () => {
      const fixture = await workspaceAttachmentFixture();
      const workspaceDir = fixture.gatewayRoot;
      fixture.release();
      const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
      const recorder = createRecorder({
        target: () => undefined,
        resolveInput: async () => ({ text: "Text-only request" }),
      });
      try {
        const { result } = await attempt(
          "self_hosted",
          undefined,
          workspaceDir,
          undefined,
          undefined,
          "Text-only request",
          recorder,
        );
        expect(result.terminal).toEqual({ kind: "ok" });
      } finally {
        fixture.release();
      }
    },
  );
  it("explains the missing self-hosted attachment provider", async () => {
    const { result } = await attempt("self_hosted", undefined, undefined, [
      { path: "/fixture/input.txt" },
    ]);

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
    const fixture = await workspaceAttachmentFixture();
    const source = path.join(fixture.gatewayRoot, "private-project-file.txt");
    await fs.writeFile(source, "private project bytes");
    try {
      const { result } = await attempt("self_hosted", undefined, fixture.gatewayRoot, [
        { path: source, fileName: "import-job.log" },
      ]);

      expect(result).toMatchObject({
        terminal: {
          kind: "failed",
          error: expect.objectContaining({ code: "path-not-allowed" }),
        },
      });
    } finally {
      fixture.release();
    }
  });
});

async function attempt(
  environment: string | undefined,
  binding?: AgentsApiBinding,
  workspaceDir = "/fixture/project",
  media?: AgentHarnessAttemptParamsV2["media"],
  pluginConfig?: Record<string, unknown>,
  prompt = "Fixture prompt",
  userTurnTranscriptRecorder?: AgentHarnessAttemptParamsV2["userTurnTranscriptRecorder"],
  images?: AgentHarnessAttemptParamsV2["images"],
  overrides: Partial<AgentHarnessAttemptParamsV2> = {},
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
    prompt,
    media,
    images,
    userTurnTranscriptRecorder,
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
  Object.assign(params, overrides);
  const bind = vi.fn<(next: AgentsApiBinding) => Promise<void>>(async () => {});
  const result = await runAgentsApiAttempt(
    params,
    binding,
    bind,
    vi.fn<() => void>(),
    vi.fn(),
    {
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

async function workspaceAttachmentFixture() {
  const directory = tempDirs.make("agentsapi-self-hosted-attachments-");
  const gatewayRoot = path.join(directory, "gateway");
  const remoteRoot = path.join(directory, "executor");
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(directory, "state"));
  await fs.mkdir(gatewayRoot);
  await fs.mkdir(remoteRoot);
  const bridge: AgentWorkspaceAccess["bridge"] = {
    readFile: ({ filePath }) => fs.readFile(path.join(remoteRoot, filePath)),
    writeFile: async () => {
      throw new Error("Attachment staging must use exclusive creation");
    },
    async createFileExclusive({ filePath, data, mkdir }) {
      const destination = path.join(remoteRoot, filePath);
      if (mkdir) {
        await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      }
      try {
        await fs.writeFile(destination, data, { flag: "wx", mode: 0o600 });
        return "created";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return "exists";
        }
        throw error;
      }
    },
    async stat({ filePath }) {
      try {
        const stat = await fs.stat(path.join(remoteRoot, filePath));
        return {
          type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },
  };
  const release = registerAgentWorkspaceAccess(gatewayRoot, {
    bridge,
    prepareTurnAttachments: createWorkspaceAttachmentPreparer({
      remoteRoot,
      createBridge: () => ({
        readFile: bridge.readFile,
        stat: bridge.stat,
        createFileExclusive: bridge.createFileExclusive!,
      }),
    }),
  });
  return { gatewayRoot, remoteRoot, release };
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
  const request = mocks.fetch.mock.calls[index]?.[0];
  if (!request) {
    throw new Error("Expected a fixture SDK request");
  }
  return new Request(request.url, request.init).json();
}
