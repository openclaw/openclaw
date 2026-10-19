import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
  withinTest,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { killMatrixQaCliChild } from "./scenario-runtime-cli-process.js";
import {
  formatMatrixQaCliCommand,
  redactMatrixQaCliOutput,
  runMatrixQaOpenClawCli,
  startMatrixQaOpenClawCli,
} from "./scenario-runtime-cli.js";

let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(() => receipts.close());
async function writeCli(root: string, lines: string[]) {
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "dist", "index.mjs"), lines.join("\n"));
}
function killRemainingPids(pids: number[]) {
  for (const pid of pids.toReversed()) {
    if (isProcessRunning(pid)) {
      process.kill(pid, "SIGKILL");
    }
  }
}
async function withCliFixture(exercise: (root: string, pids: number[]) => Promise<void>) {
  const root = await mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "matrix-qa-cli-"));
  const pids: number[] = [];
  try {
    await exercise(root, pids);
  } finally {
    killRemainingPids(pids);
    await rm(root, { force: true, recursive: true });
  }
}
const cliParams = (cwd: string, timeoutMs = 500) => ({
  args: ["matrix", "verify", "self"],
  cwd,
  env: process.env,
  timeoutMs,
});
const waitForText = (session: ReturnType<typeof startMatrixQaOpenClawCli>, text: string) =>
  session.waitForOutput((output) => output.stdout.includes(text), text, 5_000);

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPidFile(pathToCheck: string): Promise<number> {
  const value = (await readFile(pathToCheck, "utf8")).trim();
  const pid = Number(value);
  expect(value).toMatch(/^[1-9]\d*$/u);
  expect(Number.isSafeInteger(pid)).toBe(true);
  return pid;
}

async function waitForProcessExit(pid: number, signal: AbortSignal): Promise<void> {
  while (isProcessRunning(pid)) {
    signal.throwIfAborted();
    await sleep(5, undefined, { signal });
  }
}

async function withReadyCliTimeout(
  params: Parameters<typeof startMatrixQaOpenClawCli>[0],
  ready: (session: ReturnType<typeof startMatrixQaOpenClawCli>) => Promise<void>,
  exercise: (session: ReturnType<typeof startMatrixQaOpenClawCli>) => Promise<void>,
): Promise<void> {
  const schedule = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  const timer = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation((callback, delay, ...args) => {
      const handle = schedule(callback, delay, ...args);
      if (!expire && delay === params.timeoutMs) {
        clearTimeout(handle);
        expire = () => callback(...args);
      }
      return handle;
    });
  let session: ReturnType<typeof startMatrixQaOpenClawCli> | undefined;
  try {
    session = startMatrixQaOpenClawCli(params);
    // Only the execution deadline is held; process I/O and cleanup timers stay native.
    timer.mockRestore();
    await ready(session);
    expect(expire).toBeTypeOf("function");
    expire!();
    await exercise(session);
  } finally {
    timer.mockRestore();
    session?.kill();
    await session?.wait().catch(() => undefined);
  }
}

describe("Matrix QA CLI runtime", () => {
  it.each([
    [
      "matrix verify backup restore --recovery-key abcdef1234567890ghij",
      "openclaw matrix verify backup restore --recovery-key [REDACTED]",
    ],
    [
      "matrix account add --access-token=token-123",
      "openclaw matrix account add --access-token=[REDACTED]",
    ],
    [
      "matrix verify device abcdef1234567890ghij --json",
      "openclaw matrix verify device [REDACTED] --json",
    ],
  ])("redacts secret arguments in %s", (command, expected) => {
    expect(formatMatrixQaCliCommand(command.split(" "))).toBe(expected);
  });

  it("redacts Matrix token output before diagnostics and artifacts", () => {
    expect(
      redactMatrixQaCliOutput("GET /_matrix/client/v3/sync?access_token=abcdef1234567890ghij"),
    ).toBe("GET /_matrix/client/v3/sync?access_token=abcdef…ghij");
  });

  it.each([
    { label: "succeeds after escalation", statuses: [1, 0], fallsBack: false },
    { label: "fails completely", statuses: [1, 1], fallsBack: true },
  ])("composes Windows cleanup when canonical taskkill $label", ({ fallsBack, statuses }) => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const killMock = vi.fn();
      const child = {
        pid: 12345,
        kill: killMock,
      } as unknown as Parameters<typeof killMatrixQaCliChild>[0];
      const runTaskkill = vi
        .fn()
        .mockReturnValueOnce({ status: statuses[0] })
        .mockReturnValueOnce({ status: statuses[1] });

      killMatrixQaCliChild(child, "SIGTERM", runTaskkill);

      expect(runTaskkill).toHaveBeenCalledTimes(2);
      expect(killMock.mock.calls).toEqual(fallsBack ? [["SIGTERM"]] : []);
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
    }
  });

  it.each([
    { exitCode: 0, allowNonZero: false },
    { exitCode: 7, allowNonZero: true },
  ])("can pass stdin to CLI commands exiting $exitCode", async ({ exitCode, allowNonZero }) => {
    await withCliFixture(async (root) => {
      await writeCli(root, [
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        "  process.stdout.write(JSON.stringify({ input: input.trim() }));",
        `  process.exitCode = ${exitCode};`,
        "});",
      ]);
      const result = await runMatrixQaOpenClawCli({
        allowNonZero,
        args: ["matrix", "verify", "backup", "restore", "--recovery-key-stdin", "--json"],
        cwd: root,
        env: process.env,
        stdin: "stdin-recovery-key\n",
        timeoutMs: 5_000,
      });
      expect(result.exitCode).toBe(exitCode);
      expect(result.stdout).toContain('"input":"stdin-recovery-key"');
    });
  });

  it("closes stdin after interactive prompts and settles every waiting caller", async () => {
    await withCliFixture(async (root) => {
      await writeCli(root, [
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; process.stdout.write('prompt answered\\n'); });",
        "process.stdin.on('end', () => {",
        "  process.stdout.write(JSON.stringify({ input: input.trim(), ended: true }));",
        "});",
      ]);
      const session = startMatrixQaOpenClawCli(cliParams(root, 5_000));
      await session.writeStdin("yes\n");
      await session.waitForOutput(
        (output) => output.text.includes("prompt answered"),
        "interactive prompt acknowledgement",
        5_000,
      );
      const firstWait = session.wait();
      const secondWait = session.wait();
      session.endStdin();
      const result = await secondWait;

      expect(JSON.parse(result.stdout.split("\n").at(-1) ?? "")).toEqual({
        input: "yes",
        ended: true,
      });
      await expect(firstWait).resolves.toEqual(result);
      await expect(session.wait()).resolves.toEqual(result);
    });
  });

  it("includes timed-out CLI output in diagnostics", async () => {
    await withCliFixture(async (root) => {
      await writeCli(root, [
        "process.stdout.write('waiting for verification\\n');",
        "process.stderr.write('matrix sdk still syncing\\n');",
        "setInterval(() => {}, 1000);",
      ]);

      await withReadyCliTimeout(
        cliParams(root, 250),
        async (session) => {
          await session.waitForOutput(
            (output) =>
              output.stdout.includes("waiting for verification") &&
              output.stderr.includes("matrix sdk still syncing"),
            "timeout diagnostics ready",
            5_000,
          );
        },
        async (session) => {
          await expect(session.wait()).rejects.toThrow(
            /stderr:\nmatrix sdk still syncing[\s\S]*stdout:\nwaiting for verification/u,
          );
        },
      );
    });
  });

  async function assertUncooperativeCli(late: boolean, signal: AbortSignal) {
    await withCliFixture(async (root, pids) => {
      const pidPath = path.join(root, "cli.pid");
      const marker = late ? "late wait timeout marker" : "waiting despite graceful shutdown";
      const handler = late ? "" : "process.stdout.write('ignored sigterm\\n');";
      await writeCli(root, [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
        `process.on('SIGTERM', () => { ${handler} });`,
        `process.stdout.write('${marker}\\n');`,
        "setInterval(() => {}, 1000);",
      ]);

      await withReadyCliTimeout(
        cliParams(root),
        async (session) => {
          await waitForText(session, marker);
          pids.push(await readPidFile(pidPath));
        },
        async (session) => {
          const [pid] = pids;
          assert(pid !== undefined, "expected the ready CLI PID");
          if (late) {
            await waitForProcessExit(pid, signal);
          }
          await expect(session.wait()).rejects.toThrow(/timed out after 500ms/u);
          if (late) {
            await expect(session.wait()).rejects.toThrow(marker);
          }
          expect(isProcessRunning(pid)).toBe(false);
        },
      );
    });
  }
  it("kills an uncooperative CLI with an immediate waiter", async ({ signal }) => {
    await assertUncooperativeCli(false, signal);
  });
  it("preserves timeout diagnostics for a late waiter", async ({ signal }) => {
    await assertUncooperativeCli(true, signal);
  });

  it("settles and kills descendants that keep timed-out CLI stdio open", async () => {
    await withCliFixture(async (root, pids) => {
      const childPidPath = path.join(root, "child.pid");
      const grandchildPidPath = path.join(root, "grandchild.pid");
      await writeCli(root, [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
        "const grandchild = spawn(process.execPath, ['-e', 'process.stdout.write(\"descendant ready\\\\n\"); setInterval(() => {}, 1000);'], { stdio: ['ignore', 'inherit', 'inherit'] });",
        `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid));`,
        "process.on('SIGTERM', () => {});",
        "process.stdout.write('spawned persistent descendant\\n');",
        "setInterval(() => {}, 1000);",
      ]);

      await withReadyCliTimeout(
        cliParams(root),
        async (session) => {
          await session.waitForOutput(
            (output) =>
              output.stdout.includes("spawned persistent descendant") &&
              output.stdout.includes("descendant ready"),
            "parent and descendant readiness",
            5_000,
          );
          pids.push(await readPidFile(childPidPath));
          pids.push(await readPidFile(grandchildPidPath));
        },
        async (session) => {
          await expect(session.wait()).rejects.toThrow(/timed out after 500ms/u);
          const [childPid, grandchildPid] = pids;
          assert(childPid !== undefined && grandchildPid !== undefined, "expected both ready PIDs");
          expect(isProcessRunning(childPid)).toBe(false);
          if (process.platform !== "win32") {
            expect(isProcessRunning(grandchildPid)).toBe(false);
          }
        },
      );
    });
  });

  it("kills ignored-stdio descendants after manual CLI session kill", async ({
    signal,
    onTestFinished,
  }) => {
    if (process.platform === "win32") {
      return;
    }
    const cleanup = withCliFixture(async (root, pids) => {
      const childPidPath = path.join(root, "child.pid");
      const grandchildPidPath = path.join(root, "grandchild.pid");
      let session: ReturnType<typeof startMatrixQaOpenClawCli> | undefined;
      try {
        await writeCli(root, [
          "import { spawn } from 'node:child_process';",
          "import { writeFileSync } from 'node:fs';",
          fixtureReceiptClientSource(receipts.endpoint),
          `writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
          "const grandchild = spawn(process.execPath, ['-e', 'process.on(\\'SIGTERM\\', () => {}); setInterval(() => {}, 1000);'], { stdio: 'ignore' });",
          "grandchild.unref();",
          `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid));`,
          "process.on('SIGTERM', () => process.exit(0));",
          `sendReceipt(${JSON.stringify(childPidPath)}, "ready");`,
          "setInterval(() => {}, 1000);",
        ]);

        session = startMatrixQaOpenClawCli({
          allowNonZero: true,
          ...cliParams(root, 10_000),
        });
        const readReadyPids = async () => {
          pids[0] = await readPidFile(childPidPath);
          pids[1] = await readPidFile(grandchildPidPath);
        };
        // PID records precede the receipt; a session result can overtake its separate socket.
        await withinTest(
          Promise.race([
            receipts.waitFor(childPidPath, "ready").then(readReadyPids),
            session.wait().then(readReadyPids, readReadyPids),
          ]),
          signal,
        );

        const sessionExit = expect(session.wait()).rejects.toThrow(/was cancelled/u);
        session.kill();

        await withinTest(sessionExit, signal);
        await Promise.all(pids.map((pid) => waitForProcessExit(pid, signal)));
        expect(pids.map(isProcessRunning)).toEqual([false, false]);
      } finally {
        session?.kill();
        await session?.wait().catch(() => undefined);
      }
    });
    // A timed-out test callback may finish before its async cleanup; join the whole fixture.
    onTestFinished(() => cleanup);
    await cleanup;
  });
});
