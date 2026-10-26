import { finished } from "node:stream/promises";
import { terminateCodexAppServerDescendants } from "./transport-process-containment.js";
import { waitForCodexAppServerProcessRegistrationCleanup } from "./transport-process-registration.js";

export type CodexAppServerCloseResult =
  | { exited: true; cleanup: "closed" | "terminated" | "uncertain" }
  | { exited: false; cleanup: "uncertain" };

type TransportClose = {
  closing: Promise<"natural" | "graceful" | "contained" | "uncertain">;
  naturalExit: boolean;
  wasForced: () => boolean;
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
  startupFailure?: { error?: Error; complete(): void };
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
  options: TransportCloseOptions,
): TransportClose {
  const current = CODEX_APP_SERVER_TRANSPORT_CLOSES.get(child);
  if (current) {
    return current;
  }
  let forced = false;
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
      if (await waitForCodexAppServerTransportExit(child, options.forceKillDelayMs ?? 1_000)) {
        return "graceful";
      }
    }
    if (process.platform === "win32" || !child.pid || !child.kill) {
      finishCodexAppServerTransportClose(child, options, forceKill);
      return "uncertain";
    }
    const contained = await terminateCodexAppServerDescendants(child).catch(() => undefined);
    if (contained === "exited") {
      return options.gracefulExit ? "graceful" : "natural";
    }
    try {
      finishCodexAppServerTransportClose(child, options, forceKill, contained?.resume);
    } catch {
      forceKill();
    }
    // A forced root exit is safe only after descendant termination was observed.
    // Failed containment cannot certify cleanup from the root's exit alone.
    return contained ? "contained" : "uncertain";
  })();
  const closure = { closing, naturalExit: false, wasForced: () => forced };
  CODEX_APP_SERVER_TRANSPORT_CLOSES.set(child, closure);
  return closure;
}

function finishCodexAppServerTransportClose(
  child: CodexAppServerTransport,
  options: TransportCloseOptions,
  killTransport: () => void,
  resumeRoot?: () => void,
): void {
  const forceKillDelayMs = options.forceKillDelayMs ?? 1_000;
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
    if (!options.drainStdio) {
      child.stdout.destroy?.();
      child.stderr.destroy?.();
    }
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
  const drained = options.drainStdio
    ? Promise.all(
        [child.stdout, child.stderr].map((stream) => finished(stream, { cleanup: true })),
      ).then(
        () => true,
        () => false,
      )
    : undefined;
  const closure = beginCodexAppServerTransportClose(child, options);
  const containment = await closure.closing;
  const settled = await waitForCodexAppServerTransportExit(
    child,
    options.exitTimeoutMs ?? 2_000,
    drained,
  );
  if (settled) {
    await waitForCodexAppServerProcessRegistrationCleanup(child);
  }
  closure.naturalExit = containment === "natural" && settled;
  if (options.drainStdio) {
    // Share the existing exit budget with pipe draining. A timed-out drain is
    // not a complete natural-exit diagnostic and must not authorize a retry.
    child.stdout.destroy?.();
    child.stderr.destroy?.();
  }
  if (!settled) {
    return { exited: false, cleanup: "uncertain" };
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

function hasCodexAppServerTransportExited(child: CodexAppServerTransport): boolean {
  return child.exitCode != null || child.signalCode != null;
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
