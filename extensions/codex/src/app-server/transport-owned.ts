/** Adapts the canonical retained process owner for disposable runtime qualification. */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  createOwnedStdioProcess,
  closeOwnedStdioProcess,
  OwnedStdioCleanupError,
  commandProcessCleanup,
} from "openclaw/plugin-sdk/process-runtime";
import type { CodexAppServerStartOptions } from "./config.js";
import {
  resolveCodexAppServerSpawnEnv,
  resolveCodexAppServerSpawnInvocation,
} from "./transport-stdio.js";
import type { CodexAppServerCloseResult, CodexAppServerTransport } from "./transport.js";

export async function createOwnedCodexStdioTransport(
  options: CodexAppServerStartOptions,
  signal: AbortSignal,
  assertCurrent: (() => void) | undefined,
  onSpawn: (child: CodexAppServerTransport) => void,
): Promise<void> {
  signal.throwIfAborted();
  assertCurrent?.();
  const env = resolveCodexAppServerSpawnEnv(options);
  const invocation = resolveCodexAppServerSpawnInvocation(options, env);
  let owner;
  try {
    owner = await createOwnedStdioProcess({
      argv: [invocation.command, ...invocation.argv],
      cwd: options.cwd,
      env,
      exactEnv: true,
      ...(invocation.shell ? { windowsShell: true as const } : {}),
      abortSignal: signal,
    });
  } catch (error) {
    if (error instanceof OwnedStdioCleanupError) {
      throw new commandProcessCleanup.Error({ cause: error });
    }
    throw error;
  }
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const events = new EventEmitter();
  // The client consumes the first failure once; later stream failures still belong
  // to the same closing owner and must not become unhandled EventEmitter errors.
  events.on("error", () => {});
  let closing: Promise<CodexAppServerCloseResult> | undefined;
  const child: CodexAppServerTransport = {
    stdin: {
      write: (data, callback) =>
        owner.stdin!.write(typeof data === "string" ? data : Buffer.from(data), callback),
      end: () => owner.stdin!.end(),
      destroy: () => owner.stdin!.destroy?.(),
    },
    stdout,
    stderr,
    pid: owner.pid,
    once: (event, listener) => events.once(event, listener),
    off: (event, listener) => events.off(event, listener),
    closeOwnedAndWait: () =>
      (closing ??= Promise.resolve().then(async () => {
        try {
          await closeOwnedStdioProcess(owner);
          const extinction = await owner.waitForExtinction?.();
          return {
            exited: true,
            cleanup:
              owner.waitForExtinction && (!extinction || extinction.status === "confirmed")
                ? "closed"
                : "uncertain",
          };
        } finally {
          stdout.destroy();
          stderr.destroy();
        }
      })),
  };
  try {
    // Install the protocol reader before replaying an early native exit or error.
    onSpawn(child);
    owner.onStdout(
      () => {},
      (chunk) => stdout.write(chunk),
    );
    owner.onStderr(
      () => {},
      (chunk) => stderr.write(chunk),
    );
    owner.onError((error) => events.emit("error", error));
    owner.onExit((code, exitSignal) => {
      child.exitCode = code;
      child.signalCode = exitSignal;
      events.emit("exit", code, exitSignal);
    });
    signal.throwIfAborted();
    assertCurrent?.();
  } catch (error) {
    try {
      if ((await child.closeOwnedAndWait!()).cleanup !== "closed") {
        throw new Error("Owned Codex startup cleanup is uncertain", { cause: error });
      }
    } catch (cleanupError) {
      throw new commandProcessCleanup.Error({ cause: cleanupError });
    }
    throw error;
  }
}
