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
      return { code: 0, stdout: state.daemonId, stderr: "" };
    }
    if (args[0] === "ps") {
      return { code: 0, stdout: state.exists ? childId : "", stderr: "" };
    }
    if (args[0] === "inspect") {
      const id = args.at(-1);
      if (id === parentId) {
        if (!state.parentExists) {
          return { code: 1, stdout: "", stderr: `Error: No such object: ${id}` };
        }
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            Running: true,
            Paused: false,
            Pid: 123,
            StartedAt: state.parentStartedAt,
          }),
        };
      }
      if (!state.exists) {
        return { code: 1, stdout: "", stderr: `Error: No such object: ${id}` };
      }
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
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
      };
    }
    if (args[0] === "rm") {
      removalAttempted.resolve();
      if (!state.refuseRemoval) {
        state.exists = false;
        if (state.spawned) {
          finish();
        }
      }
      return { code: state.refuseRemoval ? 1 : 0, stdout: "", stderr: "" };
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
  };
}

it("does not acknowledge CLI spawn as guest startup and removes a stalled attachment before rejecting", async () => {
  vi.useFakeTimers();
  const f = runtime();
  f.state.startOnSpawn = false;
  const prepared = await f.capability.prepare({
    attemptId,
    custodyScope,
    command,
    signal: f.controller.signal,
    assertCurrent: () => {},
    onOutput: () => {},
  });
  const start = prepared
    .start(async () => {})
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  await f.spawned;
  await vi.advanceTimersByTimeAsync(30_000);
  const error = await start;
  const existsAfterStart = f.state.exists;
  // Join the transport even on the pre-fix path that incorrectly acknowledges startup.
  const stopped = await prepared.stop();
  expect(error).toBeInstanceOf(Error);
  expect(error).toHaveProperty(
    "message",
    "Persistent sandbox command did not start within 30000ms.",
  );
  expect(existsAfterStart).toBe(false);
  expect(f.state.status).toBe("created");
  expect(f.state.exists).toBe(false);
  expect(readDockerPersistentExecExtinctionProof(stopped.extinction)).toEqual(receipt);
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
        const prepared = await f.capability.prepare({
          attemptId,
          custodyScope,
          command,
          signal: f.controller.signal,
          assertCurrent,
          onOutput: () => {},
        });
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
        expect(f.state.exists).toBe(false);
        expect(readDockerPersistentExecExtinctionProof(stopped.extinction)).toEqual(receipt);
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
  const prepared = await f.capability.prepare({
    attemptId,
    custodyScope,
    command,
    signal: f.controller.signal,
    assertCurrent: () => {},
    onOutput: () => {},
  });
  await expect(prepared.start(async () => {})).resolves.toBeUndefined();
  const stopped = await prepared.stopped;
  expect(stopped).toMatchObject({ reason: "source-exited", exitCode: 0 });
  expect(readDockerPersistentExecExtinctionProof(stopped.extinction)).toEqual(receipt);
  expect(f.state.exists).toBe(false);
});

it.each(["parent", "prepared child", "started child"] as const)(
  "cancels a pending %s probe through the cron owner before its stop deadline",
  async (probe) => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("control probe timeout")), ms);
      return controller.signal;
    });
    const f = runtime();
    const inspecting = createDeferredCore();
    const execute = mocks.exec.getMockImplementation()!;
    let held = false;
    let preparedReady = false;
    mocks.exec.mockImplementation(async (...args) => {
      const requestedProbe =
        probe === "parent"
          ? args[1][0] === "info"
          : args[1][0] === "inspect" &&
            args[1].at(-1) === childId &&
            (probe === "started child" ? f.state.spawned : !f.state.spawned);
      if (!held && preparedReady && requestedProbe) {
        held = true;
        inspecting.resolve();
        const signal: AbortSignal = args[2].signal;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error("Docker inspection aborted"),
              ),
            { once: true },
          );
        });
      }
      return await execute(...args);
    });
    const { watchers, fake, updateState } = createCronStreamWatcherFixture({
      spawnSandboxSource: async (
        input: Parameters<NonNullable<CronStreamOwnerParams["spawnSandboxSource"]>>[0],
      ) => {
        const prepared = await f.capability.prepare({
          attemptId,
          custodyScope,
          command,
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
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("control probe timeout")), ms);
    return controller.signal;
  });
  const f = runtime();
  const inspecting = createDeferredCore();
  const execute = mocks.exec.getMockImplementation()!;
  let held = false;
  mocks.exec.mockImplementation(async (...args) => {
    if (!held && args[1][0] === "inspect" && args[1].at(-1) === childId) {
      held = true;
      inspecting.resolve();
      const signal: AbortSignal = args[2].signal;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () =>
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error("Docker inspection aborted"),
            ),
          { once: true },
        );
      });
    }
    return await execute(...args);
  });
  let prepareOutcome: unknown = "pending";
  const preparing = f.capability
    .prepare({
      attemptId,
      custodyScope,
      command,
      signal: f.controller.signal,
      assertCurrent: () => {},
      onOutput: () => {},
    })
    .then(
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
  expect(f.state.exists).toBe(false);
  expect(readDockerPersistentExecExtinctionProof(stopped.extinction)).toEqual(receipt);
});

it.each(["stop", "revocation"] as const)(
  "rejects startup after %s while Docker's started-state inspection is pending",
  async (interruption) => {
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("authority revoked");
      }
    };
    const f = runtime(assertCurrent);
    const prepared = await f.capability.prepare({
      attemptId,
      custodyScope,
      command,
      signal: f.controller.signal,
      assertCurrent,
      onOutput: () => {},
    });
    const inspecting = createDeferredCore();
    const release = createDeferredCore();
    const execute = mocks.exec.getMockImplementation()!;
    let held = false;
    mocks.exec.mockImplementation(async (...args) => {
      const result = await execute(...args);
      if (!held && f.state.spawned && args[1][0] === "inspect" && args[1].at(-1) === childId) {
        held = true;
        inspecting.resolve();
        await release.promise;
      }
      return result;
    });
    const rejection = expect(prepared.start(async () => {})).rejects.toThrow(
      interruption === "revocation" ? "authority revoked" : "stopped during START",
    );
    await inspecting.promise;
    const cleanup = interruption === "stop" ? prepared.stop() : undefined;
    current = interruption !== "revocation";
    release.resolve();
    await rejection;
    await cleanup;
    expect(f.state.exists).toBe(false);
    const stopped = await prepared.stopped;
    expect(readDockerPersistentExecExtinctionProof(stopped.extinction)).toEqual(receipt);
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
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("authority revoked");
      }
    };
    const f = runtime(assertCurrent);
    const prepared = await f.capability.prepare({
      attemptId,
      custodyScope,
      command,
      signal: f.controller.signal,
      assertCurrent,
      onOutput: () => {},
    });
    expect(f.allocate).toHaveBeenCalledWith(expect.objectContaining({ command }));
    expect(mocks.spawn).not.toHaveBeenCalled();
    let cleanup: ReturnType<typeof prepared.stop> | undefined;
    const interrupt = () => {
      if (interruption === "revocation") {
        current = false;
      } else {
        cleanup = prepared.stop();
      }
    };
    if (during === "probe") {
      let interrupted = false;
      const execute = mocks.exec.getMockImplementation()!;
      mocks.exec.mockImplementation(async (...args) => {
        const result = await execute(...args);
        if (!interrupted) {
          interrupted = true;
          interrupt();
        }
        return result;
      });
    }
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const admit = vi.fn(async () => {
      entered.resolve();
      await release.promise;
    });
    const rejection = expect(prepared.start(admit)).rejects.toThrow(
      interruption === "revocation"
        ? "authority revoked"
        : during === "probe"
          ? "no longer available for START"
          : "stopped during START admission",
    );
    if (during === "admission") {
      await entered.promise;
      expect(mocks.spawn).not.toHaveBeenCalled();
      interrupt();
    }
    release.resolve();
    await rejection;
    await cleanup;
    expect(admit).toHaveBeenCalledTimes(during === "admission" ? 1 : 0);
    expect(mocks.spawn).not.toHaveBeenCalled();
    const stopped = await prepared.stop();
    expect(readDockerPersistentExecExtinctionProof(stopped.extinction)).toEqual(receipt);
    expect(f.state.exists).toBe(false);
    expect(
      mocks.exec.mock.calls.filter(([, args]) => args[0] === "rm").map(([, args]) => args),
    ).toEqual([["rm", "--force", "--volumes", childId]]);
  },
);

it.each(["removed", "restarted"] as const)(
  "refuses START when the physical parent is %s during durable admission",
  async (change) => {
    const f = runtime();
    const prepared = await f.capability.prepare({
      attemptId,
      custodyScope,
      command,
      signal: f.controller.signal,
      assertCurrent: () => {},
      onOutput: () => {},
    });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const started = prepared
      .start(async () => {
        entered.resolve();
        await release.promise;
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await entered.promise;
    expect(mocks.spawn).not.toHaveBeenCalled();
    if (change === "removed") {
      f.state.parentExists = false;
    } else {
      f.state.parentStartedAt = "2026-02-01T00:00:00.000Z";
    }
    release.resolve();
    const error = await started;
    // Join cleanup even on a regression that incorrectly starts the child.
    const stopped = await prepared.stop();
    expect(readDockerPersistentExecExtinctionProof(stopped.extinction)).toEqual(receipt);
    expect(f.state.exists).toBe(false);
    expect(mocks.spawn.mock.calls).toHaveLength(0);
    expect(error).toBeInstanceOf(Error);
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
  const prepared = await f.capability.prepare({
    attemptId,
    custodyScope,
    command,
    signal: f.controller.signal,
    assertCurrent: () => {},
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
  const prepared = await f.capability.prepare({
    attemptId,
    custodyScope,
    command,
    signal: f.controller.signal,
    assertCurrent: () => {},
    onOutput: () => {},
  });
  await prepared.start(async () => {});
  f.state.refuseRemoval = true;
  f.finish(false, true);
  await expect(prepared.stopped).rejects.toThrow("still exists");
  expect(f.state.exists).toBe(true);
  f.state.refuseRemoval = false;
  const stopped = await prepared.stop();
  expect(readDockerPersistentExecExtinctionProof(stopped.extinction)).toEqual(receipt);
  expect(f.state.exists).toBe(false);
  expect(mocks.spawn).toHaveBeenCalledOnce();
});

it.each(["replaced", "removed"] as const)(
  "refuses continued execution after the parent container is %s while retaining child cleanup",
  async (change) => {
    const f = runtime();
    const prepared = await f.capability.prepare({
      attemptId,
      custodyScope,
      command,
      signal: f.controller.signal,
      assertCurrent: () => {},
      onOutput: () => {},
    });
    await prepared.start(async () => {});
    if (change === "replaced") {
      f.state.parentStartedAt = "2026-02-01T00:00:00.000Z";
    } else {
      f.state.parentExists = false;
    }
    await expect(prepared.checkCurrent()).rejects.toThrow("sandbox container generation has ended");
    const stopped = await prepared.stop();
    expect(readDockerPersistentExecExtinctionProof(stopped.extinction)).toEqual(receipt);
    expect(f.state.exists).toBe(false);
    expect(mocks.spawn).toHaveBeenCalledOnce();
  },
);

it.each(["before removal", "after removal"] as const)(
  "refuses extinction proof when the original Docker daemon changes %s",
  async (timing) => {
    const f = runtime();
    if (timing === "before removal") {
      f.state.daemonId = "replacement-daemon";
    } else {
      const execute = mocks.exec.getMockImplementation()!;
      mocks.exec.mockImplementation(async (...args) => {
        const result = await execute(...args);
        if (args[1][0] === "rm") {
          f.state.daemonId = "replacement-daemon";
        }
        return result;
      });
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
