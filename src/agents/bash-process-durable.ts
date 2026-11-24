import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { resolveStateDir } from "../config/paths.js";
import { hasErrnoCode } from "../infra/errors.js";
import type { GatewayRestartResumeWindows } from "../infra/gateway-boot-lifecycle.js";
import { logWarn } from "../logger.js";
import { readCgroupMemoryUsage, watchHostExecMemory } from "../process/child-memory.js";
import { getSpawnBroker, runWithSpawnBroker } from "../process/spawn-broker/context.js";
import type {
  ManagedRun,
  RunExit,
  SpawnInput,
  TerminationReason,
} from "../process/supervisor/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { waitForAgentDatabasePreparation } from "../state/agent-database-preparation-context.js";
import {
  createDurableProcessStore,
  type DurableProcessRecord,
} from "./bash-durable-process-store.js";
import { prepareAdoptedDurableProcessNotification } from "./bash-process-durable-notify.js";
import { launchdDurableSupervisor } from "./bash-process-launchd.js";
import {
  addSession,
  appendOutput,
  createProcessSession,
  listExecSessionsForCancellation,
  setDurableProcessObserver,
  setExitWakeRecorder,
  type ProcessSession,
  waitForExecSession,
} from "./bash-process-registry.js";
import { systemdDurableSupervisor } from "./bash-process-systemd.js";
import { maybeNotifyOnExit } from "./bash-tools.exec-notify.js";
import {
  buildExecExitOutcome,
  buildExecRuntimeErrorOutcome,
  hasExitWake,
} from "./bash-tools.exec-output.js";
import { settleExecProcessExit } from "./bash-tools.exec-settlement.js";
import { createStreamingBinaryOutputSanitizer } from "./shell-utils.js";

let store: ReturnType<typeof createDurableProcessStore> | undefined;
// Linux user services and macOS launchd jobs supervise behind the same operations.
const supervisor = () =>
  process.platform === "darwin" ? launchdDurableSupervisor : systemdDurableSupervisor;
const warn = () =>
  logWarn(
    "exec: durable process observation or persistence failed; inspect process status and the systemd user manager or launchd.",
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

const ordinaryRecords = new WeakMap<ProcessSession, DurableProcessRecord>();
// Writes per ordinary process stay ordered: an exit never lands before its own arm record.
const ordinaryWrites = new Map<string, Promise<void>>();
function writeOrdinary(id: string, write: () => Promise<void>) {
  const next = (ordinaryWrites.get(id) ?? Promise.resolve())
    .then(write)
    .catch(() => logWarn("exec: could not record a background command for restart reporting."));
  ordinaryWrites.set(id, next);
  void next.finally(() => {
    if (ordinaryWrites.get(id) === next) {
      ordinaryWrites.delete(id);
    }
  });
}

/** Best effort: a wake-armed ordinary process leaves a row only while it runs. */
const ordinaryExitWakeRecorder = {
  backgrounded(session: ProcessSession) {
    const persistence = store;
    if (
      !persistence ||
      session.durable ||
      !hasExitWake(session) ||
      !session.agentId ||
      !session.sessionKey ||
      // Incognito state stays in memory; it never reaches shared storage.
      isIncognitoSessionKey(session.sessionKey)
    ) {
      return;
    }
    const unitName = supervisor().unitName(session.id);
    const record: DurableProcessRecord = {
      kind: "ordinary",
      ...(session.sandboxContainerName ? { sandboxed: true as const } : {}),
      id: session.id,
      agentId: session.agentId,
      sessionKey: session.sessionKey,
      scopeKey: session.scopeKey,
      // An older reader finds no unit and records the process as lost, which stays true.
      unitName,
      logPath: path.join(resolveStateDir(), "processes", `${unitName}.log`),
      // Arguments may contain credentials; the transcript keeps the command.
      command: "Background exec",
      cwd: session.cwd,
      startedAt: session.startedAt,
      cleanupMs: session.cleanupMs,
      maxOutputChars: session.maxOutputChars,
      notifyOnExit: true,
      notifyOnExitEmptySuccess: session.notifyOnExitEmptySuccess,
    };
    ordinaryRecords.set(session, record);
    writeOrdinary(session.id, () => persistence.upsert(record));
  },
  exited(session: ProcessSession) {
    const persistence = store;
    const record = ordinaryRecords.get(session);
    if (!persistence || !record) {
      return;
    }
    ordinaryRecords.delete(session);
    writeOrdinary(session.id, () => persistence.remove(record.id));
  },
};

/** Report a wake-armed ordinary process the last Gateway lost; never adopt or rerun it. */
async function settleLostOrdinaryProcess(
  record: DurableProcessRecord,
  crashWindows: GatewayRestartResumeWindows | undefined,
) {
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
  const startedAt = new Date(record.startedAt).toISOString();
  // The boot owner records each unclean Gateway lifetime; outside one, shutdown stopped it.
  const crashed = crashWindows?.[record.agentId]?.some(
    (window) => record.startedAt >= window.startedAt && record.startedAt < window.endedAt,
  );
  // Measured: shutdown stops Gateway-host commands, and Linux stops them when the Gateway
  // dies; a killed macOS Gateway can leave one running, and a sandbox's fate is unobserved.
  const stopped = !record.sandboxed && (!crashed || process.platform === "linux");
  appendOutput(
    session,
    "stderr",
    stopped
      ? `This background command (started ${startedAt}) was stopped when the Gateway ${crashed ? "restarted unexpectedly" : "shut down"}, so its result will not arrive. If you still need it, check its output and side effects, then run it again.\n`
      : `The Gateway ${crashed ? "restarted unexpectedly" : "restarted"} while this background command (started ${startedAt}) was running. It may still be running, but its result will not wake this conversation. Check its output and side effects before running it again.\n`,
  );
  session.finalizing = true;
  // After a crash, agent database preparation finishes after the listener binds.
  await waitForAgentDatabasePreparation(record.agentId);
  // Eligibility and authority are rechecked against the current session, as for durable outcomes.
  await prepareAdoptedDurableProcessNotification(session);
  // The registry's exit hook deletes the row once the notice settles.
  ordinaryRecords.set(session, record);
  addSession(session);
  await settleExecProcessExit({
    session,
    outcome: buildExecExitOutcome({
      // Report a lost outcome, never the shutdown's own stop, which would suppress the wake.
      exit: {
        reason: "spawn-error",
        exitCode: null,
        exitSignal: null,
        durationMs: Date.now() - record.startedAt,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      },
      aggregated: session.aggregated,
      durationMs: Date.now() - record.startedAt,
      timeoutSec: null,
      processContinuationAvailable: false,
    }),
    notifyOnExit: (target, status) => maybeNotifyOnExit(target, status, false),
    failureOutcome: (error) =>
      buildExecRuntimeErrorOutcome({
        error,
        aggregated: session.aggregated,
        durationMs: Date.now() - record.startedAt,
      }),
  });
}

/** Restore registry entries, never requester continuations or a second process manager. */
export async function initializeDurableProcesses(
  options: {
    assertCurrent?: () => void;
    /** Unclean Gateway lifetimes per agent, from the boot lifecycle owner. */
    crashWindows?: GatewayRestartResumeWindows;
  } = {},
) {
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
  setExitWakeRecorder(ordinaryExitWakeRecorder);
  for (const record of await current.list()) {
    if (record.kind === "ordinary") {
      // Reporting waits for agent readiness; durable adoption must not wait behind it.
      // A failed report keeps the row, so the next start reports it again.
      void settleLostOrdinaryProcess(record, options.crashWindows).catch(() =>
        logWarn("exec: could not report a background command the last Gateway lost."),
      );
      continue;
    }
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
    // Prepare the wake at adoption so poll and process lists report it; exit prepares it again.
    const prepareNotification = () => {
      session.notifyOnExit = record.notifyOnExit && !record.notificationSettled;
      return prepareAdoptedDurableProcessNotification(session);
    };
    await prepareNotification();
    const run = bind(session, record, current);
    addSession(session);
    void run
      .wait()
      .then(async (exit) => {
        session.finalizing = true;
        await prepareNotification();
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
  setExitWakeRecorder(undefined);
  await Promise.all(ordinaryWrites.values());
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
  input: SpawnInput,
  notification: { notifyOnExit?: boolean; notifyOnExitEmptySuccess?: boolean } = {},
): Promise<ManagedRun> {
  if (!store || !session.agentId || !session.sessionKey || input.mode !== "child") {
    throw new Error(
      "Durable exec requires a Gateway-host session on Linux with systemd 250 or newer and a reachable user manager, or on macOS in a logged-in GUI session; sandbox, node, worker, and one-shot execution are unsupported.",
    );
  }
  const persistence = store;
  await supervisor().requireHost(input.env);
  const unitName = supervisor().unitName(session.id);
  const logPath = path.join(resolveStateDir(), "processes", `${unitName}.log`);
  await mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
  const log = await open(logPath, "wx", 0o600);
  await log.close();
  const record: DurableProcessRecord = {
    id: session.id,
    agentId: session.agentId,
    sessionKey: session.sessionKey,
    scopeKey: session.scopeKey,
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
    await supervisor().launch({
      id: session.id,
      argv: input.argv,
      cwd: input.cwd,
      env,
      logPath,
      timeoutMs: input.timeoutMs,
      assertCurrent,
      initiateSpawn: input.initiateSpawn,
    });
  } catch {
    // A failed D-Bus client cannot prove the unit was never accepted. Reconcile the
    // persisted identity; never retry potentially live work as another process.
    appendOutput(
      session,
      "stderr",
      "Durable launch was not confirmed. Check this process and the systemd user manager or launchd before repeating work.\n",
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
    stopReason: TerminationReason | undefined;
  let cgroupDirectory: string | undefined;
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
      : await supervisor().read(record.unitName);
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
        cgroupDirectory = observed.cgroupDirectory;
        return;
      }
      if (observed.state === "missing" && !stopReason) {
        appendOutput(
          session,
          "stderr",
          "\nDurable process unit is missing; outcome unknown. Check saved output and side effects before repeating work.\n",
        );
      }
      if (observed.state === "exited" && observed.note) {
        appendOutput(session, "stderr", observed.note);
      }
      const result = {
        reason:
          stopReason ?? (observed.state === "exited" ? observed.reason : ("spawn-error" as const)),
        exitCode: observed.state === "exited" ? observed.exitCode : null,
        exitSignal: observed.state === "exited" ? observed.exitSignal : null,
        // A supervisor-measured duration excludes time the outcome waited for this Gateway.
        durationMs:
          (observed.state === "exited" ? observed.durationMs : undefined) ??
          Date.now() - record.startedAt,
      };
      const endedAt = Date.now();
      await persistence.upsert({ ...record, result, endedAt });
      record.result = result;
      record.endedAt = endedAt;
    }
    // Record the real status before releasing the supervisor's retained job.
    await supervisor().cleanup(record.unitName, {
      assertCurrent: persistence.assertCurrent,
    });
    session.endedAt = record.endedAt;
    appendOutput(session, "stdout", sanitize(decoder.end()));
    terminal = true;
    stopMemoryWatch();
    exit.resolve({
      ...record.result,
      stdout: "",
      stderr: "",
      timedOut: record.result.reason === "overall-timeout",
      noOutputTimedOut: false,
    });
  };
  const cancel = (reason: TerminationReason, assertSource?: () => void) => {
    const assertCurrent = () => {
      persistence.assertCurrent();
      assertSource?.();
    };
    return enqueue(async () => {
      if (terminal) {
        return;
      }
      if (reason === "manual-cancel") {
        record.cancellationRequested = true;
      }
      await persistence.upsert(record, assertCurrent);
      await supervisor().stop(record.unitName, { assertCurrent });
      stopReason ??= reason;
      await observeUnit();
    });
  };
  const stopMemoryWatch = runInDetachedAsyncContext(() =>
    watchHostExecMemory({
      readUsage: async () => {
        if (!cgroupDirectory && !terminal) {
          await enqueue(observeUnit);
        }
        if (terminal) {
          return { memoryBytes: 0, swapBytes: 0 };
        }
        if (!cgroupDirectory) {
          throw new Error("Durable process cgroup usage is unavailable");
        }
        try {
          return await readCgroupMemoryUsage(cgroupDirectory);
        } catch (error) {
          if (!hasErrnoCode(error, "ENOENT")) {
            throw error;
          }
          // The retained unit may have finished between the observation and sample.
          await enqueue(observeUnit);
          if (terminal) {
            return { memoryBytes: 0, swapBytes: 0 };
          }
          throw error;
        }
      },
      onLimit: () => cancel("memory-limit"),
      onDiagnostic: (text) => appendOutput(session, "stderr", text),
    }),
  );
  session.durable = {
    observe: () => enqueue(observeUnit),
    cancel: (assertSource) => {
      void cancel("manual-cancel", assertSource).catch(warn);
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
    drain: () => {
      stopMemoryWatch();
      return pending;
    },
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
    cancel: (reason = "manual-cancel") => {
      void cancel(reason).catch(warn);
    },
  };
}
