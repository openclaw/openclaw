import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { CliBackendExecute } from "../../plugins/cli-backend.types.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { executePreparedCliRun as executePreparedCliRunImpl } from "./execute.js";
import { wrapPreparedCliRunWithTestAdmission } from "./execute.test-support.js";

const executePreparedCliRun = wrapPreparedCliRunWithTestAdmission(executePreparedCliRunImpl);
afterEach(() => vi.useRealTimers());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function runFixture(command: string, args: string[], abortSignal: AbortSignal) {
  const execute: CliBackendExecute = async function* (context) {
    const { stdout } = await execa(context.command, context.args, {
      argv0: context.argv0,
      cwd: context.cwd,
      env: context.env,
      extendEnv: false,
      cancelSignal: context.abortSignal,
      killSignal: "SIGKILL",
      stdin: "ignore",
      stripFinalNewline: false,
    });
    yield { type: "result", subtype: "success", result: stdout };
  };
  const context = buildPreparedCliRunContext({
    backend: {
      command,
      args,
      modelArg: undefined,
      sessionArgs: undefined,
      systemPromptFileArg: undefined,
      jsonlDialect: "claude-stream-json",
    },
    onSuccessfulAuthBinding: () => {},
    runtimeArtifact: {
      kind: "bundled-package-tree",
      packageName: "@fixture/cli-invocation",
      entrypoint: "command",
      nativeExecutableNames: ["cli-fixture"],
    },
  });
  context.params.abortSignal = abortSignal;
  context.authBindingFingerprint = "fixture-owner";
  context.executionTarget = { kind: "plugin", execute };
  // Freeze the helper's watchdog; Vitest still aborts and reaps the real child.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  return executePreparedCliRun(context);
}

it("runs a verified plugin CLI script through its resolved interpreter", async ({ signal }) => {
  const root = tempDirs.make("openclaw-plugin-cli-invocation-");
  const entrypoint = path.join(root, "cli.js");
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@fixture/cli-invocation", version: "1.0.0" }),
  );
  await fs.writeFile(
    entrypoint,
    `#!${process.execPath}\nprocess.stdout.write("fixture-script:" + process.argv.slice(2).join("|"));\n`,
    { mode: 0o755 },
  );
  let command = entrypoint;
  if (process.platform === "win32") {
    command = path.join(root, "cli.cmd");
    await fs.writeFile(command, '@echo off\r\n"%~dp0\\cli.js" %*\r\n');
  }

  await expect(runFixture(command, ["--fixture-option", "kept"], signal)).resolves.toMatchObject({
    text: "fixture-script:--fixture-option|kept",
  });
});

it.skipIf(process.platform === "win32")("preserves symlink argv0", async ({ signal }) => {
  const root = tempDirs.make("openclaw-plugin-cli-alias-");
  const command = path.join(root, "cli-fixture");
  await fs.symlink(process.execPath, command);

  await expect(
    runFixture(command, ["-e", "process.stdout.write(process.argv0)"], signal),
  ).resolves.toMatchObject({ text: command });
});
