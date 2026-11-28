import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as waitForProcessTick } from "node:timers/promises";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
  awaitGateBeforeSettlement,
  withinTest,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import * as stdioWorker from "./stdio-worker.js";
import * as processSnapshot from "./transport-process-snapshot.js";
import { registrationStoreOptions } from "./transport-registration-fixtures.test-support.js";
import { closeCodexAppServerTransportAndWait, hasCodexAppServerNaturalExit } from "./transport.js";

vi.mock("./stdio-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stdio-worker.js")>()),
}));

let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

// A killed launcher cannot report its inherited-pipe child's extinction.
async function waitForNativeExit(
  pid: number,
  readSnapshot: typeof processSnapshot.readCodexAppServerProcessSnapshot,
  signal: AbortSignal,
): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    const snapshot = await withinTest(readSnapshot(performance.now() + 2_000, [pid]), signal);
    expect(snapshot.some((row) => row.pid === process.pid)).toBe(true);
    const native = snapshot.find((row) => row.pid === pid);
    if (!native || native.state.startsWith("Z")) {
      return;
    }
    await waitForProcessTick(10, undefined, { signal });
  }
}

describe.skipIf(process.platform === "win32")("Codex failed launcher startup", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(["drained", "held"])("shares the exit budget with %s diagnostic pipes", async (mode) => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: 1,
      signalCode: null,
    });
    const diagnostic: string[] = [];
    child.stdout.resume();
    child.stderr.on("data", (data: Buffer) => diagnostic.push(data.toString()));
    const closing = closeCodexAppServerTransportAndWait(child, { drainStdio: true });
    try {
      await vi.advanceTimersByTimeAsync(1_999);
      expect(child.stderr.destroyed).toBe(false);
      expect(hasCodexAppServerNaturalExit(child)).toBe(false);
      child.stderr.write("last startup diagnostic");
      if (mode === "drained") {
        child.stdout.end();
        child.stderr.end();
      } else {
        await vi.advanceTimersByTimeAsync(1);
      }
      await expect(closing).resolves.toEqual({ exited: mode === "drained", cleanup: "uncertain" });
      expect(diagnostic).toEqual(["last startup diagnostic"]);
      expect(hasCodexAppServerNaturalExit(child)).toBe(mode === "drained");
      expect(child).toMatchObject({ stdout: { destroyed: true }, stderr: { destroyed: true } });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      [child.stdin, child.stdout, child.stderr].forEach((stream) => stream.destroy());
    }
  });

  it.skipIf(process.platform !== "linux")(
    "preserves EOF grace and terminal output after a startup census retry",
    async () => {
      vi.useFakeTimers();
      const child = Object.assign(new EventEmitter(), {
        pid: 12345,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null as number | null,
        kill: vi.fn(),
      });
      child.stdout.resume();
      const output: string[] = [];
      child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString()));
      child.stdin.once("close", () => {
        setTimeout(() => {
          child.exitCode = 0;
          child.emit("exit", 0, null);
        }, 85);
        setTimeout(() => {
          child.stdout.end();
          child.stderr.end("terminal diagnostic");
        }, 185);
      });
      vi.spyOn(processSnapshot, "readCodexAppServerProcessSnapshot").mockImplementation(
        async (deadline) => {
          await new Promise((resolve) => {
            setTimeout(resolve, Math.ceil(deadline! - performance.now()));
          });
          throw new processSnapshot.ProcessInspectionError("deadline");
        },
      );
      const kill = vi.spyOn(process, "kill").mockReturnValue(true);
      const close = closeCodexAppServerTransportAndWait(child, {
        drainStdio: true,
        forceKillDelayMs: 100,
        exitTimeoutMs: 200,
      });
      await vi.advanceTimersByTimeAsync(2_300);
      await expect(close).resolves.toEqual({ exited: true, cleanup: "uncertain" });
      expect(kill).not.toHaveBeenCalledWith(-child.pid, "SIGKILL");
      expect(output).toEqual(["terminal diagnostic"]);
    },
  );

  it("keeps terminal output for a longer diagnostic waiter", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: 1,
    });
    child.stdout.resume();
    const output: string[] = [];
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    const short = closeCodexAppServerTransportAndWait(child, {
      drainStdio: true,
      exitTimeoutMs: 40,
    });
    const long = closeCodexAppServerTransportAndWait(child, {
      drainStdio: true,
      exitTimeoutMs: 500,
    });
    await vi.advanceTimersByTimeAsync(60);
    await expect(short).resolves.toEqual({ exited: false, cleanup: "uncertain" });
    child.stderr.end("late startup diagnostic");
    child.stdout.end();
    await expect(long).resolves.toEqual({ exited: true, cleanup: "uncertain" });
    expect(output).toEqual(["late startup diagnostic"]);
    expect(child.stderr.destroyed).toBe(true);
  });

  it.for([
    ["available", "inspection"],
    ["unavailable", "commit"],
    ...(process.platform === "linux" ? [["transient deadline", "inspection"] as const] : []),
  ] as const)(
    "reaps inherited-pipe descendants with %s containment after %s refusal",
    async ([containment, failure], { signal }) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-startup-launcher-"));
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
      const { createPluginStateSyncKeyedStore } =
        await import("openclaw/plugin-sdk/plugin-state-store-runtime");
      const store = createPluginStateSyncKeyedStore("codex", registrationStoreOptions);
      const nativePath = path.join(root, "native.mjs");
      const wrapperPath = path.join(root, "wrapper.mjs");
      const readyPath = path.join(root, "native.pid");
      const inputPath = path.join(root, "input");
      await fs.writeFile(
        nativePath,
        `
import fs from "node:fs";
${fixtureReceiptClientSource(receipts.endpoint)}
const [ready, input] = process.argv.slice(2);
process.stdin.on("data", (data) => fs.appendFileSync(input, data));
setInterval(() => {}, 1_000);
fs.writeSync(2, "launcher startup diagnostic\\n");
fs.writeFileSync(ready, String(process.pid));
sendReceipt(ready, "ready");
`,
      );
      // Match the pinned npm launcher's inherited pipes and signal mirroring.
      await fs.writeFile(
        wrapperPath,
        `
import { spawn } from "node:child_process";
const [native, ready, input] = process.argv.slice(2);
const child = spawn(process.execPath, [native, ready, input], { detached: ${containment === "transient deadline"}, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
`,
      );
      const spawn = stdioWorker.spawnCodexStdio;
      let wrapper: stdioWorker.CodexStdioChild | undefined;
      let wrapperClosed: Promise<unknown> | undefined;
      let nativePid: number | undefined;
      let nativeExited = false;
      let wrapperSpawns = 0;
      vi.spyOn(stdioWorker, "spawnCodexStdio").mockImplementation((...args) => {
        const child = spawn(...args);
        if (args[1].includes(wrapperPath)) {
          wrapperSpawns++;
          wrapper = child;
          wrapperClosed = once(child, "close");
        }
        return child;
      });
      const readCommand = processSnapshot.readCodexAppServerProcessCommand;
      const readSnapshot = processSnapshot.readCodexAppServerProcessSnapshot;
      let containmentRefused = false;
      if (containment !== "available") {
        vi.spyOn(processSnapshot, "readCodexAppServerProcessSnapshot").mockImplementation(
          (deadline, pids, roots) => {
            if (pids === undefined && (containment === "unavailable" || !containmentRefused)) {
              containmentRefused = true;
              if (containment === "transient deadline") {
                return readSnapshot(performance.now(), pids, roots);
              }
              return Promise.reject(new processSnapshot.ProcessInspectionError("unavailable"));
            }
            return readSnapshot(deadline, pids, roots);
          },
        );
      }
      const inspection = Promise.withResolvers<void>();
      vi.spyOn(processSnapshot, "readCodexAppServerProcessCommand").mockImplementation(
        async (observed, deadline) => {
          if (observed.pid !== wrapper?.pid) {
            return readCommand(observed, deadline);
          }
          // The PID file precedes the receipt; a close on the other pipe may win delivery.
          const closedBeforeReady = wrapperClosed!.then(async () => {
            expect(await fs.readFile(readyPath, "utf8")).not.toBe("");
          });
          await withinTest(
            Promise.race([receipts.waitFor(readyPath, "ready"), closedBeforeReady]),
            signal,
          );
          nativePid = Number(await fs.readFile(readyPath, "utf8"));
          const command = await readCommand(observed, deadline);
          expect(command).toBeDefined();
          if (failure === "commit") {
            for (let index = 0; index < 512; index++) {
              store.register(`capacity-${index}`, {});
            }
          }
          inspection.resolve();
          if (failure === "inspection") {
            throw new processSnapshot.ProcessInspectionError("unavailable");
          }
          return command;
        },
      );
      const started = CodexAppServerClient.start({
        transport: "stdio",
        command: process.execPath,
        commandSource: "config",
        args: [wrapperPath, nativePath, readyPath, inputPath],
      }).catch((error: unknown) => error);
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            inspection.promise,
            started,
            "Startup settled before fixture inspection",
          ),
          signal,
        );
        if (containment === "transient deadline") {
          await withinTest(started, signal);
          const rows = await readSnapshot(undefined, [nativePid!]);
          const helper = rows.find((row) => row.pid === nativePid);
          expect(helper === undefined || processSnapshot.isDeadProcessState(helper.state)).toBe(
            true,
          );
        }
        // The injected inspection failure cannot certify physical descendant exit.
        await waitForNativeExit(nativePid!, readSnapshot, signal);
        nativeExited = true;
        const error = await started;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(
          failure === "inspection" ? "Cannot inspect Codex processes" : "512-row limit",
        );
        expect((error as Error).message).toContain("launcher startup diagnostic");
        expect(wrapperSpawns).toBe(1);
        await expect(fs.access(inputPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(wrapper).toMatchObject({
          stdout: { destroyed: true },
          stderr: { destroyed: true },
          exitCode: null,
          signalCode: "SIGKILL",
        });
        expect(containmentRefused).toBe(containment !== "available");
      } finally {
        vi.restoreAllMocks();
        nativePid ??= Number(await fs.readFile(readyPath, "utf8").catch(() => "")) || undefined;
        if (nativePid && !nativeExited) {
          try {
            process.kill(nativePid, "SIGKILL");
          } catch {
            /* Already exited. */
          }
        }
        wrapper?.kill("SIGKILL");
        await wrapperClosed;
        await started;
        store.clear();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
