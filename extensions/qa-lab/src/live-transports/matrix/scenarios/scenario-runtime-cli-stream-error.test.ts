// QA Lab Matrix tests cover parent-side CLI pipe failures.
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isPidAlive } from "openclaw/plugin-sdk/process-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
  children: [] as ChildProcess[],
  spawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  childProcessMocks.spawn.mockImplementation((...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
    childProcessMocks.children.push(child);
    return child;
  });
  return {
    ...actual,
    spawn: childProcessMocks.spawn,
  };
});

import { startMatrixQaOpenClawCli } from "./scenario-runtime-cli.js";

async function createCliRoot(): Promise<{
  grandchildPidPath: string;
  grandchildReadyPath: string;
  root: string;
}> {
  const root = await mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "matrix-qa-cli-stream-error-"),
  );
  const grandchildPidPath = path.join(root, "grandchild.pid");
  const grandchildReadyPath = path.join(root, "grandchild.ready");
  const grandchildScript = [
    "const { writeFileSync } = require('node:fs');",
    "process.on('SIGTERM', () => {});",
    `writeFileSync(${JSON.stringify(grandchildReadyPath)}, 'ready');`,
    "process.send('ready');",
    "setInterval(() => {}, 1000);",
  ].join(" ");
  await mkdir(path.join(root, "dist"));
  await writeFile(
    path.join(root, "dist", "index.mjs"),
    [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });`,
      `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid));`,
      "grandchild.once('message', () => process.stdout.write('grandchild ready\\n'));",
      "process.stdout.write('ready\\n');",
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  return { grandchildPidPath, grandchildReadyPath, root };
}

function latestChild(): ChildProcess {
  const child = childProcessMocks.children.at(-1);
  expect(child).toBeDefined();
  return child as ChildProcess;
}

describe("Matrix QA CLI runtime stream errors", () => {
  beforeEach(() => {
    childProcessMocks.children.length = 0;
    childProcessMocks.spawn.mockClear();
  });

  it.for([
    ["stdout", false],
    ["stderr", false],
    ["stdout", true],
  ] as const)(
    "rejects after cleaning up when %s emits a stream error (after exit: %s)",
    async ([streamName, afterExit], { signal }) => {
      const { grandchildPidPath, grandchildReadyPath, root } = await createCliRoot();
      let child: ChildProcess | undefined;
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
        child = latestChild();
        closed = new Promise<void>((resolve) => {
          child?.once("close", () => {
            childClosed = true;
            resolve();
          });
        });
        const ready = Promise.withResolvers<void>();
        let stdout = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.includes("grandchild ready\n")) {
            ready.resolve();
          }
        });
        await withinTest(
          awaitGateBeforeSettlement(
            ready.promise,
            session.wait(),
            `Timed out waiting for ${grandchildReadyPath}`,
          ),
          signal,
        );
        // The parent writes the PID before forwarding its child's installed-handler receipt.
        grandchildPid = Number(await readFile(grandchildPidPath, "utf8"));
        expect(Number.isSafeInteger(grandchildPid) && grandchildPid > 0).toBe(true);
        expect(await readFile(grandchildReadyPath, "utf8")).toBe("ready");

        const streamError = new Error(`${streamName} pipe failed`);
        if (afterExit) {
          child.once("exit", () => child?.[streamName]?.emit("error", streamError));
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
});
