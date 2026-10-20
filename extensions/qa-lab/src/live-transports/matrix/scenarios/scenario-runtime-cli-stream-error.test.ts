import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isPidAlive } from "openclaw/plugin-sdk/process-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn<typeof import("node:child_process").spawn>(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: childProcessMocks.spawn.mockImplementation(actual.spawn) };
});

import { startMatrixQaOpenClawCli } from "./scenario-runtime-cli.js";

async function createCliRoot() {
  const root = await mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "matrix-qa-stream-"));
  const grandchildScript =
    "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);";
  await mkdir(path.join(root, "dist"));
  await writeFile(
    path.join(root, "dist", "index.mjs"),
    [
      "import { spawn } from 'node:child_process';",
      `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });`,
      "grandchild.once('message', () => process.stdout.write(`grandchild ready ${grandchild.pid}\\n`));",
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  return root;
}

beforeEach(() => childProcessMocks.spawn.mockClear());

it.for([
  ["stdout", false],
  ["stderr", false],
  ["stdout", true],
] as const)(
  "rejects after cleaning up when %s emits a stream error (after exit: %s)",
  async ([streamName, afterExit], { signal }) => {
    const root = await createCliRoot();
    let grandchildPid: number | undefined;
    let session: ReturnType<typeof startMatrixQaOpenClawCli> | undefined;
    let childClosed = false;
    let closed: Promise<void> | undefined;
    try {
      session = startMatrixQaOpenClawCli({
        args: ["matrix", "verify", "self"],
        cwd: root,
        env: process.env,
        timeoutMs: 5_000,
      });
      const child = childProcessMocks.spawn.mock.results.at(-1)?.value;
      if (!child) {
        throw new Error("CLI did not spawn a child process");
      }
      closed = new Promise<void>((resolve) => {
        child.once("close", () => {
          childClosed = true;
          resolve();
        });
      });
      const ready = Promise.withResolvers<number>();
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        const pid = stdout.match(/grandchild ready (\d+)\n/)?.[1];
        if (pid) {
          ready.resolve(Number(pid));
        }
      });
      grandchildPid = await withinTest(
        awaitGateBeforeSettlement(
          ready.promise,
          session.wait(),
          "Timed out waiting for the grandchild's installed-handler receipt",
        ),
        signal,
      );
      expect(Number.isSafeInteger(grandchildPid) && grandchildPid > 0).toBe(true);

      const streamError = new Error(`${streamName} pipe failed`);
      if (afterExit) {
        child.once("exit", () => child[streamName]?.emit("error", streamError));
        child.kill("SIGTERM");
      } else {
        child[streamName]?.emit("error", streamError);
      }

      await expect(withinTest(session.wait(), signal)).rejects.toThrow(
        `${streamName} stream error: ${streamName} pipe failed`,
      );
      expect(childClosed).toBe(true);
      expect(isPidAlive(grandchildPid)).toBe(false);
    } finally {
      session?.kill();
      await closed;
      if (grandchildPid && isPidAlive(grandchildPid)) {
        process.kill(grandchildPid, "SIGKILL");
      }
      await rm(root, { force: true, recursive: true });
    }
  },
);
