import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  onAgentEvent,
  type AgentHarnessAttemptParamsV2,
  type AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { AuthStorage, ModelRegistry, SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import type * as ExecApprovalsRuntime from "openclaw/plugin-sdk/exec-approvals-runtime";
import {
  loadUserTurnTranscriptRecorderFactoryForTest,
  runInHarnessToolAuthorityForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type * as ProviderAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import type * as TranscriptRuntime from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMuseAgentHarness as createMuseAgentHarnessImpl,
  type MuseSessionBinding,
} from "./harness.js";

const writes = vi.hoisted(() => ({
  append: vi.fn(async (params: { messages: unknown[] }) => params.messages),
  publish: vi.fn(async () => undefined),
}));
vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof TranscriptRuntime>()),
  appendSessionTranscriptMessagesByIdentity: writes.append,
  publishSessionTranscriptUpdateByIdentity: writes.publish,
}));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof ProviderAuthRuntime>()),
  resolveApiKeyForProvider: vi.fn(async () => ({ apiKey: "profile-key" })),
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
});

let workspace: string;
const fixture = fileURLToPath(new URL("./src/test-support/fake-muse.mjs", import.meta.url));
beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "muse-harness-test-"));
});
afterAll(() => rm(workspace, { recursive: true, force: true }));

const harnesses = new Set<ReturnType<typeof createMuseAgentHarnessImpl>>();
afterEach(async () => {
  try {
    await Promise.all([...harnesses].map((harness) => harness.dispose?.()));
  } finally {
    harnesses.clear();
    vi.unstubAllEnvs();
  }
});

function createMuseAgentHarness(...args: Parameters<typeof createMuseAgentHarnessImpl>) {
  const harness = createMuseAgentHarnessImpl(...args);
  harnesses.add(harness);
  return {
    ...harness,
    dispose: async () => {
      harnesses.delete(harness);
      await harness.dispose?.();
    },
    runAttempt: (params: AgentHarnessAttemptParamsV2) =>
      runInHarnessToolAuthorityForTest(params, "muse", (admitted) => harness.runAttempt(admitted)),
  };
}

function setup(logRequests = false) {
  vi.stubEnv("OPENCLAW_STATE_DIR", join(workspace, "state"));
  const bindings = new Map<string, MuseSessionBinding>();
  const sessionStore = {
    lookup: async (key: string) => bindings.get(key),
    register: async (key: string, value: MuseSessionBinding) => {
      bindings.set(key, value);
    },
    delete: async (key: string) => bindings.delete(key),
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
    onAgentEvent: async (event) => void events.push(event),
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
  const log = join(workspace, `${params.runId}.jsonl`);
  if (logRequests) {
    vi.stubEnv("MUSE_REQUEST_LOG", log);
  }
  const run = (overrides?: Partial<AgentHarnessAttemptParamsV2>) =>
    harness.runAttempt(overrides ? { ...params, ...overrides } : params);
  const restart = async (logger?: Parameters<typeof createMuseAgentHarness>[0]["logger"]) => {
    await harness.dispose();
    return createMuseAgentHarness({ binaryPath: fixture, sessionStore, logger });
  };
  return { harness, params, events, sessionStore, bindings, log, run, restart };
}

async function readRequests(log: string, method?: string) {
  const requests = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return method ? requests.filter((request) => request.method === method) : requests;
}

function expectFailure(result: AgentHarnessAttemptResult, message: string) {
  expect(terminal(result)).toMatchObject({
    kind: "failed",
    error: expect.objectContaining({ message: expect.stringContaining(message) }),
  });
}

function terminal(result: AgentHarnessAttemptResult) {
  if (!("terminal" in result)) {
    throw new Error("Muse must return a canonical attempt terminal.");
  }
  return result.terminal;
}

const fullExec = { tools: { exec: { mode: "full" as const } } };

describe("Muse native MSP harness", () => {
  it.each([
    [{ endpointOverrides: "none" }, true],
    [{ endpointOverrides: "present", baseUrl: "https://api.meta.ai/v1/" }, true],
    [{ endpointOverrides: "present", baseUrl: "https://proxy.example/v1" }, false],
    [{ requestTransportOverrides: "present" }, false],
  ] as const)("routes meta models with %j", (modelProvider, supported) => {
    const { harness } = setup();
    expect(
      harness.supports({
        provider: "meta",
        requestedRuntime: "muse",
        modelProvider,
      }).supported,
    ).toBe(supported);
  });

  it.each([
    ["global mode", { config: { tools: { exec: { mode: "deny" } } } }],
    ["override mode", { execOverrides: { mode: "deny" } }],
    [
      "agent policy",
      {
        config: {
          ...fullExec,
          agents: { entries: { main: { tools: { exec: { mode: "deny" } } } } },
        },
      },
    ],
    ["host defaults", { config: fullExec }, { version: 1, defaults: { security: "deny" } }],
    ["host agent", { config: fullExec }, { version: 1, agents: { main: { security: "deny" } } }],
  ] satisfies Array<
    [string, Partial<AgentHarnessAttemptParamsV2>, Awaited<ReturnType<typeof approvals.load>>?]
  >)("launches a read-only host for %s", async (_name, policy, floors) => {
    const { run, log } = setup(true);
    if (floors) {
      approvals.load.mockResolvedValue(floors);
    }
    await run(policy);
    const requests = await readRequests(log);
    const spawn = requests.find((request) => request.event === "spawn");
    expect(spawn?.args).toEqual(["serve", "--disable-shell", "--disable-write"]);
    expect(requests.find((request) => request.method === "session/start")?.params).toMatchObject({
      approvalMode: "denyUnmatched",
    });
  });

  it("allows explicit full-session elevation to bypass host floors", async () => {
    const { run, log } = setup(true);
    approvals.load.mockResolvedValue({ version: 1, defaults: { security: "deny" } });

    await run({ permissionMode: "full" });
    expect(await readFile(log, "utf8")).toContain('"approvalMode":"allowAll"');
  });

  it.each([
    "model change",
    "missing binding",
    "missing-session",
    "refused-session",
    "busy-session",
  ])("restores history or rejects a busy session: %s", async (replacement) => {
    const { params, bindings, run, log, restart } = setup(true);
    const retained = SessionManager.inMemory();
    readHistory.mockResolvedValue(retained);

    const prompts = ["My project codename is Cedar.", "Remember that for later."];
    for (const [index, content] of prompts.entries()) {
      await run({ prompt: content });
      await retained.appendMessageAsync({ role: "user", content, timestamp: index + 1 });
    }
    if (replacement === "missing binding") {
      bindings.delete(params.sessionId);
    } else if (replacement !== "model change") {
      bindings.set(params.sessionId, {
        ...bindings.get(params.sessionId)!,
        sessionId: replacement,
      });
    }
    const warn = vi.fn();
    const next = await restart({ warn });
    const result = await next.runAttempt({
      ...params,
      modelId: replacement === "model change" ? "muse-other" : params.modelId,
      prompt: "What is its codename?",
    });
    if (replacement === "busy-session") {
      expectFailure(result, "sessionInUse");
      expect(bindings.get(params.sessionId)?.sessionId).toBe(replacement);
      return;
    }
    expect(terminal(result).kind).toBe("ok");
    expect(result.assistantTexts).toEqual(["started: hello"]);
    if (replacement.endsWith("-session")) {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("started a new Muse session"));
    }
    const turns = await readRequests(log, "turn/start");
    expect(turns).toHaveLength(3);
    expect(turns[1].params.input[0].text).not.toContain("Cedar");
    expect(turns[2].params.input[0].text).toContain("My project codename is Cedar.");
    expect(turns[2].params.input[0].text).toContain("Remember that for later.");
    expect(turns[2].params.input[0].text).toContain("What is its codename?");
  });

  it("seeds bootstrap only on the first accepted turn, retrying aborted admission", async () => {
    const { params, run, log } = setup(true);
    const bootstrapWorkspace = await mkdtemp(join(workspace, "bootstrap-"));
    await writeFile(join(bootstrapWorkspace, "SOUL.md"), "Speak like a patient astronomer.");

    // Abort during transcript admission: after the session opened, before Muse got the turn.
    const controller = new AbortController();
    const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
    const recorder = createRecorder({
      input: { text: params.prompt, idempotencyKey: `${params.runId}:user` },
      target: { ...params.sessionTarget!, agentId: "main", sessionEntry: undefined },
    });
    const aborted = await run({
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
    await run({ workspaceDir: bootstrapWorkspace, prompt: "next" });
    const turns = await readRequests(log, "turn/start");
    expect(turns).toHaveLength(1);
    expect(turns[0].params.input[0].text).toContain("Speak like a patient astronomer.");
    await run({ workspaceDir: bootstrapWorkspace, prompt: "again" });
    expect((await readRequests(log, "turn/start"))[1].params.input[0].text).toBe("again");
  });

  it("fails visibly without dispatching a turn when retained context cannot be read", async () => {
    const { params, bindings, run, log } = setup(true);
    readHistory.mockRejectedValueOnce(new Error("Session context limit exceeded"));

    expectFailure(await run(), "could not restore OpenClaw session context");
    expect(await readFile(log, "utf8")).not.toContain('"method":"turn/start"');
    expect(bindings.has(params.sessionId)).toBe(false);
  });

  it("forwards prepared images under a consented restricted tool policy", async () => {
    const { run, log } = setup(true);
    await run({
      images: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
      pluginHarnessToolPolicyRestricted: true,
    });
    const requests = await readRequests(log);
    expect(requests.find((request) => request.method === "turn/start")?.params.input).toEqual([
      { type: "text", text: "hello" },
      { type: "image", mediaType: "image/png", base64Data: "aW1hZ2U=" },
    ]);
  });

  it.each(["tool", "tool-failure"])("streams and journals native %s outcomes", async (prompt) => {
    const { run, params, events } = setup();
    const prepare = vi.fn();
    params.hostCapabilities.prepareContinuationRetryCount = prepare;
    const globalEvents: typeof events = [];
    const unsubscribe = onAgentEvent((event) => void globalEvents.push(event));
    const lastToolError = { toolName: "read_file", error: "file unavailable" };
    if (prompt === "tool-failure") {
      params.observeToolTerminal = ({ outcome }) => {
        expect(outcome).toBe("failure");
        return {
          lastToolError,
          executionStarted: true,
          sideEffectEvidence: false,
          effectReceipt: { state: "failed_no_effect" },
        };
      };
    }
    try {
      const result = await run({ prompt });
      expect(prepare).toHaveBeenCalledExactlyOnceWith({ cwd: await realpath(workspace) });
      expect(terminal(result).kind).toBe("ok");
      expect(result.assistantTexts).toEqual(["started: hello"]);
      expect(result.lastToolError).toEqual(prompt === "tool" ? undefined : lastToolError);
      for (const stream of [events, globalEvents]) {
        const deltas = stream.flatMap((event) =>
          event.stream === "assistant" ? event.data.delta : [],
        );
        expect(deltas.join("")).toBe("started: hello");
      }
      expect(globalEvents.at(0)?.data.phase).toBe("start");
      expect(globalEvents.at(-1)?.data.phase).toBe("end");
      const roles = result.messagesSnapshot.map((message) => message.role);
      expect(roles).toEqual(["assistant", "assistant", "toolResult", "assistant"]);
      expect(result.toolMetas).toEqual([{ toolName: "read_file" }]);
      expect(writes.append.mock.calls.flatMap(([{ messages }]) => messages)).toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({ role: "toolResult", toolCallId: "call-1" }),
        }),
      );
    } finally {
      unsubscribe();
    }
  });

  it.each(["callback", "transcript", "abort", "timeout", "approval"] as const)(
    "awaits native settlement after %s",
    async (failure) => {
      const { params, run, log } = setup(true);
      const controller = new AbortController();
      if (failure === "transcript") {
        writes.append.mockRejectedValueOnce(new Error("transcript unavailable"));
      }
      if (failure === "approval") {
        params.hostCapabilities.requestApproval = async () => {
          throw new Error("approval gateway unavailable");
        };
      }
      const result = await run({
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
    },
  );

  it.each([true, false])("invalidates context only on commit=%s", async (commit) => {
    const { harness, params, bindings, run, restart } = setup();
    await run();
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
    const restarted = await restart();
    const next = await restarted.runAttempt(params);
    expect(next.assistantTexts).toEqual([commit ? "started: hello" : "resumed: hello"]);
  });

  it.each([
    ["off", "minimal"],
    ["low", "low"],
  ] as const)("maps reasoning effort %s", async (thinkLevel, expected) => {
    const { run } = setup();
    const result = await run({ prompt: "effort", thinkLevel });
    expect(result.assistantTexts).toEqual([`effort:${expected}`]);
  });

  it("does not retire a shared host when another attempt aborts before turn dispatch", async () => {
    const state = setup();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const { promise: firstStarted, resolve: started } = Promise.withResolvers<void>();
    const first = state.run({
      prompt: "wait",
      abortSignal: firstController.signal,
      onExecutionStarted: () => started(),
    });
    try {
      await firstStarted;
      readHistory.mockImplementationOnce(async () => {
        // Abort after the shared host and session open, before the turn is dispatched.
        secondController.abort();
        return SessionManager.inMemory();
      });
      const second = await state.run({
        sessionId: crypto.randomUUID(),
        sessionKey: "agent:main:second-muse",
        abortSignal: secondController.signal,
      });
      expect(terminal(second).kind).toBe("aborted");
      firstController.abort();
      expect(terminal(await first)).toMatchObject({ kind: "aborted" });
    } finally {
      firstController.abort();
      await first;
    }
  });

  it.each([
    ["fail", "fixture provider rejected authentication"],
    ["crash", "fixture: provider process crashed"],
    ["loggedout", "muse login"],
  ])("surfaces %s failures without hanging", async (prompt, expected) => {
    const { params, restart } = setup();
    const warn = vi.fn();
    const result = await (await restart({ warn })).runAttempt({ ...params, prompt });
    expectFailure(result, expected);
    expect(result.replayMetadata?.replaySafe).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        prompt === "loggedout" ? "Muse Code is not signed in on the Gateway host" : expected,
      ),
    );
  });

  it("keeps prepared credentials ahead of profile, environment, and CLI login", async () => {
    const { harness, run, log } = setup(true);
    vi.stubEnv("META_API_KEY", "ambient-meta");
    vi.stubEnv("MUSE_NO_AUTO_UPDATE", "0");

    const prepared = await run({
      prompt: "credential",
      resolvedApiKey: "prepared-key",
      authProfileId: "meta:test",
    });
    expect(prepared.assistantTexts).toEqual(["credential:prepared-key"]);
    const profile = await run({ prompt: "credential", authProfileId: "meta:test" });
    expect(profile.assistantTexts).toEqual(["credential:profile-key"]);
    const ambient = await run({ prompt: "credential" });
    expect(ambient.assistantTexts).toEqual(["credential:ambient-meta"]);
    const spawns = (await readRequests(log)).filter((request) => request.event === "spawn");
    expect(spawns).not.toHaveLength(0);
    expect(spawns.every((request) => request.noAutoUpdate === "1")).toBe(true);
    await harness.dispose();
    vi.unstubAllEnvs();
    const login = setup();
    vi.stubEnv("META_API_KEY", undefined);
    const result = await login.harness.runAttempt({ ...login.params, prompt: "credential" });
    expect(result.assistantTexts).toEqual(["credential:cli-login"]);
  });

  it.runIf(process.platform !== "win32")(
    "verifies native catalogs on inherited PATH without a workspace, and rejects bundled fallback",
    async () => {
      const { harness, params, log } = setup(true);
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

      vi.stubEnv("MUSE_FIXTURE_CATALOG_SOURCE", "providerCatalog");
      const context = {
        ...params,
        config: { plugins: { entries: { muse: { config: { binaryPath: "muse" } } } } },
        agentId: "main",
        workspaceDir: join(workspace, "absent"),
        signal: new AbortController().signal,
        assertCurrent: () => {},
      };
      await harness.verifySetup!(context);
      await harness.loadModelCatalog!(context);
      expect(harness.readModelCatalogReadiness!(context)).toEqual({ accountType: "native" });
      vi.stubEnv("MUSE_FIXTURE_CATALOG_SOURCE", "bundledCatalog");
      await writeFile(join(stateDir, "muse", "muse", "auth.json"), '{"changed":true}');
      await expect(harness.verifySetup!(context)).rejects.toThrow("authenticate");
      await expect(harness.loadModelCatalog!(context)).rejects.toThrow("authenticate");
      expect(harness.readModelCatalogReadiness!(context)).toBeUndefined();
      const requests = await readRequests(log);
      expect(requests[0].path).toBe(process.env.PATH);
      expect(requests.map((request) => request.method)).not.toContain("turn/start");
      expect(requests.map((request) => request.method)).not.toContain("session/start");
    },
  );

  it("rejects unenforceable policies before starting native work", async () => {
    const { bindings, run } = setup();
    await expect(run({ requireWorkspaceOnly: true })).rejects.toThrow("cannot enforce");
    await expect(run({ execOverrides: { ask: "always" } })).rejects.toThrow("exec ask: always");
    await expect(run({ thinkLevel: "adaptive" })).rejects.toThrow(
      "does not support adaptive reasoning",
    );
    approvals.load.mockResolvedValue({ version: 1, defaults: { ask: "always" } });
    await expect(run({ config: fullExec })).rejects.toThrow("ask: always");
    expect(bindings.size).toBe(0);
  });

  it("starts fresh sessions when managed auth appears, changes, or disappears", async () => {
    const { params, bindings, run, log } = setup(true);
    const stateDir = await mkdtemp(join(workspace, "session-auth-"));
    const authDir = join(stateDir, "muse", "muse");
    const authFile = join(authDir, "auth.json");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("META_API_KEY", undefined);
    const sessionIds = new Set<string>();
    for (const account of [undefined, "managed", "replacement-account", null]) {
      if (account === null) {
        await rm(authFile);
      } else if (account) {
        await mkdir(authDir, { recursive: true });
        await writeFile(authFile, JSON.stringify({ account }));
      }
      expect(terminal(await run()).kind).toBe("ok");
      sessionIds.add(bindings.get(params.sessionId)!.sessionId);
    }
    expect(sessionIds.size).toBe(4);
    const requests = await readRequests(log);
    expect(requests.filter((request) => request.method === "session/resume")).toHaveLength(0);
  });

  it.each([
    ["approval", "allow-once", undefined],
    ["approval", "deny", "denied"],
    ["approval", "error", "approval gateway unavailable"],
    ["approval-deny-only", undefined, "denied"],
    ["approval-deny-only", "allow-once", "no safe approved approval choice"],
  ] as const)("handles %s decision %s", async (prompt, decision, error) => {
    const { params, run, log } = setup(true);
    vi.mocked(params.hostCapabilities.requestApproval).mockImplementation(async () => {
      if (decision === "error") {
        throw new Error(error);
      }
      return decision ? { decision } : undefined;
    });
    const result = await run({ prompt, timeoutMs: 2 ** 31 });
    expect(params.hostCapabilities.requestApproval).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        toolName: "shell",
        allowedDecisions: ["allow-once", "deny"],
        timeoutMs: 120_000,
      }),
    );
    if (error) {
      expectFailure(result, error);
      expect(result.assistantTexts).toEqual([]);
    } else {
      expect(terminal(result).kind).toBe("ok");
      expect(result.assistantTexts).toEqual(["started: hello"]);
    }
    const requests = await readRequests(log);
    const choices = requests
      .filter((request) => request.method === "approval/decide")
      .map((request) => request.params.choiceId);
    if (prompt === "approval-deny-only" && decision) {
      expect(choices).toEqual([]);
      expect(requests).toContainEqual(expect.objectContaining({ method: "turn/interrupt" }));
      expect(requests).toContainEqual({ event: "terminal", terminal: "cancelled" });
    } else if (prompt === "approval-deny-only") {
      expect(choices).toEqual(["server-only"]);
    }
  });
});
