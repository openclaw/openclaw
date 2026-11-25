import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { hasUnjoinedWork, runManagedCommand } from "./managed-child-process.mts";

/** Keep cold loading visible without spending the settings operation's deadline on imports. */
export async function runMlxSettingsProducer(options: {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  remainingMs: (ceiling: number) => number;
  observation: Record<string, unknown>;
  bootstrapTimeoutMs?: number;
  operationTimeoutMs?: number;
}): Promise<number> {
  const bootstrapLimit = options.bootstrapTimeoutMs ?? 60_000;
  const operationLimit = options.operationTimeoutMs ?? 30_000;
  for (const limit of [bootstrapLimit, operationLimit]) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("Settings producer deadlines must be positive integers");
    }
  }
  const token = randomUUID();
  const controller = new AbortController();
  const began = performance.now();
  const state: {
    phase: "bootstrap" | "operation" | "complete";
    readyAt?: number;
    error?: Error;
    child?: ChildProcess;
    timer?: ReturnType<typeof setTimeout>;
    deadlineAt?: number;
    expire?: () => void;
  } = { phase: "bootstrap" };
  const observation = options.observation;
  Object.assign(observation, {
    bootstrapReady: false,
    operationSignaledComplete: false,
    processesRetired: false,
  });
  const fail = (error: Error) => {
    state.error ??= error;
    controller.abort();
  };
  const clipped = (ceiling: number) => {
    const value = Math.floor(options.remainingMs(ceiling));
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
      throw new Error("Settings producer has no admitted phase budget");
    }
    return value;
  };
  const arm = (phase: "bootstrap" | "operation", ceiling: number) => {
    clearTimeout(state.timer);
    const allocation = clipped(ceiling);
    observation[`${phase}AllocatedMs`] = allocation;
    state.deadlineAt = performance.now() + allocation;
    state.expire = () => {
      observation.timeoutPhase = phase;
      fail(new Error(`Settings producer ${phase} timed out after ${allocation}ms`));
    };
    state.timer = setTimeout(state.expire, allocation);
  };
  const onMessage = (message: unknown) => {
    if (state.error || controller.signal.aborted) {
      return;
    }
    if (state.deadlineAt !== undefined && performance.now() >= state.deadlineAt) {
      state.expire!();
      return;
    }
    try {
      if (
        !message ||
        typeof message !== "object" ||
        !("token" in message) ||
        message.token !== token ||
        !("kind" in message)
      ) {
        throw new Error("Invalid settings producer handoff");
      }
      if (message.kind === "ready" && state.phase === "bootstrap") {
        state.readyAt = performance.now();
        observation.bootstrapReady = true;
        observation.bootstrapElapsedMs = state.readyAt - began;
        // The operation cannot begin until this external deadline is armed.
        arm("operation", operationLimit);
        state.phase = "operation";
        state.child!.send({ kind: "go", token }, (error) => {
          if (error) {
            fail(new Error("Settings producer start delivery failed", { cause: error }));
          }
        });
      } else if (message.kind === "complete" && state.phase === "operation") {
        state.phase = "complete";
        observation.operationSignaledComplete = true;
        // Keep the operation deadline until the managed owner joins the process tree.
      } else {
        throw new Error("Unexpected or duplicate settings producer handoff");
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  };
  try {
    const overall = clipped(bootstrapLimit + operationLimit);
    arm("bootstrap", bootstrapLimit);
    const code = await runManagedCommand({
      bin: process.execPath,
      args: options.args,
      cwd: options.cwd,
      env: { ...options.env, OPENCLAW_MLX_SETTINGS_PRODUCER_TOKEN: token },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      requireProcessTreeExit: true,
      signal: controller.signal,
      timeoutMs: overall,
      timeoutKillGraceMs: 5_000,
      signalKillGraceMs: 5_000,
      abortKillGraceMs: 5_000,
      cleanupDrainTimeoutMs: 5_000,
      onReady(child) {
        state.child = child;
        observation.leaderPid = child.pid;
        child.on("message", onMessage);
      },
    });
    observation.exitCode = code;
    if (state.error) {
      throw state.error;
    }
    if (code === 0 && state.phase !== "complete") {
      throw new Error("Settings producer exited without completing its admitted operation");
    }
    observation.processesRetired = true;
    return code;
  } catch (error) {
    observation.processesRetired = !hasUnjoinedWork(error);
    if (state.error && state.error !== error) {
      throw new AggregateError([state.error, error], state.error.message, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(state.timer);
    state.child?.removeListener("message", onMessage);
    if (state.readyAt === undefined) {
      observation.bootstrapElapsedMs = performance.now() - began;
    } else {
      observation.operationElapsedMs = performance.now() - state.readyAt;
    }
  }
}
