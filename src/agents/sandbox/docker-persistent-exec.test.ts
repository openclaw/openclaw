import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeCronStreamSandboxTarget } from "../../cron/stream-sandbox.test-support.js";
import type { CronStreamOwnerParams } from "../../gateway/cron-stream-owner-types.js";
import {
  createCronStreamWatcherFixture,
  exitResult,
  job,
} from "../../gateway/cron-stream-watchers.test-helpers.js";
import { getSpawnBroker, runWithSpawnBroker } from "../../process/spawn-broker/context.js";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "../../process/spawn-broker/host.js";
import { supportsSpawnBrokerCommandTransport } from "../../process/spawn-broker/pipe.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createEnteredGate } from "../entered-gate.test-support.js";
import {
  createDockerPersistentExecCapability,
  listDockerPersistentExecContainers,
  readDockerPersistentExecExtinctionProof,
  stopDockerPersistentExec,
} from "./docker-persistent-exec.js";
import {
  dockerPersistentExecContainerName,
  type DockerPersistentExecReceipt,
} from "./persistent-exec.types.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), exec: vi.fn() }));
// mock-isolation: Docker transport and engine I/O are the external boundary of this owner test.
vi.mock("../../process/exec.js", () => ({
  spawnCommand: mocks.spawn,
  isPlainCommandExitFailure: () => false,
}));
// mock-isolation: the in-memory transport has no OS process spawn event or command scope.
vi.mock("../../process/exec-spawn.js", () => ({
  runOutsideCommandProcessScope: <T>(run: () => T) => run(),
  waitForCommandSpawn: async () => {},
}));
// mock-isolation: expose Docker replies without booting a daemon or an unrelated backend.
vi.mock("./container-engine.js", () => ({
  DOCKER_SANDBOX_ENGINE: { id: "docker", command: "docker", displayName: "Docker" },
  execContainer: mocks.exec,
}));

const target = {
  kind: "docker" as const,
  endpoint: "unix:///original/docker.sock",
  daemonId: "original-daemon",
};
const parentId = "a".repeat(64);
const childId = "b".repeat(64);
const attemptId = "00000000-0000-4000-8000-000000000001";
const custodyScope = "c".repeat(64);
const parentStartedAt = "2026-01-01T00:00:00.000Z";
const receipt: DockerPersistentExecReceipt = {
  version: 1,
  target,
  attemptId,
  parentContainerId: parentId,
  containerId: childId,
};
const command = { argv: ["python3", "/workspace/watch.py"], cwd: "/workspace" };
const engineReply = (stdout = "", code = 0, stderr = "") => ({ code, stdout, stderr });
const outcome = (promise: Promise<void>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

beforeEach(() => {
  mocks.spawn.mockReset();
  mocks.exec.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function runtime(assertCurrent = () => {}) {
  const controller = new AbortController();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const child = new ChildProcess();
  child.stdout = output;
  child.stderr = stderr;
  const ended = createDeferredCore<{ failed: boolean; exitCode: number }>();
  const spawned = createDeferredCore();
  const removalAttempted = createDeferredCore();
  const state = {
    exists: true,
    status: "created",
    startedAt: "0001-01-01T00:00:00Z",
    startOnSpawn: true,
    daemonId: target.daemonId,
    parentId,
    parentStartedAt,
    parentExists: true,
    custodyScope,
    refuseRemoval: false,
    spawned: false,
  };
  const finish = (natural = false, failed = false) => {
    if (natural) {
      state.status = "exited";
    }
    output.end();
    stderr.end();
    ended.resolve({ failed, exitCode: failed ? 1 : 0 });
  };
  mocks.exec.mockImplementation(async (_engine, args: string[]) => {
    if (args[0] === "info") {
      return engineReply(state.daemonId);
    }
    if (args[0] === "ps") {
      return engineReply(state.exists ? childId : "");
    }
    if (args[0] === "inspect") {
      const id = args.at(-1);
      if (id === parentId) {
        if (!state.parentExists) {
          return engineReply("", 1, `Error: No such object: ${id}`);
        }
        return engineReply(
          JSON.stringify({
            Running: true,
            Paused: false,
            Pid: 123,
            StartedAt: state.parentStartedAt,
          }),
        );
      }
      if (!state.exists) {
        return engineReply("", 1, `Error: No such object: ${id}`);
      }
      return engineReply(
        JSON.stringify({
          Id: childId,
          Name: `/${dockerPersistentExecContainerName(attemptId)}`,
          Config: {
            Labels: {
              "openclaw.persistentExecAttempt": attemptId,
              "openclaw.persistentExecParentId": state.parentId,
              "openclaw.streamStore": state.custodyScope,
            },
          },
          State: { Status: state.status, StartedAt: state.startedAt, ExitCode: 0 },
        }),
      );
    }
    if (args[0] === "rm") {
      removalAttempted.resolve();
      if (!state.refuseRemoval) {
        state.exists = false;
        if (state.spawned) {
          finish();
        }
      }
      return engineReply("", state.refuseRemoval ? 1 : 0);
    }
    throw new Error(`Unexpected Docker operation: ${args[0]}`);
  });
  mocks.spawn.mockImplementation(() => {
    state.spawned = true;
    if (state.startOnSpawn) {
      state.status = "running";
      state.startedAt = parentStartedAt;
    }
    spawned.resolve();
    return Object.assign(ended.promise, {
      nodeChildProcess: child,
      kill: vi.fn(() => finish()),
    });
  });
  const allocate = vi.fn(async () => childId);
  const capability = createDockerPersistentExecCapability({
    target,
    containerId: parentId,
    containerStartedAt: parentStartedAt,
    containerName: "agent-sandbox",
    workdir: "/workspace",
    configHash: "configured-sandbox",
    imageReference: "fixture-image",
    resolveImage: async () => `sha256:${"d".repeat(64)}`,
    assertCurrent,
    allocate,
  });
  return {
    controller,
    state,
    output,
    finish,
    spawned: spawned.promise,
    removalAttempted,
    allocate,
    capability,
    prepare(overrides: Partial<Parameters<typeof capability.prepare>[0]> = {}) {
      return capability.prepare({
        attemptId,
        custodyScope,
        command,
        signal: controller.signal,
        assertCurrent: () => {},
        onOutput: () => {},
        ...overrides,
      });
    },
  };
}

function cancellableProbes() {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("control probe timeout")), ms);
    return controller.signal;
  });
}

function awaitAbort(signal: AbortSignal) {
  return new Promise<void>((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        const reason: unknown = signal.reason;
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      },
      { once: true },
    );
  });
}

function interceptOnce(
  matches: (args: string[]) => boolean,
  intercept: (signal: AbortSignal) => Promise<void>,
  after = false,
) {
  const execute = mocks.exec.getMockImplementation()!;
  let held = false;
  mocks.exec.mockImplementation(async (...args) => {
    const selected = !held && matches(args[1]);
    held ||= selected;
    if (selected && !after) {
      await intercept(args[2].signal);
    }
    const result = await execute(...args);
    if (selected && after) {
      await intercept(args[2].signal);
    }
    return result;
  });
}

function expectExtinct(
  f: ReturnType<typeof runtime>,
  stopped: Awaited<ReturnType<typeof stopDockerPersistentExec>>,
) {
  expect(readDockerPersistentExecExtinctionProof(stopped.extinction)).toEqual(receipt);
  expect(f.state.exists).toBe(false);
}

function revocableRuntime() {
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new Error("authority revoked");
    }
  };
  return {
    ...runtime(assertCurrent),
    assertCurrent,
    revoke: () => {
      current = false;
    },
  };
}

it("does not acknowledge CLI spawn as guest startup and removes a stalled attachment before rejecting", async () => {
  vi.useFakeTimers();
  const f = runtime();
  f.state.startOnSpawn = false;
  const prepared = await f.prepare();
  const start = outcome(prepared.start(async () => {}));
  await f.spawned;
  await vi.advanceTimersByTimeAsync(30_000);
  const error = await start;
  const existsAfterStart = f.state.exists;
  // Join the transport even on the pre-fix path that incorrectly acknowledges startup.
  const stopped = await prepared.stop();
  expect(error).toHaveProperty(
    "message",
    "Persistent sandbox command did not start within 30000ms.",
  );
  expect(existsAfterStart).toBe(false);
  expect(f.state.status).toBe("created");
  expectExtinct(f, stopped);
});

describe.skipIf(!supportsSpawnBrokerCommandTransport())("persistent START broker scope", () => {
  let broker: SpawnBrokerHost;
  beforeAll(async () => {
    broker = createSpawnBrokerHost();
    await broker.ready();
  });
  afterAll(async () => {
    await broker.close();
  });

  it.each([true, false])(
    "keeps final authority and native launch together (current: %s)",
    async (currentAtLaunch) => {
      let current = true;
      let checkedAtNativeLaunch = false;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("stream authority revoked");
        }
        if (getSpawnBroker() === undefined) {
          checkedAtNativeLaunch = true;
        }
      };
      const f = runtime(assertCurrent);
      const spawn = mocks.spawn.getMockImplementation()!;
      let launchedWithCurrentAuthority = false;
      let transportCancelled = false;
      mocks.spawn.mockImplementation((argv, options: { cancelSignal?: AbortSignal }) => {
        if (getSpawnBroker()) {
          throw new Error("Persistent START entered queued broker transport");
        }
        launchedWithCurrentAuthority = current && checkedAtNativeLaunch;
        const transport = spawn(argv, options);
        options.cancelSignal?.addEventListener(
          "abort",
          () => {
            transportCancelled = true;
            f.finish(false, true);
          },
          { once: true },
        );
        return transport;
      });
      await runWithSpawnBroker(broker, async () => {
        const prepared = await f.prepare({ assertCurrent });
        const starting = prepared.start(async () => {
          current = currentAtLaunch;
        });
        if (currentAtLaunch) {
          await starting;
          expect(launchedWithCurrentAuthority).toBe(true);
          f.controller.abort(new Error("stream owner cancelled"));
        } else {
          await expect(starting).rejects.toThrow("stream authority revoked");
          expect(mocks.spawn).not.toHaveBeenCalled();
        }
        const stopped = await prepared.stopped;
        expect(getSpawnBroker()).toBe(broker);
        expect(transportCancelled).toBe(currentAtLaunch);
        expectExtinct(f, stopped);
      });
      expect(getSpawnBroker()).toBeUndefined();
    },
  );
});

it("accepts Docker's recorded start when a command exits before startup observation", async () => {
  const f = runtime();
  const spawn = mocks.spawn.getMockImplementation()!;
  mocks.spawn.mockImplementation((...args) => {
    const transport = spawn(...args);
    f.finish(true);
    return transport;
  });
  const prepared = await f.prepare();
  await expect(prepared.start(async () => {})).resolves.toBeUndefined();
  const stopped = await prepared.stopped;
  expect(stopped).toMatchObject({ reason: "source-exited", exitCode: 0 });
  expectExtinct(f, stopped);
});

it.each(["parent", "prepared child", "started child"] as const)(
  "cancels a pending %s probe through the cron owner before its stop deadline",
  async (probe) => {
    cancellableProbes();
    const f = runtime();
    const inspecting = createDeferredCore();
    let preparedReady = false;
    interceptOnce(
      (args) =>
        preparedReady &&
        (probe === "parent"
          ? args[0] === "info"
          : args[0] === "inspect" &&
            args.at(-1) === childId &&
            (probe === "started child" ? f.state.spawned : !f.state.spawned)),
      async (signal) => {
        inspecting.resolve();
        await awaitAbort(signal);
      },
    );
    const { watchers, fake, updateState } = createCronStreamWatcherFixture({
      spawnSandboxSource: async (
        input: Parameters<NonNullable<CronStreamOwnerParams["spawnSandboxSource"]>>[0],
      ) => {
        const prepared = await f.prepare({
          assertCurrent: input.assertCurrent,
          signal: input.signal,
          onOutput: input.onOutput,
        });
        preparedReady = true;
        await prepared.start(async () => {});
        return {
          runId: attemptId,
          startedAtMs: Date.now(),
          activity: { resultSettled: false, lastOutputAtMs: Date.now() },
          cancel: () => {
            void prepared.stop();
          },
          wait: async () => {
            await prepared.stopped;
            return exitResult();
          },
          waitForExtinction: async () => {
            await prepared.stop();
          },
        };
      },
    });
    const streamJob = { ...job(), streamSandbox: makeCronStreamSandboxTarget() };
    const starting = watchers.start(streamJob);
    await inspecting.promise;
    let stopOutcome: unknown = "pending";
    const stopping = watchers.stop(streamJob.id, "disabled").then(
      () => {
        stopOutcome = undefined;
      },
      (error: unknown) => {
        stopOutcome = error;
      },
    );
    await vi.advanceTimersByTimeAsync(20_000);
    const outcomeAtDeadline = stopOutcome;
    // Join the pre-fix startup timeout too; the held inspection is released only by abort.
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([starting, stopping]);
    await watchers.stopAll("shutdown");
    expect(outcomeAtDeadline).toBeUndefined();
    expect(watchers.inspect(streamJob.id)).toMatchObject({ state: "stopped" });
    expect(f.state.exists).toBe(false);
    expect(fake.spawn).not.toHaveBeenCalled();
    expect(updateState.mock.calls.some(([, patch]) => patch.streamStatus === "running")).toBe(
      false,
    );
  },
);

it("interrupts the prepared-container inspection without losing its cleanup identity", async () => {
  cancellableProbes();
  const f = runtime();
  const inspecting = createDeferredCore();
  interceptOnce(
    (args) => args[0] === "inspect" && args.at(-1) === childId,
    async (signal) => {
      inspecting.resolve();
      await awaitAbort(signal);
    },
  );
  let prepareOutcome: unknown = "pending";
  const preparing = f.prepare().then(
    () => {
      prepareOutcome = undefined;
    },
    (error: unknown) => {
      prepareOutcome = error;
    },
  );
  await inspecting.promise;
  f.controller.abort(new Error("preparation cancelled"));
  await vi.advanceTimersByTimeAsync(0);
  const afterCancellation = prepareOutcome;
  await vi.advanceTimersByTimeAsync(30_000);
  await preparing;
  // Preparation did not publish a child ID; recovery uses its reserved attempt identity.
  const stopped = await stopDockerPersistentExec({
    target,
    attemptId,
    parentContainerId: parentId,
  });
  expect(afterCancellation).toHaveProperty("message", "preparation cancelled");
  expect(mocks.spawn).not.toHaveBeenCalled();
  expectExtinct(f, stopped);
});

it.each(["stop", "revocation"] as const)(
  "rejects startup after %s while Docker's started-state inspection is pending",
  async (interruption) => {
    const f = revocableRuntime();
    const prepared = await f.prepare({ assertCurrent: f.assertCurrent });
    const inspection = createEnteredGate();
    interceptOnce(
      (args) => f.state.spawned && args[0] === "inspect" && args.at(-1) === childId,
      inspection.wait,
      true,
    );
    const rejection = expect(prepared.start(async () => {})).rejects.toThrow(
      interruption === "revocation" ? "authority revoked" : "stopped during START",
    );
    await inspection.entered;
    const cleanup = interruption === "stop" ? prepared.stop() : undefined;
    if (interruption === "revocation") {
      f.revoke();
    }
    inspection.release();
    await rejection;
    await cleanup;
    expectExtinct(f, await prepared.stopped);
  },
);

it.each([
  { interruption: "revocation", during: "probe" },
  { interruption: "cleanup", during: "probe" },
  { interruption: "revocation", during: "admission" },
  { interruption: "cleanup", during: "admission" },
] as const)(
  "keeps allocation inert and refuses START after $interruption during its awaited $during",
  async ({ interruption, during }) => {
    const f = revocableRuntime();
    const prepared = await f.prepare({ assertCurrent: f.assertCurrent });
    expect(f.allocate).toHaveBeenCalledWith(expect.objectContaining({ command }));
    expect(mocks.spawn).not.toHaveBeenCalled();
    let cleanup: ReturnType<typeof prepared.stop> | undefined;
    const interrupt = () => {
      if (interruption === "revocation") {
        f.revoke();
      } else {
        cleanup = prepared.stop();
      }
    };
    if (during === "probe") {
      interceptOnce(
        () => true,
        async () => interrupt(),
        true,
      );
    }
    const admission = createEnteredGate();
    const admit = vi.fn(admission.wait);
    const rejection = expect(prepared.start(admit)).rejects.toThrow(
      interruption === "revocation"
        ? "authority revoked"
        : during === "probe"
          ? "no longer available for START"
          : "stopped during START admission",
    );
    if (during === "admission") {
      await admission.entered;
      expect(mocks.spawn).not.toHaveBeenCalled();
      interrupt();
    }
    admission.release();
    await rejection;
    await cleanup;
    expect(admit).toHaveBeenCalledTimes(during === "admission" ? 1 : 0);
    expect(mocks.spawn).not.toHaveBeenCalled();
    const stopped = await prepared.stop();
    expectExtinct(f, stopped);
    expect(
      mocks.exec.mock.calls.filter(([, args]) => args[0] === "rm").map(([, args]) => args),
    ).toEqual([["rm", "--force", "--volumes", childId]]);
  },
);

it.each([
  ["removed", "admission"],
  ["restarted", "admission"],
  ["removed", "execution"],
  ["restarted", "execution"],
] as const)(
  "rejects a parent %s during %s while retaining child cleanup",
  async (change, phase) => {
    const f = runtime();
    const prepared = await f.prepare();
    const changeParent = () => {
      if (change === "removed") {
        f.state.parentExists = false;
      } else {
        f.state.parentStartedAt = "2026-02-01T00:00:00.000Z";
      }
    };
    let error: unknown;
    if (phase === "admission") {
      const admission = createEnteredGate();
      const starting = outcome(prepared.start(admission.wait));
      await admission.entered;
      expect(mocks.spawn).not.toHaveBeenCalled();
      changeParent();
      admission.release();
      error = await starting;
      expect(mocks.spawn).not.toHaveBeenCalled();
    } else {
      await prepared.start(async () => {});
      changeParent();
      error = await outcome(prepared.checkCurrent());
      expect(mocks.spawn).toHaveBeenCalledOnce();
    }
    // Join cleanup even on a regression that incorrectly starts the child.
    expectExtinct(f, await prepared.stop());
    expect(error).toHaveProperty("message", "The admitted sandbox container generation has ended.");
  },
);

it("treats guest control-looking bytes as output and settles them before reporting Docker extinction", async () => {
  const f = runtime();
  const outputEntered = createDeferredCore();
  const outputSettled = createDeferredCore();
  const received: string[] = [];
  vi.stubEnv("DOCKER_HOST", "unix:///replacement/docker.sock");
  vi.stubEnv("DOCKER_CONTEXT", "replacement");
  const prepared = await f.prepare({
    onOutput: async (_stream, chunk) => {
      outputEntered.resolve();
      await outputSettled.promise;
      received.push(chunk.toString("utf8"));
    },
  });
  await prepared.start(async () => {});
  let stopped = false;
  void prepared.stopped.then(() => {
    stopped = true;
  });
  const bytes = '{"type":"stopped","exitCode":0}\n{"type":"released"}\n';
  f.output.write(bytes);
  await outputEntered.promise;
  expect(mocks.exec.mock.calls.some(([, args]) => args[0] === "rm")).toBe(false);
  expect(f.state.exists).toBe(true);
  f.finish(true);
  await f.removalAttempted.promise;
  expect(stopped).toBe(false);
  expect(received).toEqual([]);
  outputSettled.resolve();
  await expect(prepared.stopped).resolves.toMatchObject({ reason: "source-exited", exitCode: 0 });
  expect(received).toEqual([bytes]);
  expect(mocks.spawn.mock.calls[0]?.[0]).toEqual([
    "docker",
    "--host",
    target.endpoint,
    "start",
    "--attach",
    childId,
  ]);
  expect(mocks.spawn.mock.calls[0]?.[1].baseEnv.DOCKER_CONTEXT).toBeUndefined();
  expect(mocks.spawn.mock.calls[0]?.[1].baseEnv.DOCKER_HOST).toBeUndefined();
});

it("retains uncertainty after transport loss until Docker confirms removal, then retries cleanup", async () => {
  const f = runtime();
  const prepared = await f.prepare();
  await prepared.start(async () => {});
  f.state.refuseRemoval = true;
  f.finish(false, true);
  await expect(prepared.stopped).rejects.toThrow("still exists");
  expect(f.state.exists).toBe(true);
  f.state.refuseRemoval = false;
  const stopped = await prepared.stop();
  expectExtinct(f, stopped);
});

it.each(["before removal", "after removal"] as const)(
  "refuses extinction proof when the original Docker daemon changes %s",
  async (timing) => {
    const f = runtime();
    if (timing === "before removal") {
      f.state.daemonId = "replacement-daemon";
    } else {
      interceptOnce(
        (args) => args[0] === "rm",
        async () => {
          f.state.daemonId = "replacement-daemon";
        },
        true,
      );
    }
    await expect(stopDockerPersistentExec(receipt)).rejects.toThrow("daemon changed");
    expect(f.state.exists).toBe(timing === "before removal");
    expect(mocks.spawn).not.toHaveBeenCalled();
  },
);

it.each(["matching", "wrong parent", "absent"] as const)(
  "reconciles an allocation without a saved child ID only when its ownership is %s",
  async (identity) => {
    const f = runtime();
    f.state.parentId = identity === "wrong parent" ? "e".repeat(64) : parentId;
    f.state.exists = identity !== "absent";
    const cleanup = { target, attemptId, parentContainerId: parentId };
    if (identity === "wrong parent") {
      await expect(stopDockerPersistentExec(cleanup)).rejects.toThrow("does not match");
      expect(f.state.exists).toBe(true);
      expect(mocks.exec.mock.calls.some(([, args]) => args[0] === "rm")).toBe(false);
    } else {
      const stopped = await stopDockerPersistentExec(cleanup);
      expect(readDockerPersistentExecExtinctionProof(stopped.extinction)).toEqual(
        identity === "absent" ? cleanup : receipt,
      );
      expect(f.state.exists).toBe(false);
    }
    expect(mocks.spawn).not.toHaveBeenCalled();
  },
);

it.each(["current", "foreign"] as const)(
  "restricts orphan discovery to the %s physical store custody scope",
  async (scope) => {
    const f = runtime();
    if (scope === "foreign") {
      f.state.custodyScope = "f".repeat(64);
    }
    await expect(listDockerPersistentExecContainers(target, custodyScope)).resolves.toEqual(
      scope === "current" ? [receipt] : [],
    );
    expect(mocks.exec.mock.calls.find(([, args]) => args[0] === "ps")?.[1]).toContain(
      `label=openclaw.streamStore=${custodyScope}`,
    );
    expect(mocks.exec.mock.calls.some(([, args]) => args[0] === "rm")).toBe(false);
  },
);
