import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { resolveStateDir } from "../config/paths.js";
import { hasErrnoCode } from "../infra/errors.js";
import { logWarn } from "../logger.js";
import { getSpawnBroker, runWithSpawnBroker } from "../process/spawn-broker/context.js";
import type { ManagedRun, RunExit, SpawnInput } from "../process/supervisor/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createDurableProcessStore,
  type DurableProcessRecord,
} from "./bash-durable-process-store.js";
import { prepareAdoptedDurableProcessNotification } from "./bash-process-durable-notify.js";
import {
  addSession,
  appendOutput,
  createProcessSession,
  listExecSessionsForCancellation,
  setDurableProcessObserver,
  type ProcessSession,
  waitForExecSession,
} from "./bash-process-registry.js";
import {
  cleanupDurableProcess,
  durableProcessUnitName,
  launchDurableProcess,
  readDurableProcess,
  requireDurableProcessHost,
  stopDurableProcess,
} from "./bash-process-systemd.js";
import { maybeNotifyOnExit } from "./bash-tools.exec-notify.js";
import { buildExecExitOutcome, buildExecRuntimeErrorOutcome } from "./bash-tools.exec-output.js";
import { settleExecProcessExit } from "./bash-tools.exec-settlement.js";
import { createStreamingBinaryOutputSanitizer } from "./shell-utils.js";

let store: ReturnType<typeof createDurableProcessStore> | undefined;
const warn = () =>
  logWarn(
    "exec: durable process observation or persistence failed; inspect process status and the systemd user manager.",
  );
const sessions = () => listExecSessionsForCancellation().filter((session) => session.durable);
async function forgetLog(file: string) {
  await unlink(file).catch((error: unknown) => {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
  });
}
async function observe() {
  for (const session of sessions()) {
    await session.durable!.observe().catch(warn);
  }
}

/** Restore registry entries, never requester continuations or a second process manager. */
export async function initializeDurableProcesses(options: { assertCurrent?: () => void } = {}) {
  if (store) {
    throw new Error("Durable processes already have a Gateway owner");
  }
  const current = createDurableProcessStore({
    assertCurrent: () => {
      options.assertCurrent?.();
      if (store !== current) {
        throw new Error("Durable process Gateway owner is closed");
      }
    },
  });
  store = current;
  for (const record of await current.list()) {
    if (
      record.notificationSettled &&
      record.endedAt !== undefined &&
      record.endedAt + record.cleanupMs <= Date.now()
    ) {
      await current.remove(record.id);
      await forgetLog(record.logPath);
      continue;
    }
    const session = createProcessSession({
      ...record,
      totalOutputChars: 0,
      pendingStdoutChars: 0,
      pendingStderrChars: 0,
      pendingOutputDropped: false,
      exited: false,
      truncated: false,
      backgrounded: true,
      cursorKeyMode: "normal",
    });
    const run = bind(session, record, current);
    addSession(session);
    void run
      .wait()
      .then(async (exit) => {
        session.finalizing = true;
        session.notifyOnExit = record.notifyOnExit && !record.notificationSettled;
        await prepareAdoptedDurableProcessNotification(session, record.sessionId);
        await settleExecProcessExit({
          session,
          outcome: buildExecExitOutcome({
            exit,
            aggregated: session.aggregated,
            durationMs: exit.durationMs,
            timeoutSec: null,
            processContinuationAvailable: true,
          }),
          notifyOnExit: (target, status) => maybeNotifyOnExit(target, status, false),
          failureOutcome: (error) =>
            buildExecRuntimeErrorOutcome({
              error,
              aggregated: session.aggregated,
              durationMs: exit.durationMs,
            }),
        });
      })
      .catch(warn);
  }
  setDurableProcessObserver(observe);
  // Unit queries belong to the existing observation cadence, not Gateway startup.
}

/** Join accepted bookkeeping; the user manager keeps running the physical tree. */
export async function disposeDurableProcesses() {
  setDurableProcessObserver(undefined);
  await Promise.allSettled(sessions().map((session) => session.durable!.drain()));
  await Promise.all(
    sessions()
      .filter((session) => session.exited || session.processActivity?.resultSettled)
      .map(waitForExecSession),
  );
  store = undefined;
}

export async function startDurableExecProcess(
  session: ProcessSession,
  sessionId: string | undefined,
  input: SpawnInput,
  notification: { notifyOnExit?: boolean; notifyOnExitEmptySuccess?: boolean } = {},
): Promise<ManagedRun> {
  if (!store || !session.agentId || !session.sessionKey || !sessionId || input.mode !== "child") {
    throw new Error(
      "Durable exec requires a Gateway-host session on Linux with systemd 250 or newer and a reachable user manager; sandbox, node, worker, and one-shot execution are unsupported.",
    );
  }
  const persistence = store;
  await requireDurableProcessHost(input.env);
  const unitName = durableProcessUnitName(session.id);
  const logPath = path.join(resolveStateDir(), "processes", `${unitName}.log`);
  await mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
  const log = await open(logPath, "wx", 0o600);
  await log.close();
  const record: DurableProcessRecord = {
    id: session.id,
    agentId: session.agentId,
    sessionKey: session.sessionKey,
    scopeKey: session.scopeKey,
    sessionId,
    unitName,
    logPath,
    // Arguments may contain credentials. Only the live registry retains the command.
    command: "Durable background exec",
    cwd: session.cwd,
    startedAt: session.startedAt,
    cleanupMs: session.cleanupMs,
    maxOutputChars: session.maxOutputChars,
    notifyOnExit: notification.notifyOnExit ?? session.notifyOnExit,
    notifyOnExitEmptySuccess:
      notification.notifyOnExitEmptySuccess ?? session.notifyOnExitEmptySuccess,
  };
  const assertCurrent = () => {
    persistence.assertCurrent();
    input.assertCurrent?.();
    input.beforeSpawn?.();
  };
  await persistence.upsert(record, assertCurrent);
  const env = Object.fromEntries(
    Object.entries(input.env ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  try {
    await launchDurableProcess({
      id: session.id,
      argv: input.argv,
      cwd: input.cwd,
      env,
      logPath,
      timeoutMs: input.timeoutMs,
      memoryLimitBytes: input.memoryLimitBytes,
      assertCurrent,
      initiateSpawn: input.initiateSpawn,
    });
  } catch {
    // A failed D-Bus client cannot prove the unit was never accepted. Reconcile the
    // persisted identity; never retry potentially live work as another process.
    appendOutput(
      session,
      "stderr",
      "Durable launch was not confirmed. Check this process and the systemd user manager before repeating work.\n",
    );
  }
  const run = bind(session, record, persistence);
  setDurableProcessObserver(observe);
  return run;
}

function bind(
  session: ProcessSession,
  record: DurableProcessRecord,
  persistence: ReturnType<typeof createDurableProcessStore>,
): ManagedRun {
  const broker = getSpawnBroker();
  const exit = createDeferredCore<RunExit>();
  let pending = Promise.resolve(),
    offset = 0,
    terminal = false,
    stopConfirmed = false;
  const decoder = new StringDecoder("utf8"),
    sanitize = createStreamingBinaryOutputSanitizer();
  // Observation timers detach request context; retain only the process transport owner.
  const enqueue = (work: () => Promise<void>) =>
    (pending = pending.catch(warn).then(() => runWithSpawnBroker(broker, work)));
  const observeUnit = async () => {
    if (terminal) {
      return;
    }
    const observed = record.result
      ? { state: "missing" as const }
      : await readDurableProcess(record.unitName);
    const file = await open(record.logPath, "r").catch((error: unknown) => {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
    });
    if (file) {
      try {
        const size = (await file.stat()).size,
          start = Math.max(offset, size - session.maxOutputChars * 4);
        session.truncated ||= start > offset;
        session.totalOutputChars += start - offset;
        const bytes = Buffer.alloc(Math.max(0, size - start));
        const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
        offset = start + bytesRead;
        appendOutput(session, "stdout", sanitize(decoder.write(bytes.subarray(0, bytesRead))));
      } finally {
        await file.close();
      }
    }
    if (!record.result) {
      if (observed.state === "running") {
        session.pid = observed.pid;
        return;
      }
      if (observed.state === "missing" && !stopConfirmed) {
        appendOutput(
          session,
          "stderr",
          "\nDurable process unit is missing; outcome unknown. Check saved output and side effects before repeating work.\n",
        );
      }
      const result = {
        reason: stopConfirmed
          ? ("manual-cancel" as const)
          : observed.state === "exited"
            ? observed.reason
            : ("spawn-error" as const),
        exitCode: observed.state === "exited" ? observed.exitCode : null,
        exitSignal: observed.state === "exited" ? observed.exitSignal : null,
        durationMs: Date.now() - record.startedAt,
      };
      const endedAt = Date.now();
      await persistence.upsert({ ...record, result, endedAt });
      record.result = result;
      record.endedAt = endedAt;
    }
    // Record the real status before releasing systemd's retained unit.
    await cleanupDurableProcess(record.unitName, { assertCurrent: persistence.assertCurrent });
    session.endedAt = record.endedAt;
    appendOutput(session, "stdout", sanitize(decoder.end()));
    terminal = true;
    exit.resolve({
      ...record.result,
      stdout: "",
      stderr: "",
      timedOut: record.result.reason === "overall-timeout",
      noOutputTimedOut: false,
    });
  };
  session.durable = {
    observe: () => enqueue(observeUnit),
    cancel: (assertSource) => {
      const assertCurrent = () => {
        persistence.assertCurrent();
        assertSource?.();
      };
      void enqueue(async () => {
        record.cancellationRequested = true;
        await persistence.upsert(record, assertCurrent);
        await stopDurableProcess(record.unitName, { assertCurrent });
        stopConfirmed = true;
        await observeUnit();
      }).catch(warn);
    },
    remove: () => {
      void enqueue(async () => {
        await persistence.remove(record.id);
        await forgetLog(record.logPath);
      }).catch(warn);
    },
    finalize: () =>
      enqueue(async () => {
        record.notificationSettled = true;
        await persistence.upsert(record);
      }),
    drain: () => pending,
  };
  const activity = {
    get resultSettled() {
      return terminal;
    },
    lastOutputAtMs: record.startedAt,
  };
  session.processActivity = activity;
  return {
    runId: session.id,
    startedAtMs: record.startedAt,
    activity,
    wait: () => exit.promise,
    cancel: () => session.durable!.cancel(),
  };
}
