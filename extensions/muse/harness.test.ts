import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { onAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  AgentHarnessAttemptParamsV2,
  AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { AuthStorage, ModelRegistry, SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import type * as ExecApprovalsRuntime from "openclaw/plugin-sdk/exec-approvals-runtime";
import { loadUserTurnTranscriptRecorderFactoryForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import type * as ProviderAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import type * as TranscriptRuntime from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMuseAgentHarness, type MuseSessionBinding } from "./harness.js";
import { createApprovalHandler } from "./src/approvals.js";

const writes = vi.hoisted(() => ({
  append: vi.fn(async (params: { messages: unknown[] }) => params.messages),
  publish: vi.fn(async () => undefined),
}));
vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof TranscriptRuntime>()),
  appendSessionTranscriptMessagesByIdentity: writes.append,
  publishSessionTranscriptUpdateByIdentity: writes.publish,
}));
const auth = vi.hoisted(() => ({ resolve: vi.fn(async () => ({ apiKey: "profile-key" })) }));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof ProviderAuthRuntime>()),
  resolveApiKeyForProvider: auth.resolve,
}));
const approvals = vi.hoisted(() => ({
  load: vi.fn<typeof ExecApprovalsRuntime.loadExecApprovalsReadOnlyAsync>(),
}));
vi.mock("openclaw/plugin-sdk/exec-approvals-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof ExecApprovalsRuntime>()),
  loadExecApprovalsReadOnlyAsync: approvals.load,
}));
const readHistory = vi.spyOn(SessionManager, "openModelContextAsync");
beforeEach(() => {
  approvals.load.mockResolvedValue({ version: 1, agents: {} });
  readHistory.mockResolvedValue(SessionManager.inMemory());
  vi.stubEnv("OPENCLAW_STATE_DIR", join(workspace, "state"));
});

let workspace: string;
const fixture = fileURLToPath(new URL("./src/test-support/fake-muse.mjs", import.meta.url));
beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "muse-harness-test-"));
});
afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function setup() {
  vi.stubEnv("OPENCLAW_STATE_DIR", join(workspace, "state"));
  const bindings = new Map<string, MuseSessionBinding>();
  const sessionStore = {
    lookup: async (key: string) => bindings.get(key),
    register: async (key: string, value: MuseSessionBinding) => {
      bindings.set(key, value);
    },
    delete: async (key: string) => {
      return bindings.delete(key);
    },
  };
  const harness = createMuseAgentHarness({ binaryPath: fixture, sessionStore });
  const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
  const authStorage = AuthStorage.inMemory();
  const params: AgentHarnessAttemptParamsV2 = {
    runId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    sessionKey: "agent:main:muse-test",
    workspaceDir: workspace,
    agentDir: workspace,
    provider: "meta",
    modelId: "muse-spark-1.3",
    model: {
      id: "muse-spark-1.3",
      name: "Muse Spark",
      provider: "meta",
      api: "openai-responses",
      baseUrl: "https://api.meta.ai/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
    },
    authStorage,
    modelRegistry: ModelRegistry.inMemory(authStorage),
    thinkLevel: "off",
    sessionFile: join(workspace, "session.jsonl"),
    timeoutMs: 10_000,
    prompt: "hello",
    sessionTarget: {
      sessionId: "transcript-id",
      sessionKey: "agent:main:muse-test",
      storePath: join(workspace, "sessions.json"),
    },
    authProfileStore: { version: 1, profiles: {} },
    onAgentEvent: async (event: { stream: string; data: Record<string, unknown> }) => {
      events.push(event);
    },
    hostCapabilities: {
      kind: "agent-harness-host-capability",
      version: 1,
      assertActive: () => undefined,
      bindToolSurface: (tools) => tools,
      runBeforeToolCall: async (request) => ({ blocked: false, params: request.params }),
      requestApproval: vi.fn(async () => ({ decision: "allow-once" as const })),
      waitForApproval: vi.fn(async () => undefined),
    },
  };
  return { harness, params, events, sessionStore, bindings };
}

function terminal(result: AgentHarnessAttemptResult) {
  if (!("terminal" in result)) {
    throw new Error("Muse must return a canonical attempt terminal.");
  }
  return result.terminal;
}

describe("Muse native MSP harness", () => {
  it.each([
    ["catalog default endpoint", { endpointOverrides: "none" }, true],
    [
      "official endpoint reported as authored",
      { endpointOverrides: "present", baseUrl: "https://api.meta.ai/v1/" },
      true,
    ],
    [
      "custom endpoint",
      { endpointOverrides: "present", baseUrl: "https://proxy.example/v1" },
      false,
    ],
    ["request transport overrides", { requestTransportOverrides: "present" }, false],
  ] as const)("routes meta models with %s", (_name, modelProvider, supported) => {
    const { harness } = setup();
    expect(
      harness.supports({
        provider: "meta",
        modelId: "muse-spark-1.3",
        requestedRuntime: "muse",
        modelProvider,
      }).supported,
    ).toBe(supported);
  });

  it("streams reasoning and text, journals native tool pairs, and resumes after restart", async () => {
    const first = setup();
    const globalEvents: Array<{ stream: string; data: Record<string, unknown> }> = [];
    const unsubscribe = onAgentEvent((event) => void globalEvents.push(event));
    try {
      const result = await first.harness.runAttempt({ ...first.params, prompt: "tool" });
      expect(terminal(result).kind).toBe("ok");
      expect(result.assistantTexts).toEqual(["started: hello"]);
      for (const events of [first.events, globalEvents]) {
        expect(
          events
            .filter((event) => event.stream === "assistant")
            .map((event) => event.data.delta)
            .join(""),
        ).toBe("started: hello");
      }
      expect(globalEvents.at(0)?.data.phase).toBe("start");
      expect(globalEvents.at(-1)?.data.phase).toBe("end");
      expect(result.messagesSnapshot.map((message) => message.role)).toEqual([
        "assistant",
        "assistant",
        "toolResult",
        "assistant",
      ]);
      expect(result.toolMetas).toEqual([{ toolName: "read_file" }]);
      expect(writes.append).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              message: expect.objectContaining({ role: "toolResult", toolCallId: "call-1" }),
            }),
          ]),
        }),
      );
    } finally {
      unsubscribe();
      await first.harness.dispose?.();
    }
    const resumed = createMuseAgentHarness({
      binaryPath: fixture,
      sessionStore: first.sessionStore,
    });
    try {
      const result = await resumed.runAttempt(first.params);
      expect(terminal(result).kind).toBe("ok");
      expect(result.assistantTexts).toEqual(["resumed: hello"]);
      const changed = await resumed.runAttempt({ ...first.params, modelId: "muse-other" });
      expect(changed.assistantTexts).toEqual(["started: hello"]);
    } finally {
      await resumed.dispose?.();
    }
  });

  it.each([
    ["global mode", { config: { tools: { exec: { mode: "deny" } } } }],
    ["override mode", { execOverrides: { mode: "deny" } }],
    [
      "agent policy",
      {
        config: {
          tools: { exec: { mode: "full" } },
          agents: { entries: { main: { tools: { exec: { mode: "deny" } } } } },
        },
      },
    ],
  ] satisfies Array<[string, Partial<AgentHarnessAttemptParamsV2>]>)(
    "launches a read-only host for %s",
    async (_name, policy) => {
      const { harness, params } = setup();
      const log = join(workspace, `${params.runId}.jsonl`);
      vi.stubEnv("MUSE_REQUEST_LOG", log);
      try {
        await harness.runAttempt({ ...params, ...policy });
        const requests = (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(requests).toContainEqual(
          expect.objectContaining({
            event: "spawn",
            args: ["serve", "--disable-shell", "--disable-write"],
          }),
        );
        expect(requests).toContainEqual(
          expect.objectContaining({
            method: "session/start",
            params: expect.objectContaining({ approvalMode: "denyUnmatched" }),
          }),
        );
      } finally {
        await harness.dispose?.();
        vi.unstubAllEnvs();
      }
    },
  );

  it.each(["defaults", "agent"] as const)(
    "applies host approval %s security floors before launching Muse",
    async (scope) => {
      const { harness, params } = setup();
      const log = join(workspace, `${params.runId}.jsonl`);
      approvals.load.mockResolvedValue(
        scope === "defaults"
          ? { version: 1, defaults: { security: "deny" } }
          : { version: 1, agents: { main: { security: "deny" } } },
      );
      vi.stubEnv("MUSE_REQUEST_LOG", log);
      try {
        await harness.runAttempt({
          ...params,
          config: { tools: { exec: { mode: "full" } } },
        });
        expect(await readFile(log, "utf8")).toContain(
          '"args":["serve","--disable-shell","--disable-write"]',
        );
      } finally {
        await harness.dispose?.();
        vi.unstubAllEnvs();
      }
    },
  );

  it("refuses host ask-always floors even when config grants full exec", async () => {
    const { harness, params } = setup();
    approvals.load.mockResolvedValue({ version: 1, defaults: { ask: "always" } });
    try {
      await expect(
        harness.runAttempt({ ...params, config: { tools: { exec: { mode: "full" } } } }),
      ).rejects.toThrow("ask: always");
    } finally {
      await harness.dispose?.();
    }
  });

  it("allows explicit full-session elevation to bypass host floors", async () => {
    const { harness, params } = setup();
    const log = join(workspace, `${params.runId}.jsonl`);
    approvals.load.mockResolvedValue({ version: 1, defaults: { security: "deny" } });
    vi.stubEnv("MUSE_REQUEST_LOG", log);
    try {
      await harness.runAttempt({ ...params, permissionMode: "full" });
      expect(await readFile(log, "utf8")).toContain('"approvalMode":"allowAll"');
    } finally {
      await harness.dispose?.();
      vi.unstubAllEnvs();
    }
  });

  it.each(["model change", "missing binding", "refused resume"] as const)(
    "restores retained history when a %s starts a fresh session",
    async (replacement) => {
      const { harness, params, bindings } = setup();
      const log = join(workspace, `${params.runId}.jsonl`);
      const retained = SessionManager.inMemory();
      readHistory.mockResolvedValue(retained);
      vi.stubEnv("MUSE_REQUEST_LOG", log);
      try {
        await harness.runAttempt({ ...params, prompt: "My project codename is Cedar." });
        await retained.appendMessageAsync({
          role: "user",
          content: "My project codename is Cedar.",
          timestamp: 1,
        });
        await harness.runAttempt({ ...params, prompt: "Remember that for later." });
        await retained.appendMessageAsync({
          role: "user",
          content: "Remember that for later.",
          timestamp: 2,
        });
        if (replacement === "missing binding") {
          bindings.delete(params.sessionId);
        } else if (replacement === "refused resume") {
          const binding = bindings.get(params.sessionId);
          if (!binding) {
            throw new Error("Missing first-turn binding");
          }
          bindings.set(params.sessionId, { ...binding, sessionId: "missing-session" });
        }
        await harness.runAttempt({
          ...params,
          modelId: replacement === "model change" ? "muse-other" : params.modelId,
          prompt: "What is its codename?",
        });
        const turns = (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter((request) => request.method === "turn/start");
        expect(turns).toHaveLength(3);
        expect(turns[1].params.input[0].text).not.toContain("Cedar");
        expect(turns[2].params.input[0].text).toContain("My project codename is Cedar.");
        expect(turns[2].params.input[0].text).toContain("Remember that for later.");
        expect(turns[2].params.input[0].text).toContain("What is its codename?");
      } finally {
        await harness.dispose?.();
        vi.unstubAllEnvs();
      }
    },
  );

  it("includes workspace bootstrap files only on the first turn of a native session", async () => {
    const { harness, params } = setup();
    const bootstrapWorkspace = await mkdtemp(join(workspace, "bootstrap-"));
    await writeFile(join(bootstrapWorkspace, "SOUL.md"), "Speak like a patient astronomer.");
    const log = join(workspace, `${params.runId}.jsonl`);
    vi.stubEnv("MUSE_REQUEST_LOG", log);
    try {
      await harness.runAttempt({ ...params, workspaceDir: bootstrapWorkspace });
      await harness.runAttempt({ ...params, workspaceDir: bootstrapWorkspace, prompt: "next" });
      const turns = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((request) => request.method === "turn/start");
      expect(turns).toHaveLength(2);
      expect(turns[0].params.input[0].text).toContain("Speak like a patient astronomer.");
      expect(turns[1].params.input[0].text).toBe("next");
    } finally {
      await harness.dispose?.();
      vi.unstubAllEnvs();
    }
  });

  it("reseeds context on the next turn when the first turn never reached Muse", async () => {
    const { harness, params, bindings } = setup();
    const bootstrapWorkspace = await mkdtemp(join(workspace, "bootstrap-retry-"));
    await writeFile(join(bootstrapWorkspace, "SOUL.md"), "Speak like a patient astronomer.");
    const log = join(workspace, `${params.runId}.jsonl`);
    vi.stubEnv("MUSE_REQUEST_LOG", log);
    try {
      // Abort during transcript admission: after the session opened, before Muse got the turn.
      const controller = new AbortController();
      const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
      const recorder = createRecorder({
        input: { text: params.prompt, idempotencyKey: `${params.runId}:user` },
        target: {
          agentId: "main",
          sessionId: "transcript-id",
          sessionKey: "agent:main:muse-test",
          storePath: join(workspace, "sessions.json"),
          sessionEntry: undefined,
        },
      });
      const aborted = await harness.runAttempt({
        ...params,
        workspaceDir: bootstrapWorkspace,
        abortSignal: controller.signal,
        userTurnTranscriptRecorder: {
          ...recorder,
          persistApproved: async () => {
            controller.abort();
            return undefined;
          },
        },
      });
      expect(terminal(aborted).kind).toBe("aborted");
      expect(bindings.has(params.sessionId)).toBe(false);
      await harness.runAttempt({ ...params, workspaceDir: bootstrapWorkspace, prompt: "next" });
      const turns = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((request) => request.method === "turn/start");
      expect(turns).toHaveLength(1);
      expect(turns[0].params.input[0].text).toContain("Speak like a patient astronomer.");
    } finally {
      await harness.dispose?.();
      vi.unstubAllEnvs();
    }
  });

  it("fails visibly without dispatching a turn when retained context cannot be read", async () => {
    const { harness, params, bindings } = setup();
    const log = join(workspace, `${params.runId}.jsonl`);
    readHistory.mockRejectedValueOnce(new Error("Session context limit exceeded"));
    vi.stubEnv("MUSE_REQUEST_LOG", log);
    try {
      const result = await harness.runAttempt(params);
      expect(terminal(result)).toMatchObject({
        kind: "failed",
        error: expect.objectContaining({
          message: expect.stringContaining("could not restore OpenClaw session context"),
        }),
      });
      expect(await readFile(log, "utf8")).not.toContain('"method":"turn/start"');
      expect(bindings.has(params.sessionId)).toBe(false);
    } finally {
      await harness.dispose?.();
      vi.unstubAllEnvs();
    }
  });

  it("forwards prepared images to the native turn", async () => {
    const { harness, params } = setup();
    const log = join(workspace, `${params.runId}.jsonl`);
    vi.stubEnv("MUSE_REQUEST_LOG", log);
    try {
      await harness.runAttempt({
        ...params,
        images: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
      });
      const requests = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(requests).toContainEqual(
        expect.objectContaining({
          method: "turn/start",
          params: expect.objectContaining({
            input: [
              { type: "text", text: "hello" },
              { type: "image", mediaType: "image/png", base64Data: "aW1hZ2U=" },
            ],
          }),
        }),
      );
    } finally {
      await harness.dispose?.();
      vi.unstubAllEnvs();
    }
  });

  it("runs a consented turn whose conversation tool policy is restricted", async () => {
    const { harness, params } = setup();
    const log = join(workspace, `${params.runId}.jsonl`);
    vi.stubEnv("MUSE_REQUEST_LOG", log);
    try {
      await harness.runAttempt({ ...params, pluginHarnessToolPolicyRestricted: true });
      const requests = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(requests.map((request) => request.method)).toContain("turn/start");
    } finally {
      await harness.dispose?.();
      vi.unstubAllEnvs();
    }
  });

  it("returns the terminal observer's unresolved native tool error", async () => {
    const { harness, params } = setup();
    const lastToolError = { toolName: "read_file", error: "file unavailable" };
    const observeToolTerminal = vi.fn<
      NonNullable<AgentHarnessAttemptParamsV2["observeToolTerminal"]>
    >(() => ({
      lastToolError,
      executionStarted: true,
      sideEffectEvidence: false,
      effectReceipt: { state: "failed_no_effect" },
    }));
    try {
      const result = await harness.runAttempt({
        ...params,
        prompt: "tool-failure",
        observeToolTerminal,
      });
      expect(observeToolTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "failure" }),
      );
      expect(terminal(result).kind).toBe("ok");
      expect(result.lastToolError).toEqual(lastToolError);
    } finally {
      await harness.dispose?.();
    }
  });

  it.each(["callback", "transcript", "abort", "timeout", "approval"] as const)(
    "waits for native settlement after %s interruption",
    async (failure) => {
      const { harness, params } = setup();
      const log = join(workspace, `${params.runId}.jsonl`);
      vi.stubEnv("MUSE_REQUEST_LOG", log);
      const controller = new AbortController();
      if (failure === "transcript") {
        writes.append.mockRejectedValueOnce(new Error("transcript unavailable"));
      }
      if (failure === "approval") {
        params.hostCapabilities = {
          ...params.hostCapabilities,
          requestApproval: async () => {
            throw new Error("approval gateway unavailable");
          },
        };
      }
      try {
        const result = await harness.runAttempt({
          ...params,
          prompt: failure === "approval" ? "approval-settle" : "settle",
          timeoutMs: failure === "timeout" ? 150 : params.timeoutMs,
          abortSignal: controller.signal,
          onExecutionStarted: () => {
            if (failure === "callback") {
              throw new Error("callback failed");
            }
            if (failure === "abort") {
              controller.abort();
            }
          },
        });
        expect(terminal(result).kind).toBe(
          failure === "abort" ? "aborted" : failure === "timeout" ? "timeout" : "failed",
        );
        expect(await readFile(log, "utf8")).toContain('"event":"terminal","terminal":"cancelled"');
      } finally {
        await harness.dispose?.();
        vi.unstubAllEnvs();
      }
    },
  );

  it.each([true, false])(
    "invalidates context only after a committed history mutation (%s)",
    async (commit) => {
      const { harness, params, bindings, sessionStore } = setup();
      try {
        await harness.runAttempt(params);
        const reset = harness.withSessionContextReset!;
        const operation = reset(
          {
            agentId: "main",
            sessionId: params.sessionId,
            sessionKey: params.sessionKey!,
            assertCurrent: () => undefined,
          },
          async (mutation) => {
            if (!commit) {
              throw new Error("history mutation failed");
            }
            mutation.commit();
            return "committed";
          },
        );
        if (commit) {
          await expect(operation).resolves.toBe("committed");
          expect(bindings.has(params.sessionId)).toBe(false);
        } else {
          await expect(operation).rejects.toThrow("history mutation failed");
          expect(bindings.has(params.sessionId)).toBe(true);
        }
        await harness.dispose?.();
        const restarted = createMuseAgentHarness({ binaryPath: fixture, sessionStore });
        try {
          const next = await restarted.runAttempt(params);
          expect(next.assistantTexts).toEqual([commit ? "started: hello" : "resumed: hello"]);
        } finally {
          await restarted.dispose?.();
        }
      } finally {
        await harness.dispose?.();
      }
    },
  );

  it.each([
    ["off", "minimal"],
    ["low", "low"],
    ["high", "high"],
  ] as const)("sends the Meta-compatible reasoning effort for %s", async (thinkLevel, expected) => {
    const { harness, params } = setup();
    try {
      const result = await harness.runAttempt({ ...params, prompt: "effort", thinkLevel });
      expect(result.assistantTexts).toEqual([`effort:${expected}`]);
    } finally {
      await harness.dispose?.();
    }
  });

  it("does not retire a shared host when another attempt aborts before turn dispatch", async () => {
    const state = setup();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const secondId = crypto.randomUUID();
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = state.harness.runAttempt({
      ...state.params,
      prompt: "wait",
      abortSignal: firstController.signal,
      onExecutionStarted: started,
    });
    try {
      await firstStarted;
      readHistory.mockImplementationOnce(async () => {
        // Abort after the shared host and session open, before the turn is dispatched.
        secondController.abort();
        return SessionManager.inMemory();
      });
      const second = await state.harness.runAttempt({
        ...state.params,
        sessionId: secondId,
        sessionKey: "agent:main:second-muse",
        abortSignal: secondController.signal,
      });
      expect(terminal(second).kind).toBe("aborted");
      firstController.abort();
      const result = await first;
      expect(terminal(result)).toMatchObject({ kind: "aborted" });
      expect(terminal(result)).not.toHaveProperty("failure");
    } finally {
      firstController.abort();
      await first;
      await state.harness.dispose?.();
    }
  });

  it("routes approvals through the host and submits the offered server choice", async () => {
    const { harness, params } = setup();
    try {
      const result = await harness.runAttempt({ ...params, prompt: "approval" });
      expect(params.hostCapabilities.requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: "shell", allowedDecisions: ["allow-once", "deny"] }),
      );
      expect(terminal(result).kind).toBe("ok");
      expect(result.assistantTexts).toEqual(["started: hello"]);
    } finally {
      await harness.dispose?.();
    }
  });

  it("interrupts the real MSP transport when the caller aborts", async () => {
    const { harness, params } = setup();
    const controller = new AbortController();
    const onExecutionStarted = vi.fn(() => controller.abort());
    try {
      const result = await harness.runAttempt({
        ...params,
        prompt: "wait",
        abortSignal: controller.signal,
        onExecutionStarted,
      });
      expect(terminal(result).kind).toBe("aborted");
    } finally {
      await harness.dispose?.();
    }
  });

  it.each([
    ["fail", "fixture provider rejected authentication"],
    ["crash", "fixture: provider process crashed"],
  ])("surfaces %s failures without hanging", async (prompt, expected) => {
    const { harness, params } = setup();
    try {
      const result = await harness.runAttempt({ ...params, prompt });
      expect(terminal(result)).toMatchObject({
        kind: "failed",
        error: expect.objectContaining({ message: expect.stringContaining(expected) }),
      });
      expect(result.replayMetadata?.replaySafe).toBe(false);
    } finally {
      await harness.dispose?.();
    }
  });

  it.each([
    ["missing", "missing-session"],
    ["refused", "refused-session"],
  ])(
    "starts a new native session when Muse definitively refuses a %s resume",
    async (_name, id) => {
      const state = setup();
      try {
        await state.harness.runAttempt(state.params);
      } finally {
        await state.harness.dispose?.();
      }
      const binding = state.bindings.get(state.params.sessionId)!;
      state.bindings.set(state.params.sessionId, { ...binding, sessionId: id });
      const warn = vi.fn();
      const next = createMuseAgentHarness({
        binaryPath: fixture,
        sessionStore: state.sessionStore,
        logger: { warn },
      });
      try {
        const result = await next.runAttempt(state.params);
        expect(terminal(result).kind).toBe("ok");
        expect(result.assistantTexts).toEqual(["started: hello"]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("started a new Muse session"));
      } finally {
        await next.dispose?.();
      }
    },
  );

  it("does not replace a session that is in use elsewhere", async () => {
    const state = setup();
    try {
      await state.harness.runAttempt(state.params);
    } finally {
      await state.harness.dispose?.();
    }
    const binding = state.bindings.get(state.params.sessionId)!;
    state.bindings.set(state.params.sessionId, { ...binding, sessionId: "busy-session" });
    const next = createMuseAgentHarness({ binaryPath: fixture, sessionStore: state.sessionStore });
    try {
      const result = await next.runAttempt(state.params);
      expect(terminal(result)).toMatchObject({
        kind: "failed",
        error: expect.objectContaining({ message: expect.stringContaining("sessionInUse") }),
      });
      expect(state.bindings.get(state.params.sessionId)?.sessionId).toBe("busy-session");
    } finally {
      await next.dispose?.();
    }
  });

  it("denies native approval when the host denies it", async () => {
    const { harness, params } = setup();
    params.hostCapabilities = {
      ...params.hostCapabilities,
      requestApproval: async () => ({ decision: "deny" }),
    };
    try {
      const result = await harness.runAttempt({ ...params, prompt: "approval" });
      expect(terminal(result)).toMatchObject({
        kind: "failed",
        error: expect.objectContaining({ message: expect.stringContaining("denied") }),
      });
      expect(result.assistantTexts).toEqual([]);
    } finally {
      await harness.dispose?.();
    }
  });

  it("reports an approval transport failure as the turn error, not an abort", async () => {
    const { harness, params } = setup();
    params.hostCapabilities = {
      ...params.hostCapabilities,
      requestApproval: async () => {
        throw new Error("approval gateway unavailable");
      },
    };
    try {
      const result = await harness.runAttempt({ ...params, prompt: "approval" });
      expect(terminal(result)).toMatchObject({
        kind: "failed",
        error: expect.objectContaining({
          message: expect.stringContaining("approval gateway unavailable"),
        }),
      });
    } finally {
      await harness.dispose?.();
    }
  });

  it("explains a missing Muse sign-in and logs it for operators", async () => {
    const { params, sessionStore } = setup();
    const warn = vi.fn();
    const harness = createMuseAgentHarness({ binaryPath: fixture, sessionStore, logger: { warn } });
    try {
      const result = await harness.runAttempt({ ...params, prompt: "loggedout" });
      expect(terminal(result)).toMatchObject({
        kind: "failed",
        error: expect.objectContaining({ message: expect.stringContaining("muse login") }),
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Muse Code is not signed in on the Gateway host"),
      );
    } finally {
      await harness.dispose?.();
    }
  });

  it("treats an unlimited Gateway budget as no deadline and bounds the approval wait", async () => {
    const { harness, params } = setup();
    try {
      const result = await harness.runAttempt({
        ...params,
        prompt: "approval",
        timeoutMs: 2 ** 31,
      });
      expect(terminal(result)).toMatchObject({ kind: "ok" });
      expect(params.hostCapabilities.requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 120_000 }),
      );
    } finally {
      await harness.dispose?.();
    }
  });

  it("keeps prepared credentials ahead of profile, environment, and CLI login", async () => {
    const { harness, params } = setup();
    const log = join(workspace, `${params.runId}.jsonl`);
    vi.stubEnv("META_API_KEY", "ambient-meta");
    vi.stubEnv("MUSE_NO_AUTO_UPDATE", "0");
    vi.stubEnv("MUSE_REQUEST_LOG", log);
    try {
      const prepared = await harness.runAttempt({
        ...params,
        prompt: "credential",
        resolvedApiKey: "prepared-key",
        authProfileId: "meta:test",
      });
      expect(prepared.assistantTexts).toEqual(["credential:prepared-key"]);
      const profile = await harness.runAttempt({
        ...params,
        prompt: "credential",
        authProfileId: "meta:test",
      });
      expect(profile.assistantTexts).toEqual(["credential:profile-key"]);
      const ambient = await harness.runAttempt({ ...params, prompt: "credential" });
      expect(ambient.assistantTexts).toEqual(["credential:ambient-meta"]);
      const spawns = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((request) => request.event === "spawn");
      expect(spawns).not.toHaveLength(0);
      expect(spawns.every((request) => request.noAutoUpdate === "1")).toBe(true);
    } finally {
      await harness.dispose?.();
      vi.unstubAllEnvs();
    }
    const login = setup();
    vi.stubEnv("META_API_KEY", undefined);
    try {
      const result = await login.harness.runAttempt({ ...login.params, prompt: "credential" });
      expect(result.assistantTexts).toEqual(["credential:cli-login"]);
    } finally {
      await login.harness.dispose?.();
      vi.unstubAllEnvs();
    }
  });

  it.runIf(process.platform !== "win32")(
    "verifies native catalogs on inherited PATH without a workspace, and rejects bundled fallback",
    async () => {
      const { harness, params } = setup();
      const log = join(workspace, `${params.runId}.jsonl`);
      await writeFile(
        join(workspace, "muse"),
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"\n`,
        { mode: 0o755 },
      );
      const stateDir = join(workspace, "catalog-state");
      await mkdir(join(stateDir, "muse", "muse"), { recursive: true });
      await writeFile(join(stateDir, "muse", "muse", "auth.json"), "{}");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      vi.stubEnv("PATH", `${workspace}${delimiter}${process.env.PATH ?? ""}`);
      vi.stubEnv("MUSE_REQUEST_LOG", log);
      vi.stubEnv("MUSE_FIXTURE_CATALOG_SOURCE", "providerCatalog");
      const scope = {
        config: { plugins: { entries: { muse: { config: { binaryPath: "muse" } } } } },
        agentId: "main",
        agentDir: workspace,
        workspaceDir: join(workspace, "absent"),
      };
      const verification = {
        ...scope,
        provider: "meta",
        modelId: "muse-spark-1.3",
        signal: new AbortController().signal,
        assertCurrent: () => {},
      };
      if (!harness.verifySetup || !harness.loadModelCatalog || !harness.readModelCatalogReadiness) {
        throw new Error("Muse must own its catalog readiness and setup verification");
      }
      try {
        await harness.verifySetup(verification);
        await harness.verifySetup(verification);
        await harness.loadModelCatalog(scope);
        expect(harness.readModelCatalogReadiness(verification)).toEqual({ accountType: "native" });
        const initialRequests = (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(initialRequests.filter((request) => request.event === "spawn")).toHaveLength(1);
        expect(initialRequests.filter((request) => request.method === "model/list")).toHaveLength(
          3,
        );
        vi.stubEnv("MUSE_FIXTURE_CATALOG_SOURCE", "bundledCatalog");
        await writeFile(join(stateDir, "muse", "muse", "auth.json"), '{"changed":true}');
        await expect(harness.verifySetup(verification)).rejects.toThrow("authenticate");
        await expect(harness.loadModelCatalog(scope)).rejects.toThrow("authenticate");
        expect(harness.readModelCatalogReadiness(verification)).toBeUndefined();
        const requests = (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(requests[0]).toMatchObject({
          path: process.env.PATH,
          credentialBackend: "file",
          configHome: join(stateDir, "muse"),
        });
        expect(requests.map((request) => request.method)).not.toContain("turn/start");
        expect(requests.map((request) => request.method)).not.toContain("session/start");
      } finally {
        await harness.dispose?.();
        vi.unstubAllEnvs();
      }
    },
  );

  it("rejects sandbox and workspace-only attempts before starting native work", async () => {
    const { harness, params, bindings } = setup();
    try {
      await expect(harness.runAttempt({ ...params, requireWorkspaceOnly: true })).rejects.toThrow(
        "cannot enforce",
      );
      await expect(
        harness.runAttempt({ ...params, execOverrides: { ask: "always" } }),
      ).rejects.toThrow("exec ask: always");
      await expect(harness.runAttempt({ ...params, thinkLevel: "adaptive" })).rejects.toThrow(
        "does not support adaptive reasoning",
      );
      expect(bindings.size).toBe(0);
    } finally {
      await harness.dispose?.();
    }
  });

  it("starts fresh sessions when managed auth appears, changes, or disappears", async () => {
    const { harness, params, bindings } = setup();
    const stateDir = await mkdtemp(join(workspace, "session-auth-"));
    const authDir = join(stateDir, "muse", "muse");
    const authFile = join(authDir, "auth.json");
    const log = join(stateDir, "requests.jsonl");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("META_API_KEY", undefined);
    vi.stubEnv("MUSE_REQUEST_LOG", log);
    try {
      const native = await harness.runAttempt(params);
      expect(terminal(native).kind).toBe("ok");
      const identities = [bindings.get(params.sessionId)];
      await mkdir(authDir, { recursive: true });
      await writeFile(authFile, '{"account":"managed"}');
      const managed = await harness.runAttempt(params);
      expect(terminal(managed).kind).toBe("ok");
      identities.push(bindings.get(params.sessionId));
      await writeFile(authFile, '{"account":"replacement-account"}');
      const changed = await harness.runAttempt(params);
      expect(terminal(changed).kind).toBe("ok");
      identities.push(bindings.get(params.sessionId));
      await rm(authFile);
      const restored = await harness.runAttempt(params);
      expect(terminal(restored).kind).toBe("ok");
      identities.push(bindings.get(params.sessionId));
      expect(identities.every((binding) => binding !== undefined)).toBe(true);
      expect(new Set(identities.map((binding) => binding?.sessionId)).size).toBe(4);
      expect(identities[1]?.compatibility).not.toBe(identities[0]?.compatibility);
      expect(identities[2]?.compatibility).not.toBe(identities[1]?.compatibility);
      expect(identities[3]?.compatibility).not.toBe(identities[2]?.compatibility);
      const requests = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(requests.filter((request) => request.method === "session/start")).toHaveLength(4);
      expect(requests.filter((request) => request.method === "session/resume")).toHaveLength(0);
    } finally {
      await harness.dispose?.();
      vi.unstubAllEnvs();
    }
  });

  it("fails closed rather than minting approval choices", async () => {
    const { params } = setup();
    const requestApproval = vi
      .fn<typeof params.hostCapabilities.requestApproval>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ decision: "allow-once" });
    const handler = createApprovalHandler({
      ...params,
      hostCapabilities: { ...params.hostCapabilities, requestApproval },
    });
    const request: Parameters<typeof handler>[0] = {
      approvalId: "approval-1",
      availableChoices: [
        { choiceId: "server-only", decision: "denied", scope: "once", label: "Deny" },
      ],
      currentRequirementId: { approvalId: "approval-1", sourceIndex: 0 },
      itemId: "item-1",
      judgeEscalated: false,
      protectedWrite: false,
      rawArgs: '{"command":"pwd"}',
      sessionId: "session-1",
      sourceRange: {
        first: { id: "event-1", sequence: 1 },
        last: { id: "event-1", sequence: 1 },
        stream: { id: "session-1", kind: "session" },
      },
      subject: { kind: "shell", command: "pwd" },
      taskId: "task-1",
      toolCallId: "call-1",
      toolName: "shell",
      turnId: "turn-1",
      viewCursor: "1",
    };
    await expect(handler(request)).resolves.toEqual({ choiceId: "server-only" });
    await expect(handler(request)).rejects.toThrow("no safe approved approval choice");
  });
});
