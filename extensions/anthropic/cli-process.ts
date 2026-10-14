import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";
import { attachErrorDiagnostic } from "openclaw/plugin-sdk/error-runtime";
import { redactSensitiveFieldValue, redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import {
  createOwnedStdioProcess,
  type OwnedStdioProcess,
} from "openclaw/plugin-sdk/process-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";

type ClaudeCliSpawnOptions = Pick<
  CliBackendExecuteContext,
  "command" | "argv0" | "args" | "cwd" | "env"
> & {
  signal?: AbortSignal;
};

export type ClaudeCliProcessContext = Pick<
  CliBackendExecuteContext,
  "command" | "argv0" | "args" | "cwd" | "env" | "abortSignal" | "assertCurrent"
>;

export type ClaudeCliSecretInput = { fd: 3; createData: () => Buffer };

const STDERR_CAPTURE_CHARS = 8_192;
const STDERR_PREVIEW_CHARS = 2_000;
const STDERR_DRAIN_GRACE_MS = 200;

/** Owns process-wide diagnostics and the credentials needed to redact warm turns. */
export function createClaudeCliProcessOwner(
  currentContext: () => ClaudeCliProcessContext | undefined,
  secretInput?: ClaudeCliSecretInput,
) {
  const assertCurrent = () => {
    const context = currentContext();
    if (!context) {
      throw new Error("Claude CLI run is no longer active.");
    }
    context.assertCurrent?.();
  };
  assertCurrent();
  // Prepared credentials are destroyed after each turn; a warm child outlives that preparation.
  const credential = secretInput?.createData();
  let environment: ClaudeCliSpawnOptions["env"] = {};
  let child: OwnedStdioProcess | undefined;
  let exited = false;
  let disposed = false;
  let tail = "";
  let dropPartialLine = false;
  const observeStderr = (process: OwnedStdioProcess) => {
    child = process;
    process.onExit(() => {
      exited = true;
    });
    process.onStderr((chunk) => {
      let text = chunk;
      if (disposed) {
        return;
      }
      if (dropPartialLine) {
        const newline = text.indexOf("\n");
        if (newline < 0) {
          return;
        }
        text = text.slice(newline + 1);
        dropPartialLine = false;
      }
      tail += text;
      if (tail.length > STDERR_CAPTURE_CHARS) {
        const bounded = sliceUtf16Safe(tail, -STDERR_CAPTURE_CHARS);
        const newline = bounded.indexOf("\n");
        // Drop a clipped line in full: its missing prefix may identify a credential.
        tail = newline < 0 ? "" : bounded.slice(newline + 1);
        dropPartialLine = newline < 0;
      }
    });
  };
  return {
    [Symbol.dispose]() {
      disposed = true;
      credential?.fill(0);
      environment = {};
      tail = "";
    },
    spawn: async (options: ClaudeCliSpawnOptions) => {
      assertCurrent();
      environment = options.env;
      const spawned = await createOwnedStdioProcess({
        argv: [options.command, ...options.args],
        argv0: options.argv0,
        cwd: options.cwd,
        env: options.env,
        exactEnv: true,
        abortSignal: options.signal,
        assertCurrent,
        secretInput,
        terminateOnHostLoss: true,
        stdoutConsumption: "awaited",
      });
      observeStderr(spawned);
      return spawned;
    },
    async withDiagnostics(error: unknown): Promise<unknown> {
      const context = currentContext();
      if (disposed || !context || context.abortSignal?.aborted) {
        return error;
      }
      // Process exit can precede stderr EOF. Descendants may keep the pipe open.
      if (child && exited) {
        await raceWithTimeout(
          child.wait().catch(() => undefined),
          STDERR_DRAIN_GRACE_MS,
          () => undefined,
        );
      }
      if (disposed || currentContext() !== context || context.abortSignal?.aborted) {
        return error;
      }
      let diagnostic = tail;
      // Known opaque credentials need exact-value masking as well as pattern redaction.
      // Warm turns can mint new grants while the child retains its original environment.
      const secrets = [environment, context.env].flatMap((env) =>
        Object.entries(env).flatMap(([name, value]) =>
          value && redactSensitiveFieldValue(name, value, { mode: "tools" }) !== value
            ? [value]
            : [],
        ),
      );
      if (credential) {
        secrets.push(credential.toString("utf8"));
      }
      for (const secret of secrets.filter(Boolean)) {
        for (const value of [
          secret,
          encodeURIComponent(secret),
          JSON.stringify(secret).slice(1, -1),
        ]) {
          diagnostic = diagnostic.replaceAll(value, "[REDACTED]");
        }
      }
      diagnostic = sliceUtf16Safe(
        redactSensitiveText(diagnostic, { mode: "tools" }),
        -STDERR_PREVIEW_CHARS,
      ).trim();
      if (diagnostic && error instanceof Error) {
        // Independent pipes cannot attribute warm stderr to a turn or classify its failure.
        attachErrorDiagnostic(
          error,
          `stderr (process-wide; may include earlier turns): ${diagnostic}`,
        );
      }
      return error;
    },
  };
}
