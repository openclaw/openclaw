import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { recordCodexAppServerSpawnFailure } from "./spawn-error.js";
import type { CodexAppServerTransport } from "./transport.js";

/** The official npm launcher prints Node's native spawn error and exits before initialization. */
export function observeManagedCodexLauncherFailure(
  child: ChildProcessWithoutNullStreams,
  nativeCommand: string,
): void {
  let prefix = "";
  let launchCode: string | undefined;
  const complete = () => {
    child.stderr.off("data", onData);
    child.off("exit", onExit);
    child.off("close", complete);
    prefix = "";
  };
  const startupFailure: NonNullable<CodexAppServerTransport["startupFailure"]> = { complete };
  const onData = (chunk: string | Buffer) => {
    if (launchCode || prefix.length >= 16_384) {
      return;
    }
    // Retain the error fields, not the potentially large spawnargs printed after them.
    prefix = (prefix + stripVTControlCharacters(chunk.toString())).slice(0, 16_384);
    if (
      /\bError: spawn\b/u.test(prefix) &&
      /syscall: ['"]spawn(?: [^'"\r\n]*)?['"]/u.test(prefix)
    ) {
      launchCode = /\bcode: ['"](ENOENT|EACCES|EBADARCH|Unknown system error -86)['"]/u.exec(
        prefix,
      )?.[1];
    } else if (
      /Error: Missing optional dependency @openai\/codex-[\w-]+\. Reinstall Codex:/u.test(prefix)
    ) {
      launchCode = "ENOENT";
    }
    if (child.exitCode !== null) {
      onExit(child.exitCode);
    }
  };
  const onExit = (code: number | null) => {
    // Exit can precede pipe data; registration already drains that data before
    // choosing its failure. Keep observing until the diagnostic or pipe close.
    if (code === 1 && !launchCode) {
      return;
    }
    startupFailure.complete();
    if (code !== 1 || !launchCode) {
      return;
    }
    const described = recordCodexAppServerSpawnFailure(
      Object.assign(new Error(`spawn ${launchCode}`), { code: launchCode, syscall: "spawn" }),
      nativeCommand,
      nativeCommand,
    );
    if (described instanceof Error) {
      startupFailure.error = described;
    }
  };
  child.stderr.on("data", onData);
  child.once("exit", onExit);
  child.once("close", complete);
  Object.assign(child, { startupFailure });
}
