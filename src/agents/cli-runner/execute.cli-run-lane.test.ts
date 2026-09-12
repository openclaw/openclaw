// A fresh (non-resumed) CLI run for a session must not start a second CLI
// process beside that session's in-flight run. The shared session-owner lane is
// what makes the new turn queue behind the predecessor (or drop, if its own
// admission is gone) instead of answering the same conversation context-free.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createProcessAdapterEvents } from "../../process/supervisor/adapters/process-events.js";
import { createProcessSupervisor } from "../../process/supervisor/supervisor.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import { executeDeps } from "./execute-deps.js";
import { executePreparedCliRun as executePreparedCliRunImpl } from "./execute.js";
import {
  setCliRunnerExecuteTestDeps,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";
import type { PreparedCliRunContext } from "./types.js";

const executePreparedCliRun = wrapPreparedCliRunWithTestAdmission(executePreparedCliRunImpl);

// A queued run only observes its turn after the lane releases; the window below
// is the time a second process would have been spawned under the old keying.
const LANE_OBSERVATION_MS = 100;

const { createChildAdapterMock } = vi.hoisted(() => ({
  createChildAdapterMock:
    vi.fn<typeof import("../../process/supervisor/adapters/child.js").createChildAdapter>(),
}));

vi.mock("../../process/supervisor/adapters/child.js", () => ({
  createChildAdapter: createChildAdapterMock,
}));

type ChildAdapter = Awaited<
  ReturnType<typeof import("../../process/supervisor/adapters/child.js").createChildAdapter>
>;

type TestAdapter = ChildAdapter & {
  emitStdout: (chunk: string) => void;
  settle: (code: number | null, signal?: NodeJS.Signals | null) => void;
};

function createTestAdapter(): TestAdapter {
  const exit = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  const events = createProcessAdapterEvents();
  let settled = false;
  const settle: TestAdapter["settle"] = (code, signal = null) => {
    if (settled) {
      return;
    }
    settled = true;
    events.emitExit(code, signal);
    exit.resolve({ code, signal });
  };
  let stdoutListener: ((chunk: string) => void) | undefined;
  const adapter: TestAdapter = {
    pid: 1234,
    supportsRawOutput: false,
    onExit: events.onExit,
    onError: events.onError,
    onStdout: vi.fn((listener) => {
      stdoutListener = listener;
    }),
    onStderr: vi.fn(),
    wait: async () => await exit.promise,
    kill: vi.fn((signal?: NodeJS.Signals) => {
      settle(null, signal ?? "SIGTERM");
    }),
    dispose: vi.fn(() => events.clear()),
    emitStdout: (chunk) => stdoutListener?.(chunk),
    settle,
  };
  return adapter;
}

function createRunContext(params: {
  runId: string;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}): PreparedCliRunContext {
  const backend = {
    command: "claude",
    args: ["-p"],
    resumeArgs: ["-p", "--resume", "{sessionId}"],
    output: "text" as const,
    input: "stdin" as const,
    serialize: true,
  };

  return {
    params: {
      admittedRunContext: createTestAdmittedRunContext(params.runId),
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/openclaw-cli-lane-test.jsonl",
      workspaceDir: "/tmp",
      prompt: "hello",
      provider: "claude-cli",
      model: "claude-sonnet-5",
      timeoutMs: 60_000,
      runId: params.runId,
      ...(params.signal ? { abortSignal: params.signal } : {}),
      ...(params.assertCurrent ? { assertCurrent: params.assertCurrent } : {}),
    },
    started: Date.now(),
    workspaceDir: "/tmp",
    backendResolved: {
      id: "claude-cli",
      config: backend,
      bundleMcp: false,
    },
    executionTarget: { kind: "process" },
    preparedBackend: { backend, env: {} },
    reusableCliSession: { mode: "none" },
    hadSessionFile: true,
    contextEngineConfig: {},
    modelId: "claude-sonnet-5",
    normalizedModel: "claude-sonnet-5",
    systemPrompt: "system",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    claudeSkillsPluginArgs: [],
    authEpochVersion: 2,
  };
}

function sleepLaneWindow(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, LANE_OBSERVATION_MS);
  });
}

describe("CLI run lane ownership for one session", () => {
  const restoreProcessSupervisor = executeDeps.getProcessSupervisor;
  let supervisor: ReturnType<typeof createProcessSupervisor>;
  let adapters: TestAdapter[];

  beforeEach(() => {
    createChildAdapterMock.mockReset();
    adapters = [];
    createChildAdapterMock.mockImplementation(async () => {
      const adapter = createTestAdapter();
      adapters.push(adapter);
      return adapter;
    });
    supervisor = createProcessSupervisor();
    setCliRunnerExecuteTestDeps({ getProcessSupervisor: () => supervisor });
  });

  afterEach(() => {
    setCliRunnerExecuteTestDeps({ getProcessSupervisor: restoreProcessSupervisor });
    vi.restoreAllMocks();
  });

  it("queues a fresh run behind the session's in-flight resumed process", async () => {
    const resumed = executePreparedCliRun(createRunContext({ runId: "resumed-run" }), "resume-1");
    await vi.waitFor(() => expect(createChildAdapterMock).toHaveBeenCalledTimes(1));
    adapters[0]!.emitStdout("resumed reply");

    const fresh = executePreparedCliRun(createRunContext({ runId: "fresh-run" }));
    await sleepLaneWindow();
    // Observation only; cleanup below must still settle every started process.
    const processesWhileResumedInFlight = createChildAdapterMock.mock.calls.length;

    adapters[0]!.settle(0);
    await vi.waitFor(() => expect(adapters.length).toBe(2));
    adapters[1]!.emitStdout("fresh reply");
    adapters[1]!.settle(0);

    await expect(resumed).resolves.toMatchObject({ text: "resumed reply" });
    await expect(fresh).resolves.toMatchObject({ text: "fresh reply" });
    expect(processesWhileResumedInFlight).toBe(1);
  });

  it("never spawns a queued fresh run whose own turn is gone", async () => {
    const controller = new AbortController();
    const resumed = executePreparedCliRun(createRunContext({ runId: "lane-holder" }), "resume-1");
    await vi.waitFor(() => expect(createChildAdapterMock).toHaveBeenCalledTimes(1));
    adapters[0]!.emitStdout("held reply");

    const queued = executePreparedCliRun(
      createRunContext({ runId: "queued-fresh", signal: controller.signal }),
    );
    await sleepLaneWindow();
    controller.abort();
    adapters[0]!.settle(0);

    await expect(resumed).resolves.toMatchObject({ text: "held reply" });
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(adapters).toHaveLength(1);
  });
});
