import path from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { ManagedRun } from "../process/supervisor/index.js";
import type { RunExit, SpawnInput } from "../process/supervisor/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { markBackgrounded } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";

const requestHeartbeatMock = vi.hoisted(() => vi.fn());
const enqueueSystemEventWithReceiptMock = vi.hoisted(() => vi.fn());
const supervisorMock = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("../infra/heartbeat-wake.js", () => ({ requestHeartbeat: requestHeartbeatMock }));
vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEventWithReceipt: enqueueSystemEventWithReceiptMock,
}));
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn: supervisorMock.spawn }),
}));

let runExecProcess: typeof import("./bash-tools.exec-runtime.js").runExecProcess;

beforeAll(async () => {
  ({ runExecProcess } = await import("./bash-tools.exec-runtime.js"));
});

beforeEach(() => {
  resetProcessRegistryForTests();
  requestHeartbeatMock.mockReset();
  enqueueSystemEventWithReceiptMock.mockReset();
  supervisorMock.spawn.mockReset();
});

afterEach(() => {
  resetProcessRegistryForTests();
  closeOpenClawAgentDatabasesForTest();
});

function createRunExit(): RunExit {
  return {
    reason: "exit",
    exitCode: 0,
    exitSignal: null,
    durationMs: 1,
    stdout: "",
    stderr: "",
    timedOut: false,
    noOutputTimedOut: false,
  };
}

function runtimeManagedRun(input: SpawnInput): ManagedRun {
  input.onStdout?.("retained output\n");
  return {
    activity: { resultSettled: true, lastOutputAtMs: Date.now() },
    runId: input.runId ?? "run",
    pid: 1234,
    startedAtMs: Date.now(),
    stdin: { write: vi.fn(), end: vi.fn(), destroy: vi.fn() },
    cancel: vi.fn(),
    wait: vi.fn(async () => createRunExit()),
  };
}

it("suppresses a routed completion after its source session generation is replaced", async () => {
  await withTempDir("openclaw-exec-completion-route-", async (root) => {
    const sourceSessionKey = "agent:main:telegram:group:-1001:topic:47";
    const storePath = path.join(root, "sessions.json");
    await replaceSessionEntry(
      { agentId: "main", storePath, sessionKey: sourceSessionKey },
      {
        sessionId: "source-session",
        lifecycleRevision: "source-revision",
        updatedAt: Date.now(),
      },
    );
    const exit = createDeferred<RunExit>();
    supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => ({
      ...runtimeManagedRun(input),
      wait: () => exit.promise,
    }));
    const run = await runExecProcess({
      command: "stale-completion-route",
      workdir: root,
      env: {},
      usePty: false,
      warnings: [],
      maxOutput: 1_000,
      pendingMaxOutput: 1_000,
      sessionKey: sourceSessionKey,
      agentId: "main",
      eventRouting: {
        isolateCompletionRun: true,
        expectedSessionGeneration: {
          sessionId: "source-session",
          lifecycleRevision: "source-revision",
        },
        sessionStore: storePath,
      },
      notifyDeliveryContext: {
        channel: "telegram",
        to: "-1001:topic:47",
        threadId: "47",
      },
      notifyOnExit: true,
      timeoutSec: null,
    });
    markBackgrounded(run.session);
    await replaceSessionEntry(
      { agentId: "main", storePath, sessionKey: sourceSessionKey },
      {
        sessionId: "replacement-session",
        lifecycleRevision: "replacement-revision",
        updatedAt: Date.now(),
      },
    );

    exit.resolve(createRunExit());
    await run.promise;

    expect(enqueueSystemEventWithReceiptMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });
});
