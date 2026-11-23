import { stripVTControlCharacters } from "node:util";
import { recordCodexAppServerSpawnFailure } from "./spawn-error.js";
import type { CodexStdioChild } from "./stdio-worker.js";
import type { CodexAppServerTransport } from "./transport.js";

/** The official npm launcher prints the native spawn error and exits before initialization. */
export function observeManagedCodexLauncherFailure(
  child: CodexStdioChild,
  nativeCommand: string,
): void {
  let prefix = "";
  let launchCode: string | undefined;
  let execveAbortCode: string | undefined;
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
    // Node 24 aborts on execve failure without printing the native path or error fields.
    execveAbortCode =
      /^process\.execve failed with error code (ENOENT|EACCES|EBADARCH|Unknown system error -86)\r?$/mu.exec(
        prefix,
      )?.[1];
    if (
      /\bError: spawn\b/u.test(prefix) &&
      /syscall: ['"]spawn(?: [^'"\r\n]*)?['"]/u.test(prefix)
    ) {
      launchCode = /\bcode: ['"](ENOENT|EACCES|EBADARCH|Unknown system error -86)['"]/u.exec(
        prefix,
      )?.[1];
    } else if (
      /syscall: ['"]execve['"]/u.test(prefix) &&
      /^\s+path: (['"])([^\r\n]*)\1,?\r?$/mu.exec(prefix)?.[2] === nativeCommand
    ) {
      launchCode = /\bcode: ['"](ENOENT|EACCES|EBADARCH|Unknown system error -86)['"]/u.exec(
        prefix,
      )?.[1];
    } else if (
      /Error: Missing optional dependency @openai\/codex-[\w-]+\. Reinstall Codex:/u.test(prefix)
    ) {
      launchCode = "ENOENT";
    } else {
      const bunError =
        /^(ENOENT|EACCES|EBADARCH|Unknown system error -86): [^\r\n]*, (?:posix_spawn|spawn) (['"])([^\r\n]*)\2\r?$/mu.exec(
          prefix,
        );
      const syscall = /^\s+syscall: (['"])([^\r\n]*)\1,\r?$/mu.exec(prefix)?.[2];
      if (bunError?.[3] === nativeCommand && syscall === `spawn ${nativeCommand}`) {
        launchCode = bunError[1];
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode, child.signalCode);
    }
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    const failureCode =
      code === null && signal === "SIGABRT" ? execveAbortCode : code === 1 ? launchCode : undefined;
    // Exit can precede pipe data; registration already drains that data before
    // choosing its failure. Keep observing until the diagnostic or pipe close.
    if ((code === 1 || (code === null && signal === "SIGABRT")) && !failureCode) {
      return;
    }
    startupFailure.complete();
    if (!failureCode) {
      return;
    }
    const described = recordCodexAppServerSpawnFailure(
      Object.assign(new Error(`spawn ${failureCode}`), { code: failureCode, syscall: "spawn" }),
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
