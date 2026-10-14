import * as childProcess from "node:child_process";
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
import * as processSnapshot from "./transport-process-snapshot.js";
import { closeCodexAppServerTransportAndWait, hasCodexAppServerNaturalExit } from "./transport.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
}));

let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

// The killed launcher cannot report its inherited-pipe child's extinction.
// Keep the process-table observation, bounded only by the owning test signal.
async function waitForNativeExit(
  pid: number,
  readSnapshot: typeof processSnapshot.readCodexAppServerProcessSnapshot,
  signal: AbortSignal,
): Promise<void> {
  try {
    for (;;) {
      signal.throwIfAborted();
      const snapshot = await withinTest(readSnapshot(performance.now() + 2_000), signal);
      expect(snapshot.some((row) => row.pid === process.pid)).toBe(true);
      const native = snapshot.find((row) => row.pid === pid);
      if (!native || native.state.startsWith("Z")) {
        return;
      }
      await waitForProcessTick(10, undefined, { signal });
    }
  } catch (error) {
    throw new Error(`Native descendant ${pid} did not exit after startup refusal`, {
      cause: error,
    });
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
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  });

  it.for([
    ["available", "inspection"],
    ["unavailable", "commit"],
  ] as const)(
    "reaps inherited-pipe descendants with %s containment after %s refusal",
    async ([containment, failure], { signal }) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-startup-launcher-"));
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
      const { createPluginStateSyncKeyedStore } =
        await import("openclaw/plugin-sdk/plugin-state-store-runtime");
      const store = createPluginStateSyncKeyedStore("codex", {
        namespace: "app-server-processes",
        maxEntries: 512,
        overflowPolicy: "reject-new",
      });
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
      // Clean EOF refusal coverage lives at the shared/isolated startup owner.
      await fs.writeFile(
        wrapperPath,
        `
import { spawn } from "node:child_process";
const [native, ready, input] = process.argv.slice(2);
const child = spawn(process.execPath, [native, ready, input], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
`,
      );
      const spawn = childProcess.spawn;
      let wrapper: childProcess.ChildProcess | undefined;
      let wrapperClosed: Promise<unknown> | undefined;
      let nativePid: number | undefined;
      let nativeExited = false;
      const spawnSpy = vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
        const child = spawn(...args);
        if (Array.isArray(args[1]) && args[1].includes(wrapperPath)) {
          wrapper = child;
          wrapperClosed = once(child, "close");
        }
        return child;
      });
      const readCommand = processSnapshot.readCodexAppServerProcessCommand;
      const readSnapshot = processSnapshot.readCodexAppServerProcessSnapshot;
      let containmentRefused = false;
      if (containment === "unavailable") {
        vi.spyOn(processSnapshot, "readCodexAppServerProcessSnapshot").mockImplementation(
          (deadline, pids) => {
            if (pids === undefined) {
              containmentRefused = true;
              return Promise.reject(new processSnapshot.ProcessInspectionError("unavailable"));
            }
            return readSnapshot(deadline, pids);
          },
        );
      }
      let inspected!: () => void;
      const inspection = new Promise<void>((resolve) => {
        inspected = resolve;
      });
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
          inspected();
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
            inspection,
            started,
            "Startup settled before fixture inspection",
          ),
          signal,
        );
        // Observe actual cleanup independently of the injected inspection failure;
        // an outer acquire timeout must not make a live descendant look settled.
        await waitForNativeExit(nativePid!, readSnapshot, signal);
        nativeExited = true;
        const error = await started;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(
          failure === "inspection" ? "Cannot inspect Codex processes" : "512-row limit",
        );
        expect((error as Error).message).toContain("launcher startup diagnostic");
        expect(
          spawnSpy.mock.calls.filter(
            ([, args]) => Array.isArray(args) && args.includes(wrapperPath),
          ),
        ).toHaveLength(1);
        await expect(fs.access(inputPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(wrapper?.stdout?.destroyed).toBe(true);
        expect(wrapper?.stderr?.destroyed).toBe(true);
        expect(containmentRefused).toBe(containment === "unavailable");
        expect(wrapper?.exitCode).toBeNull();
        expect(wrapper?.signalCode).toBe("SIGKILL");
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
