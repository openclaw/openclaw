import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
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
function observeOutcome(promise: Promise<unknown>) {
  let value: unknown = "pending";
  const settled = promise.then(
    () => {
      value = undefined;
    },
    (error: unknown) => {
      value = error;
    },
  );
  return { settled, read: () => value };
}

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
  let current = true;
  const assertActive = () => {
    if (!current) {
      throw new Error("authority revoked");
    }
    assertCurrent();
  };
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
      if (!(id === parentId ? state.parentExists : state.exists)) {
        return engineReply("", 1, `Error: No such object: ${id}`);
      }
      if (id === parentId) {
        return engineReply(
          JSON.stringify({
            Running: true,
            Paused: false,
            Pid: 123,
            StartedAt: state.parentStartedAt,
          }),
        );
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
  const capability = createDockerPersistentExecCapability({
    target,
    containerId: parentId,
    containerStartedAt: parentStartedAt,
    containerName: "agent-sandbox",
    workdir: "/workspace",
    configHash: "configured-sandbox",
    imageReference: "fixture-image",
    resolveImage: async () => `sha256:${"d".repeat(64)}`,
    assertCurrent: assertActive,
    allocate: async () => childId,
  });
  return {
    controller,
    state,
    output,
    finish,
    spawned: spawned.promise,
    removalAttempted,
    assertCurrent: assertActive,
    revoke: () => {
      current = false;
    },
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

const awaitAbort = (signal: AbortSignal) => withinTest(new Promise<never>(() => {}), signal);

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
    const stopping = observeOutcome(watchers.stop(streamJob.id, "disabled"));
    await vi.advanceTimersByTimeAsync(20_000);
    const outcomeAtDeadline = stopping.read();
    // Join the pre-fix startup timeout too; the held inspection is released only by abort.
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([starting, stopping.settled]);
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
  const preparing = observeOutcome(f.prepare());
  await inspecting.promise;
  f.controller.abort(new Error("preparation cancelled"));
  await vi.advanceTimersByTimeAsync(0);
  const afterCancellation = preparing.read();
  await vi.advanceTimersByTimeAsync(30_000);
  await preparing.settled;
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

const generationEnded = "The admitted sandbox container generation has ended.";
it.each([
  ["revocation", "probe", "authority revoked"],
  ["cleanup", "probe", "no longer available for START"],
  ["revocation", "admission", "authority revoked"],
  ["cleanup", "admission", "stopped during START admission"],
  ["revocation", "started inspection", "authority revoked"],
  ["cleanup", "started inspection", "stopped during START"],
  ["removed", "admission", generationEnded],
  ["restarted", "admission", generationEnded],
  ["removed", "execution", generationEnded],
  ["restarted", "execution", generationEnded],
] as const)(
  "rejects %s during %s (%s) and retains child cleanup",
  async (interruption, during, message) => {
    const f = runtime();
    const prepared = await f.prepare({ assertCurrent: f.assertCurrent });
    expect(mocks.spawn).not.toHaveBeenCalled();
    const gate = createEnteredGate();
    if (during === "probe" || during === "started inspection") {
      interceptOnce(
        (args) =>
          during === "probe" ||
          (f.state.spawned && args[0] === "inspect" && args.at(-1) === childId),
        gate.wait,
        true,
      );
    }
    const admit = vi.fn(during === "admission" ? gate.wait : async () => {});
    let starting: ReturnType<typeof outcome>;
    if (during === "execution") {
      await prepared.start(admit);
      starting = Promise.resolve(undefined);
    } else {
      starting = outcome(prepared.start(admit));
      await gate.entered;
      if (during !== "started inspection") {
        expect(mocks.spawn).not.toHaveBeenCalled();
      }
    }
    const cleanup = interruption === "cleanup" ? prepared.stop() : undefined;
    if (interruption === "revocation") {
      f.revoke();
    } else if (interruption === "removed") {
      f.state.parentExists = false;
    } else if (interruption === "restarted") {
      f.state.parentStartedAt = "2026-02-01T00:00:00.000Z";
    }
    gate.release();
    const error = await (during === "execution" ? outcome(prepared.checkCurrent()) : starting);
    await cleanup;
    const stopped = await prepared.stop();
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty(
      "message",
      message === generationEnded ? message : expect.stringContaining(message),
    );
    expect(admit).toHaveBeenCalledTimes(during === "probe" ? 0 : 1);
    expect(mocks.spawn).toHaveBeenCalledTimes(
      during === "started inspection" || during === "execution" ? 1 : 0,
    );
    expectExtinct(f, stopped);
    expect(
      mocks.exec.mock.calls.filter(([, args]) => args[0] === "rm").map(([, args]) => args),
    ).toEqual([["rm", "--force", "--volumes", childId]]);
  },
);

it("treats guest control-looking bytes as output and settles them before reporting Docker extinction", async () => {
  const f = runtime();
  const output = createEnteredGate();
  const received: string[] = [];
  vi.stubEnv("DOCKER_HOST", "unix:///replacement/docker.sock");
  vi.stubEnv("DOCKER_CONTEXT", "replacement");
  const prepared = await f.prepare({
    onOutput: async (_stream, chunk) => {
      await output.wait();
      received.push(chunk.toString("utf8"));
    },
  });
  await prepared.start(async () => {});
  const stopping = observeOutcome(prepared.stopped);
  const bytes = '{"type":"stopped","exitCode":0}\n{"type":"released"}\n';
  f.output.write(bytes);
  await output.entered;
  expect(mocks.exec.mock.calls.some(([, args]) => args[0] === "rm")).toBe(false);
  expect(f.state.exists).toBe(true);
  f.finish(true);
  await f.removalAttempted.promise;
  expect(stopping.read()).toBe("pending");
  expect(received).toEqual([]);
  output.release();
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
