import { finished } from "node:stream/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { terminateCodexAppServerDescendants } from "./transport-process-containment.js";
import { waitForCodexAppServerProcessRegistrationCleanup } from "./transport-process-registration.js";

export type CodexAppServerCloseResult =
  | { exited: true; cleanup: "closed" | "terminated" | "uncertain" }
  | { exited: false; cleanup: "uncertain" };

type ContainmentOutcome = "natural" | "graceful" | "contained" | "uncertain";
type StdioDrain = {
  drained: Promise<boolean>;
  retain: () => void;
  release: () => void;
};
type TransportClose = {
  closing: Promise<ContainmentOutcome>;
  naturalExit: boolean;
  wasForced: () => boolean;
  exitWaitReady: Promise<void>;
  drainStdio: () => StdioDrain;
};
const CODEX_APP_SERVER_TRANSPORT_CLOSES = new WeakMap<object, TransportClose>();

type TransportCloseOptions = {
  forceKillDelayMs?: number;
  drainStdio?: boolean;
  /** Safe only when native commands cannot have left untracked descendants. */
  gracefulExit?: boolean;
};

/** True only after bounded settlement proves an exit that cleanup did not cause. */
export function hasCodexAppServerNaturalExit(child: CodexAppServerTransport): boolean {
  return CODEX_APP_SERVER_TRANSPORT_CLOSES.get(child)?.naturalExit === true;
}

export type CodexAppServerTransport = {
  /** External transport closure does not imply a native process exit or signal. */
  closed?: boolean;
  /** Duplex facades retain close origin/cause rather than pretending to observe a local process. */
  exitError?: Error;
  startupFailure?: { error?: Error; complete(): void };
  /** External duplex owners retain credential cleanup until physical close settlement. */
  waitForCleanup?: () => Promise<void>;
  maxFrameBytes?: number;
  stdin: {
    write: (data: string | Uint8Array, callback?: (error?: Error | null) => void) => unknown;
    end?: () => unknown;
    destroy?: () => unknown;
    unref?: () => unknown;
    on?: (event: "error", listener: (error: Error) => void) => unknown;
  };
  stdout: NodeJS.ReadableStream & {
    destroy?: () => unknown;
    unref?: () => unknown;
  };
  stderr: NodeJS.ReadableStream & {
    destroy?: () => unknown;
    unref?: () => unknown;
  };
  pid?: number;
  exitCode?: number | null;
  signalCode?: string | null;
  killed?: boolean;
  kill?: (signal?: NodeJS.Signals) => unknown;
  unref?: () => unknown;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off?: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

/** Starts graceful transport shutdown and schedules a force kill fallback. */
export function closeCodexAppServerTransport(
  child: CodexAppServerTransport,
  options: TransportCloseOptions = {},
): void {
  void beginCodexAppServerTransportClose(child, options).closing;
}

function beginCodexAppServerTransportClose(
  child: CodexAppServerTransport,
  options: TransportCloseOptions & { exitTimeoutMs?: number },
): TransportClose {
  const current = CODEX_APP_SERVER_TRANSPORT_CLOSES.get(child);
  if (current) {
    return current;
  }
  let forced = false;
  const exitWaitReady = createDeferred<void>();
  let drain: StdioDrain | undefined;
  const drainStdio = () =>
    (drain ??= ownStdioDrain(child, exitWaitReady.promise, options.exitTimeoutMs ?? 2_000));
  if (options.drainStdio) {
    void drainStdio();
  }
  const forceKillDelayMs = options.forceKillDelayMs ?? 1_000;
  const releaseUndrainedPipes = () => {
    if (!drain) {
      child.stdout.destroy?.();
      child.stderr.destroy?.();
    }
  };
  const forceKill = () => {
    forced = true;
    signalCodexAppServerTransport(child, "SIGKILL");
  };
  const closing: TransportClose["closing"] = (async () => {
    if (hasCodexAppServerTransportExited(child)) {
      return "natural";
    }
    if (options.gracefulExit) {
      // The npm launcher owns the native server as a child. Killing descendants
      // first kills that server, and the launcher mirrors its fatal signal.
      child.stdin.end?.();
      // Client admission is closed; discard late notifications so stdout cannot
      // block Codex's shutdown drain after the message reader has detached.
      child.stdout.resume();
      if (await waitForCodexAppServerTransportExit(child, forceKillDelayMs)) {
        return "graceful";
      }
    }
    if (process.platform === "win32" || !child.pid || !child.kill) {
      finishCodexAppServerTransportClose(child, forceKillDelayMs, forceKill, releaseUndrainedPipes);
      return "uncertain";
    }
    const contained = await terminateCodexAppServerDescendants(child, {
      startRecovery: () => {
        exitWaitReady.resolve();
        // Startup still owes a full EOF grace and time to observe exit. Cap
        // its extra inspection at one third of the force interval. Each
        // diagnostic caller can independently stop waiting sooner.
        const retryMs =
          options.drainStdio && !options.gracefulExit ? forceKillDelayMs / 3 : forceKillDelayMs;
        return performance.now() + retryMs;
      },
    }).catch(() => undefined);
    if (contained === "exited") {
      return options.gracefulExit ? "graceful" : "natural";
    }
    try {
      // The root has already used its stdin-EOF grace. Escalate as soon as the
      // descendant check finishes so cleanup can settle within the owner's budget.
      finishCodexAppServerTransportClose(
        child,
        options.gracefulExit ? 0 : forceKillDelayMs,
        forceKill,
        releaseUndrainedPipes,
        contained?.resume,
      );
    } catch {
      forceKill();
    }
    // A forced root exit is safe only after descendant termination was observed.
    // Failed containment cannot certify cleanup from the root's exit alone.
    return contained ? "contained" : "uncertain";
  })();
  const closure: TransportClose = {
    closing,
    naturalExit: false,
    wasForced: () => forced,
    exitWaitReady: exitWaitReady.promise,
    drainStdio,
  };
  void closing.then(() => exitWaitReady.resolve(), exitWaitReady.reject);
  CODEX_APP_SERVER_TRANSPORT_CLOSES.set(child, closure);
  return closure;
}

function finishCodexAppServerTransportClose(
  child: CodexAppServerTransport,
  forceKillDelayMs: number,
  killTransport: () => void,
  releaseUndrainedPipes: () => void,
  resumeRoot?: () => void,
): void {
  const forceKill = setTimeout(
    () => {
      if (hasCodexAppServerTransportExited(child)) {
        return;
      }
      killTransport();
    },
    Math.max(1, forceKillDelayMs),
  );
  forceKill.unref?.();
  child.once("exit", () => {
    clearTimeout(forceKill);
    releaseUndrainedPipes();
  });
  try {
    child.stdin.end?.();
    child.stdin.destroy?.();
  } finally {
    resumeRoot?.();
  }
  child.unref?.();
  child.stdout.unref?.();
  child.stderr.unref?.();
  child.stdin.unref?.();
}

/** Reports physical settlement separately from confirmed process cleanup. */
export async function closeCodexAppServerTransportAndWait(
  child: CodexAppServerTransport,
  options: TransportCloseOptions & { exitTimeoutMs?: number } = {},
): Promise<CodexAppServerCloseResult> {
  // The startup owner must send EOF before its diagnostic exit interval starts.
  // A joining reader can start its own wait as soon as containment needs recovery.
  const ownsDiagnosticClose =
    options.drainStdio && !options.gracefulExit && !CODEX_APP_SERVER_TRANSPORT_CLOSES.has(child);
  const closure = beginCodexAppServerTransportClose(child, options);
  const drain = options.drainStdio ? closure.drainStdio() : undefined;
  drain?.retain();
  let settled: boolean;
  try {
    await (ownsDiagnosticClose ? closure.closing : closure.exitWaitReady);
    settled = await waitForCodexAppServerTransportExit(
      child,
      options.exitTimeoutMs ?? 2_000,
      closure.closing.then(
        () => drain?.drained ?? true,
        () => false,
      ),
    );
  } finally {
    drain?.release();
  }
  const exited = settled || (!options.drainStdio && hasCodexAppServerTransportExited(child));
  if (exited) {
    await Promise.all([
      waitForCodexAppServerProcessRegistrationCleanup(child),
      child.waitForCleanup?.(),
    ]);
  }
  const containment = settled ? await closure.closing : undefined;
  closure.naturalExit =
    containment === "natural" && settled && (child.exitCode != null || child.signalCode != null);
  if (!settled) {
    return { exited, cleanup: "uncertain" };
  }
  if (containment === "contained") {
    return {
      exited: true,
      cleanup: !closure.wasForced() && child.signalCode == null ? "closed" : "terminated",
    };
  }
  return {
    exited: true,
    cleanup:
      (containment === "graceful" || (containment === "natural" && options.gracefulExit)) &&
      child.exitCode === 0 &&
      child.signalCode == null
        ? "closed"
        : "uncertain",
  };
}

function ownStdioDrain(
  child: CodexAppServerTransport,
  ready: Promise<void>,
  timeoutMs: number,
): StdioDrain {
  const drained = Promise.all(
    [child.stdout, child.stderr].map((stream) => finished(stream, { cleanup: true })),
  ).then(
    () => true,
    () => false,
  );
  // The transport and each diagnostic waiter hold the same pipes until their
  // own wait ends. The final release disposes them.
  let readers = 1;
  const release = () => {
    if (--readers === 0) {
      child.stdout.destroy?.();
      child.stderr.destroy?.();
    }
  };
  void ready
    .then(
      () => waitForCodexAppServerTransportExit(child, timeoutMs, drained),
      () => false,
    )
    .then(release, release);
  return {
    drained,
    retain: () => {
      readers++;
    },
    release,
  };
}

function hasCodexAppServerTransportExited(child: CodexAppServerTransport): boolean {
  return child.closed === true || child.exitCode != null || child.signalCode != null;
}

async function waitForCodexAppServerTransportExit(
  child: CodexAppServerTransport,
  timeoutMs: number,
  drained?: Promise<boolean>,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.off?.("exit", onExit);
      resolve(exited);
    };
    const onExit = () => {
      if (drained) {
        void drained.then(finish);
      } else {
        finish(true);
      }
    };
    const timeout = setTimeout(() => finish(false), Math.max(1, timeoutMs));
    child.once("exit", onExit);
    if (hasCodexAppServerTransportExited(child)) {
      onExit();
    }
  });
}

function signalCodexAppServerTransport(
  child: CodexAppServerTransport,
  signal: NodeJS.Signals,
): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the child handle. The process may already be gone or not
      // be a process-group leader on older call sites.
    }
  }
  child.kill?.(signal);
}
