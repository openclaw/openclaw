import fs from "node:fs/promises";
import path from "node:path";
import { RequestedModelUnsupportedError } from "acpx/runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AcpRuntimeError,
  type AcpRuntimeEvent,
  type AcpRuntimeTurnResult,
} from "../runtime-api.js";
import { OPENCLAW_CODEX_CONFIG_ARG } from "./codex-adapter.js";
import { renderAgentCommand, type AcpxAgentCommand } from "./command-line.js";
import { OPENCLAW_ACPX_LEASE_ID_ARG, OPENCLAW_GATEWAY_INSTANCE_ID_ARG } from "./process-lease.js";
import {
  CODEX_ACP_WRAPPER_COMMAND,
  makeEmptySessionStore,
  makeLeasedRuntime,
  makeLeaseStore,
  makeRuntime,
  makeTurn,
  observeLaunch,
  runtimeCommand,
  type TestSessionStore,
} from "./runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const CODEX_ACP_COMMAND = "npx @agentclientprotocol/codex-acp@1.11.0";
const sessionKey = "agent:codex:acp:binding:test";
const testHandle = { sessionKey, backend: "acpx", runtimeSessionName: sessionKey };
const ensureInput = { sessionKey, agent: "codex", mode: "persistent" as const };
const WRAPPER_ROOT = "/tmp/openclaw/acpx";
const gatewayOptions = {
  openclawGatewayInstanceId: "gateway-test",
  openclawWrapperRoot: WRAPPER_ROOT,
};
const closeInput = { handle: testHandle, reason: "user-close" };
const progress: AcpRuntimeEvent = { type: "text_delta", text: "Progress" };
const providerError = {
  code: "ACP_TURN_FAILED",
  detailCode: "PROVIDER_ERROR",
  message: "Provider failed",
  retryable: false,
};
const invalidOption = "ACP_INVALID_RUNTIME_OPTION";
const bedrockModel = "arn:aws:bedrock:us-east-1:123456789012:inference-profile/claude";
const turnInput = {
  handle: testHandle,
  text: "Do work",
  mode: "prompt" as const,
  requestId: "turn",
};

async function collectEvents(source: AsyncIterable<AcpRuntimeEvent>) {
  const collected: AcpRuntimeEvent[] = [];
  for await (const event of source) {
    collected.push(event);
  }
  return collected;
}

async function* events(...values: AcpRuntimeEvent[]) {
  yield* values;
}

function savedSession(overrides: Record<string, unknown> = {}) {
  return { name: sessionKey, agentCommand: CODEX_ACP_WRAPPER_COMMAND, ...overrides };
}

function persistentSession(agentCommand = CODEX_ACP_WRAPPER_COMMAND) {
  return savedSession({
    acpxRecordId: "record-1",
    acpSessionId: "session-1",
    agentCommand,
    cwd: "/tmp",
    closed: false,
    pid: 777,
  });
}

function sessionStore(initial: Record<string, unknown> | undefined): TestSessionStore {
  let record = initial;
  return {
    load: vi.fn(async () => record),
    save: vi.fn(async (next) => {
      record = next;
    }),
  };
}

function leasedRuntime(
  record?: Record<string, unknown>,
  cleanup?: Parameters<typeof makeRuntime>[2],
  wrapperRoot = "/tmp/openclaw/acpx",
) {
  const baseStore = sessionStore(record);
  const leaseStore = makeLeaseStore();
  return {
    ...(cleanup || wrapperRoot !== WRAPPER_ROOT
      ? makeRuntime(
          baseStore,
          {
            ...gatewayOptions,
            openclawProcessLeaseStore: leaseStore.store,
            openclawWrapperRoot: wrapperRoot,
            agentRegistry: {
              resolve: () => `node "${path.join(wrapperRoot, "codex-acp-wrapper.mjs")}"`,
              list: () => ["codex"],
            },
          },
          cleanup,
        )
      : makeLeasedRuntime(baseStore, leaseStore)),
    baseStore,
    leaseStore,
  };
}

function mockTurn(
  delegate: ReturnType<typeof makeRuntime>["delegate"],
  overrides: Parameters<typeof makeTurn>[1],
) {
  return vi.spyOn(delegate, "startTurn").mockImplementation((input) => makeTurn(input, overrides));
}

function commandForLease(leaseId: string, gateway = "gateway-test") {
  return `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} ${leaseId} ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} ${gateway}`;
}

async function diagnosticRuntime(message: string) {
  const wrapperRoot = tempDirs.make("openclaw-acpx-runtime-");
  await fs.writeFile(path.join(wrapperRoot, "codex-acp-wrapper.stderr.diagnostic.log"), message);
  return makeRuntime(
    sessionStore({
      acpxRecordId: sessionKey,
      agentCommand: CODEX_ACP_WRAPPER_COMMAND,
      openclawLeaseId: "diagnostic",
    }),
    { openclawWrapperRoot: wrapperRoot },
  );
}

function recordCommand(command: AcpxAgentCommand) {
  return {
    agentCommand: renderAgentCommand(command),
    ...(typeof command === "string" ? {} : { agentArgv: command }),
  };
}

function closingRuntime(...args: Parameters<typeof leasedRuntime>) {
  const fixture = leasedRuntime(...args);
  vi.spyOn(fixture.delegate, "close").mockResolvedValue(undefined);
  return fixture;
}

function makeAgentRuntime(agent: string, command: AcpxAgentCommand) {
  const { runtime, delegate } = makeRuntime(makeEmptySessionStore(), {
    agentRegistry: { resolve: () => command, list: () => [agent] },
  });
  const ensure = vi.spyOn(delegate, "ensureSession").mockResolvedValue({
    sessionKey: `agent:${agent}:acp:test`,
    backend: "acpx",
    runtimeSessionName: agent,
  });
  return { runtime, ensure };
}

function seedLease(
  leases: ReturnType<typeof makeLeaseStore>,
  leaseId: string,
  rootPid: number,
  startedAt: number,
) {
  leases.leases.set(leaseId, {
    leaseId,
    gatewayInstanceId: "gateway-test",
    sessionKey,
    wrapperRoot: WRAPPER_ROOT,
    wrapperPath: path.join(WRAPPER_ROOT, "codex-acp-wrapper.mjs"),
    rootPid,
    commandHash: "hash",
    startedAt,
    state: "open",
  });
}

describe("AcpxRuntime fresh reset wrapper", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("rejects unsupported runtime session modes (issue #73071)", async () => {
    const { runtime, ensure } = makeAgentRuntime("codex", CODEX_ACP_COMMAND);
    await expect(
      runtime.ensureSession({ ...ensureInput, mode: "run" as never }),
    ).rejects.toMatchObject({ name: "AcpRuntimeError", code: "ACP_INVALID_RUNTIME_OPTION" });
    expect(ensure).not.toHaveBeenCalled();
  });

  it("strips the Bedrock prefix for a portable Claude wrapper command", async () => {
    const { runtime, ensure } = makeAgentRuntime(
      "claude",
      'Node.EXE "C:/openclaw/acpx/claude-agent-acp-wrapper.mjs"',
    );
    await runtime.ensureSession({
      ...ensureInput,
      agent: "claude",
      model: "Amazon-Bedrock/us.anthropic.claude-opus-4-6-v1",
    });
    expect(ensure.mock.calls[0]?.[0]).toEqual({
      ...ensureInput,
      agent: "claude",
      model: "us.anthropic.claude-opus-4-6-v1",
      sessionOptions: { model: "us.anthropic.claude-opus-4-6-v1" },
    });
  });

  it.each([
    {
      stderr:
        "noise\nUnhandled error during session/new: deployment missing token=[REDACTED] sk-testsecret1234567890\n",
      expected: "deployment missing",
      forbidden: "sk-testsecret1234567890",
    },
    {
      stderr: `🚀${"a".repeat(5_999)}`,
      expected: `Internal error: ${"a".repeat(5_999)}`,
      forbidden: "\ude80",
    },
  ])(
    "reports a redacted, UTF-16-safe initialization diagnostic ($forbidden)",
    async ({ stderr, expected, forbidden }) => {
      const wrapperRoot = tempDirs.make("openclaw-acpx-runtime-");
      const { runtime, delegate, leaseStore } = leasedRuntime(undefined, undefined, wrapperRoot);
      vi.spyOn(delegate, "ensureSession").mockImplementation(async () => {
        await observeLaunch(runtime, { sessionKey });
        const leaseId = Array.from(leaseStore.leases.keys())[0];
        await fs.writeFile(
          path.join(wrapperRoot, `codex-acp-wrapper.stderr.${leaseId}.log`),
          stderr,
        );
        throw new Error("Internal error");
      });
      const error = await runtime
        .ensureSession({ ...ensureInput, mode: "oneshot" })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AcpRuntimeError);
      expect(error).toMatchObject({
        code: "ACP_SESSION_INIT_FAILED",
        message: expect.stringContaining(expected),
      });
      expect(error).toHaveProperty("message", expect.not.stringContaining(forbidden));
    },
  );

  it("adds diagnostics to failed turns without settling prompt submission early", async () => {
    const promptStarted = createDeferred<void>();
    const { runtime, delegate } = await diagnosticRuntime("adapter disconnected after progress");
    const outputProgress: AcpRuntimeEvent = { ...progress, stream: "output" };
    mockTurn(delegate, {
      promptStarted: promptStarted.promise,
      events: events(outputProgress),
      result: Promise.resolve({
        status: "failed",
        error: { message: "Internal error", retryable: false },
      }),
    });
    const turn = runtime.startTurn(turnInput);
    let submitted = false;
    const observed = turn.promptStarted.then(() => {
      submitted = true;
    });
    expect(await collectEvents(turn.events)).toEqual([outputProgress]);
    expect(submitted).toBe(false);
    promptStarted.resolve();
    await observed;
    expect(submitted).toBe(true);
    await expect(turn.result).resolves.toMatchObject({
      status: "failed",
      error: {
        code: "ACP_TURN_FAILED",
        message: expect.stringContaining("adapter disconnected after progress"),
        retryable: false,
      },
    });
  });

  it.each(["creation", "events"] as const)(
    "adds diagnostics when turn %s throws",
    async (boundary) => {
      const { runtime, delegate } = await diagnosticRuntime("adapter failed before returning turn");
      vi.spyOn(delegate, "startTurn").mockImplementation((input) => {
        if (boundary === "creation") {
          throw new Error("Internal error");
        }
        return makeTurn(input, {
          events: (async function* () {
            yield { type: "status" as const, text: "Connecting" };
            throw new Error("Internal error");
          })(),
        });
      });
      const turn = runtime.startTurn(turnInput);
      const expected = {
        name: "AcpRuntimeError",
        code: "ACP_TURN_FAILED",
        message: expect.stringContaining("adapter failed before returning turn"),
      };
      await expect(
        boundary === "events" ? collectEvents(turn.events) : turn.promptStarted,
      ).rejects.toMatchObject(expected);
      if (boundary === "events") {
        await expect(turn.result).resolves.toEqual({ status: "completed" });
      } else {
        await expect(turn.result).rejects.toMatchObject(expected);
      }
    },
  );

  it.each([
    {
      result: { status: "completed", stopReason: "end_turn" },
      event: { type: "done", stopReason: "end_turn" },
    },
    {
      result: { status: "failed", error: providerError },
      event: { type: "error", ...providerError },
    },
  ] satisfies Array<{ result: AcpRuntimeTurnResult; event: AcpRuntimeEvent }>)(
    "projects $result.status into one legacy terminal event",
    async ({ result, event }) => {
      const { runtime, delegate } = makeRuntime(
        sessionStore(savedSession({ agentCommand: "claude" })),
      );
      const cancel = vi.fn(async () => {});
      mockTurn(delegate, {
        events: events(progress),
        result: Promise.resolve(result),
        cancel,
      });
      expect(await collectEvents(runtime.runTurn(turnInput))).toEqual([progress, event]);
      expect(cancel).not.toHaveBeenCalled();
    },
  );

  it("drops an inherited model when the agent lacks model support", async () => {
    const { runtime, ensure } = makeAgentRuntime("opencode", "opencode acp");
    ensure.mockRejectedValueOnce(
      new RequestedModelUnsupportedError("No model support", "missing-capability"),
    );
    await expect(
      runtime.ensureSession({ ...ensureInput, agent: "opencode", model: "openrouter/owl-alpha" }),
    ).resolves.toMatchObject({ appliedModel: { kind: "dropped" } });
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(ensure.mock.calls[0]?.[0]).toMatchObject({
      model: "openrouter/owl-alpha",
      sessionOptions: { model: "openrouter/owl-alpha" },
    });
    expect(ensure.mock.calls[1]?.[0]).toMatchObject({ model: undefined });
    expect(ensure.mock.calls[1]?.[0]).not.toHaveProperty("sessionOptions");
  });

  it("persists explicit thinking off over a Codex model suffix", async () => {
    const { runtime, delegate, wrappedStore, baseStore } = leasedRuntime(undefined);
    vi.spyOn(delegate, "ensureSession").mockImplementation(async (input) => {
      await wrappedStore.save({ name: input.sessionKey, cwd: "/tmp", pid: 777 });
      return testHandle;
    });
    await runtime.ensureSession({
      ...ensureInput,
      model: "openai/gpt-5.6-luna/high",
      thinking: "off",
    });
    const argv = (await baseStore.load(sessionKey))?.agentArgv;
    if (!Array.isArray(argv)) {
      throw new Error("Expected persisted ACP argv");
    }
    expect(argv).toContain(OPENCLAW_CODEX_CONFIG_ARG);
    const config: unknown = argv[argv.indexOf(OPENCLAW_CODEX_CONFIG_ARG) + 1];
    if (typeof config !== "string") {
      throw new Error("Expected a Codex startup config argument");
    }
    expect(JSON.parse(config)).toEqual({ model: "gpt-5.6-luna" });
  });

  it.each([
    {
      name: "inherited max thinking",
      input: { thinking: "max", thinkingExplicit: false },
      forwarded: {},
      field: "appliedThinking" as const,
      command: "env OPENCLAW_HIDE_BANNER=1 codex-acp",
    },
    {
      name: "unsupported model while retaining thinking",
      input: { model: "google/gemini-3.1-flash-lite", thinking: "low" },
      forwarded: { thinking: "low" },
      field: "appliedModel" as const,
      command: CODEX_ACP_COMMAND,
    },
  ])("drops $name", async ({ input, forwarded, field, command }) => {
    const { runtime, ensure } = makeAgentRuntime("codex", command);
    const handle = await runtime.ensureSession({ ...ensureInput, ...input });
    expect(ensure.mock.calls[0]?.[0]).toEqual({ ...ensureInput, ...forwarded });
    expect(handle[field]).toEqual({ kind: "dropped" });
  });

  it("rejects explicit unsupported models before delegation", async () => {
    const { runtime, ensure } = makeAgentRuntime("codex", CODEX_ACP_COMMAND);
    await expect(
      runtime.ensureSession({
        ...ensureInput,
        model: "google/gemini-3.1-flash-lite",
        modelExplicit: true,
      }),
    ).rejects.toMatchObject({ code: "ACP_INVALID_RUNTIME_OPTION" });
    expect(ensure).not.toHaveBeenCalled();
  });

  it.each<[string, string, string, string[][] | string, string?]>([
    ["bare model", "model", "gpt-5.4", [["model", "gpt-5.4"]]],
    ["empty qualified model", "model", "openai//high", invalidOption],
    [
      "reasoning suffix",
      "model",
      "openai/gpt-5.4/high",
      [
        ["model", "gpt-5.4"],
        ["reasoning_effort", "high"],
      ],
    ],
    ["unsupported model", "model", "google/gemini-3.1-flash-lite", invalidOption],
    ["reasoning alias", "reasoning_effort", "x-high", [["reasoning_effort", "xhigh"]]],
    ["clearing thinking", "thought_level", "off", "ACP_BACKEND_UNSUPPORTED_CONTROL"],
    ["Claude timeout", "Timeout_Seconds", "60", [], "claude"],
    ["Claude model", "model", bedrockModel, [["model", bedrockModel]], "claude"],
  ])("normalizes config control: %s", async (_name, key, value, outcome, agent = "codex") => {
    const handle = testHandle;
    const { runtime, delegate } = makeRuntime(
      sessionStore({
        acpxRecordId: sessionKey,
        agentCommand: agent === "codex" ? CODEX_ACP_COMMAND : "claude-agent-acp.exe",
      }),
    );
    const accepted = { configOptions: [{ id: "effort", currentValue: "high" }] };
    const update = vi.spyOn(delegate, "setConfigOption").mockResolvedValue(accepted);
    const result = runtime.setConfigOption({ handle, key, value });
    if (typeof outcome === "string") {
      await expect(result).rejects.toMatchObject({ code: outcome });
      expect(update).not.toHaveBeenCalled();
    } else {
      await expect(result).resolves.toBe(outcome.length ? accepted : undefined);
      expect(update.mock.calls).toEqual(
        outcome.map(([controlKey, controlValue]) => [
          { handle, key: controlKey, value: controlValue },
        ]),
      );
    }
  });

  it("does not reuse commands leased by another gateway instance", async () => {
    const foreign = commandForLease("foreign", "gateway-foreign");
    const { runtime, delegate, wrappedStore, baseStore, leaseStore } = leasedRuntime(
      persistentSession(foreign),
    );
    vi.spyOn(delegate, "ensureSession").mockImplementation(async () => {
      await observeLaunch(runtime, { sessionKey, pid: 888 });
      await wrappedStore.save(
        savedSession({ ...recordCommand(runtimeCommand(runtime)), cwd: "/tmp", pid: 888 }),
      );
      return testHandle;
    });
    await runtime.ensureSession(ensureInput);
    const saved = await baseStore.load(sessionKey);
    expect(saved?.agentCommand).not.toBe(foreign);
    expect(saved?.agentCommand).toContain(`${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`);
    expect(saved?.pid).toBe(888);
    expect(leaseStore.leases.size).toBe(1);
  });

  it("rejects reconnect operations for commands leased by another gateway", async () => {
    const { runtime, delegate, leaseStore } = leasedRuntime(
      savedSession({ agentCommand: commandForLease("foreign", "gateway-foreign") }),
    );
    const calls = [
      vi.spyOn(delegate, "startTurn").mockImplementation(makeTurn),
      vi.spyOn(delegate, "setMode").mockResolvedValue(undefined),
      vi.spyOn(delegate, "setConfigOption").mockResolvedValue(undefined),
      vi.spyOn(delegate, "close").mockResolvedValue(undefined),
    ];
    const expected = {
      code: "ACP_TURN_FAILED",
      message: expect.stringContaining("belongs to another gateway"),
    };
    await expect(
      runtime.setConfigOption({ handle: testHandle, key: "thinking", value: "minimal" }),
    ).rejects.toMatchObject(expected);
    await expect(runtime.setMode({ handle: testHandle, mode: "plan" })).rejects.toMatchObject(
      expected,
    );
    await expect(runtime.close({ handle: testHandle, reason: "done" })).rejects.toMatchObject(
      expected,
    );
    const turn = runtime.startTurn(turnInput);
    const outcomes = await Promise.allSettled([turn.result, turn.cancel(), turn.closeStream()]);
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({ status: "rejected", reason: expected });
    }
    for (const call of calls) {
      expect(call).not.toHaveBeenCalled();
    }
    expect(leaseStore.leases.size).toBe(0);
  });

  it("serializes concurrent persistent ensures for one session", async () => {
    const { runtime, delegate, wrappedStore, baseStore, leaseStore } = leasedRuntime(undefined);
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const commands: string[] = [];
    let active = 0;
    let maxActive = 0;
    const ensure = vi.spyOn(delegate, "ensureSession").mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      commands.push(renderAgentCommand(runtimeCommand(runtime)));
      if (commands.length === 1) {
        await observeLaunch(runtime, { sessionKey, pid: 777 });
        await wrappedStore.save(
          savedSession({
            acpSessionId: "session-1",
            ...recordCommand(runtimeCommand(runtime)),
            cwd: "/tmp",
            pid: 777,
          }),
        );
        started.resolve();
        await release.promise;
      } else {
        await wrappedStore.save((await baseStore.load(sessionKey))!);
      }
      active -= 1;
      return testHandle;
    });
    const first = runtime.ensureSession(ensureInput);
    await started.promise;
    const second = runtime.ensureSession(ensureInput);
    await Promise.resolve();
    try {
      expect(ensure).toHaveBeenCalledOnce();
      release.resolve();
      await Promise.all([first, second]);
      expect(maxActive).toBe(1);
      expect(commands).toHaveLength(2);
      expect(commands[1]).toBe(commands[0]);
      expect(leaseStore.leases.size).toBe(1);
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  it("adopts legacy persistent commands before their next reconnect", async () => {
    const record = persistentSession();
    const { runtime, delegate, wrappedStore, baseStore, leaseStore } = leasedRuntime(record);
    vi.spyOn(delegate, "ensureSession").mockImplementation(async () => {
      expect(renderAgentCommand(runtimeCommand(runtime))).toBe(CODEX_ACP_WRAPPER_COMMAND);
      await wrappedStore.save(record);
      return testHandle;
    });
    await runtime.ensureSession(ensureInput);
    const saved = (await baseStore.load(sessionKey))!;
    expect(saved.agentCommand).toContain(OPENCLAW_ACPX_LEASE_ID_ARG);
    expect(saved.agentCommand).toContain(OPENCLAW_GATEWAY_INSTANCE_ID_ARG);
    expect(saved.pid).toBeUndefined();
    expect(leaseStore.leases.size).toBe(0);
    await observeLaunch(runtime, { sessionKey, command: String(saved.agentCommand), pid: 888 });
    await wrappedStore.save({ ...saved, pid: 888 });
    expect(Array.from(leaseStore.leases.values())).toEqual([
      expect.objectContaining({ leaseId: saved.openclawLeaseId, rootPid: 888 }),
    ]);
  });

  it("joins abandoned runTurn cancellation and leaves uncertain process cleanup to close", async () => {
    const command = commandForLease("abandoned");
    const { runtime, delegate, leaseStore } = closingRuntime(
      savedSession({ agentCommand: command }),
      { openclawProcessCleanup: { listProcesses: async () => [] } },
    );
    await observeLaunch(runtime, { sessionKey, command });
    const result = createDeferred<{ status: "cancelled" }>();
    const cancelling = createDeferred<void>();
    const cancel = vi.fn(async () => {
      cancelling.resolve();
    });
    mockTurn(delegate, {
      result: result.promise,
      cancel,
      events: events({ type: "text_delta", text: "Partial progress" }),
    });
    const iterator = runtime.runTurn(turnInput)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "text_delta", text: "Partial progress" },
    });
    let returned = false;
    const closing = iterator.return?.().then(() => {
      returned = true;
    });
    try {
      await cancelling.promise;
      expect(cancel).toHaveBeenCalledOnce();
      expect(returned).toBe(false);
      expect(leaseStore.leases.has("abandoned")).toBe(true);
      result.resolve({ status: "cancelled" });
      await closing;
      expect(leaseStore.leases.size).toBe(1);
      await runtime.close({ handle: testHandle, reason: "explicit-close" });
      expect(leaseStore.leases.size).toBe(0);
    } finally {
      result.resolve({ status: "cancelled" });
      await closing;
    }
  });

  it("keeps close pending leases when cleanup fails", async () => {
    const command = commandForLease("close-failure");
    const { runtime, delegate, leaseStore } = closingRuntime(
      savedSession({ agentCommand: command }),
    );
    await observeLaunch(runtime, { command, sessionKey });
    leaseStore.store.load
      .mockResolvedValueOnce(await leaseStore.store.load("close-failure"))
      .mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(runtime.close(closeInput)).rejects.toThrow("cleanup failed");
    expect(delegate.close).toHaveBeenCalledOnce();
    expect(leaseStore.leases.get("close-failure")).toMatchObject({ rootPid: 0, state: "open" });
  });

  it.each(["unavailable", "windows"])(
    "keeps close leases retryable when process evidence is %s",
    async (evidence) => {
      const listProcesses = vi.fn(async () => {
        throw new Error("process listing unavailable");
      });
      const { runtime, leaseStore } = closingRuntime(
        savedSession({ agentCommand: commandForLease("close-list"), pid: 777 }),
        {
          openclawProcessCleanup: {
            listProcesses,
            ...(evidence === "windows" ? { platform: "win32" as const } : {}),
          },
        },
      );
      seedLease(leaseStore, "close-list", 777, 1);
      await runtime.close(closeInput);
      expect(leaseStore.leases.get("close-list")).toMatchObject({ rootPid: 777, state: "open" });
      if (evidence === "windows") {
        expect(listProcesses).not.toHaveBeenCalled();
      }
    },
  );

  it("closes the current process lease when the saved lease id is stale", async () => {
    const killProcess = vi.fn();
    const { runtime, leaseStore } = closingRuntime(
      {
        acpxRecordId: sessionKey,
        agentCommand: CODEX_ACP_WRAPPER_COMMAND,
        openclawLeaseId: "old",
        pid: 940,
      },
      {
        openclawProcessCleanup: {
          listProcesses: async () => [
            { pid: 930, ppid: 1, command: commandForLease("old") },
            { pid: 940, ppid: 1, command: commandForLease("current") },
            { pid: 941, ppid: 940, command: "node child.js" },
          ],
          killProcess,
          sleep: async () => {},
        },
      },
    );
    seedLease(leaseStore, "old", 930, 1);
    seedLease(leaseStore, "current", 940, 2);
    await runtime.close(closeInput);
    expect(killProcess.mock.calls.slice(0, 2)).toEqual([
      [941, "SIGTERM"],
      [940, "SIGTERM"],
    ]);
    expect(leaseStore.store.markState.mock.calls).toEqual([
      ["current", "closing"],
      ["current", "closed"],
    ]);
  });

  it.each([
    ["reused wrapper root", 'node "/tmp/other-gateway/acpx/codex-acp-wrapper.mjs"', {}],
    [
      "reused lease",
      commandForLease("other-lease"),
      { openclawGatewayInstanceId: "gateway-test", openclawLeaseId: "lease-record" },
    ],
  ] as const)("validates fallback close ownership for %s", async (_name, command, metadata) => {
    const killProcess = vi.fn();
    const { runtime, delegate } = makeRuntime(
      sessionStore({
        acpxRecordId: sessionKey,
        agentCommand: CODEX_ACP_WRAPPER_COMMAND,
        pid: 920,
        ...metadata,
      }),
      gatewayOptions,
      {
        openclawProcessCleanup: {
          listProcesses: async () => [
            { pid: 920, ppid: 1, command },
            { pid: 921, ppid: 920, command: "node child.js" },
          ],
          killProcess,
          sleep: async () => {},
        },
      },
    );
    vi.spyOn(delegate, "close").mockResolvedValue(undefined);
    await runtime.close(closeInput);
    expect(killProcess).not.toHaveBeenCalled();
  });
});
