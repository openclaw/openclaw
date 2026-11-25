import * as childProcess from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import { createStdioTransport } from "./transport-stdio.js";

const fixture = vi.hoisted(() => ({ preload: "" }));
// mock-isolation: registration's durable identity contract has separate native coverage.
vi.mock("./transport-process-registration.js", async (original) => ({
  ...(await original<typeof import("./transport-process-registration.js")>()),
  prepareCodexAppServerProcessRegistration: async () => async (child: NodeJS.EventEmitter) => {
    await once(child, "spawn");
  },
}));
// Inject the same native spawn stall into the real worker and the pre-fix main thread.
vi.mock("openclaw/plugin-sdk/process-runtime", async (original) => {
  const runtime = await original<typeof import("openclaw/plugin-sdk/process-runtime")>();
  return {
    ...runtime,
    createCpuTrackedWorker: (url: URL, options: import("node:worker_threads").WorkerOptions) =>
      runtime.createCpuTrackedWorker(url, {
        ...options,
        execArgv: [
          ...(options.execArgv ?? []),
          ...(fixture.preload ? ["--import", fixture.preload] : []),
        ],
      }),
  };
});
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
}));

it("keeps the host responsive while native exec stalls, then drains stdio and observes real exit", async () => {
  await withTempDir("codex-slow-exec-", async (root) => {
    const preload = path.join(root, "slow-exec.mjs");
    await fs.writeFile(
      preload,
      `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const spawn = childProcess.spawn;
      childProcess.spawn = (...args) => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
        return spawn(...args);
      };
      syncBuiltinESMExports();
    `,
    );
    fixture.preload = pathToFileURL(preload).href;
    const nativeSpawn = childProcess.spawn;
    const spy = vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
      return Reflect.apply(nativeSpawn, childProcess, args);
    });
    let last = performance.now();
    let gap = 0;
    let ticks = 0;
    const heartbeat = setInterval(() => {
      const now = performance.now();
      gap = Math.max(gap, now - last);
      last = now;
      ticks++;
    }, 10);
    let child: Awaited<ReturnType<typeof createStdioTransport>> | undefined;
    try {
      const start = performance.now();
      let closed: Promise<unknown[]> | undefined;
      let stdout = "";
      let stderr = "";
      child = await createStdioTransport(
        {
          transport: "stdio",
          command: process.execPath,
          args: [
            "-e",
            "process.stdin.pipe(process.stdout); process.stdin.on('end', () => process.stderr.write('drained'));",
          ],
          headers: {},
        },
        process.env,
        undefined,
        (transport) => {
          closed = once(transport, "close");
          transport.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
          });
          transport.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
          });
        },
      );
      expect(performance.now() - start).toBeGreaterThanOrEqual(350);
      await delay(20);
      expect(gap).toBeLessThan(150);
      expect(ticks).toBeGreaterThan(10);
      const payload = "synthetic stdio\n".repeat(8192);
      child.stdin.end(payload);
      await expect(closed).resolves.toEqual([0, null]);
      expect(stdout).toBe(payload);
      expect(stderr).toBe("drained");
      expect(child.exitCode).toBe(0);
    } finally {
      child?.kill("SIGKILL");
      clearInterval(heartbeat);
      spy.mockRestore();
      fixture.preload = "";
    }
  });
});

it("rechecks live launch authority after worker startup without starting a revoked command", async () => {
  let checks = 0;
  const spawned = vi.fn();
  await expect(
    createStdioTransport(
      {
        transport: "stdio",
        command: process.execPath,
        args: ["-e", "process.stdin.resume()"],
        headers: {},
      },
      process.env,
      () => {
        if (++checks > 1) {
          throw new Error("launch authority revoked");
        }
      },
      (child) => child.once("spawn", spawned),
    ),
  ).rejects.toThrow("launch authority revoked");
  expect(spawned).not.toHaveBeenCalled();
});

it("closes the transport worker when a killed native child leaves stdin open", async () => {
  let closed: Promise<unknown[]> | undefined;
  const child = await createStdioTransport(
    {
      transport: "stdio",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      headers: {},
    },
    process.env,
    undefined,
    (transport) => {
      closed = once(transport, "close");
      transport.stdout.resume();
      transport.stderr.resume();
    },
  );
  child.kill("SIGKILL");
  await expect(closed).resolves.toEqual([null, "SIGKILL"]);
  expect(child.signalCode).toBe("SIGKILL");
});

it("reports a worker startup failure once without inventing native exit facts", async () => {
  await withTempDir("codex-worker-failure-", async (root) => {
    const preload = path.join(root, "startup-failure.mjs");
    await fs.writeFile(preload, "throw new Error('synthetic worker startup failure');");
    fixture.preload = pathToFileURL(preload).href;
    const errors: Error[] = [];
    let closed: Promise<unknown[]> | undefined;
    try {
      await expect(
        createStdioTransport(
          {
            transport: "stdio",
            command: process.execPath,
            args: ["-e", "process.stdin.resume()"],
            headers: {},
          },
          process.env,
          undefined,
          (child) => {
            child.on("error", (error: Error) => errors.push(error));
            closed = new Promise((resolve) => {
              child.once("close", (...facts) => resolve(facts));
            });
          },
        ),
      ).rejects.toThrow("synthetic worker startup failure");
      await expect(closed).resolves.toEqual([null, null]);
      expect(errors.map((error) => error.message)).toEqual(["synthetic worker startup failure"]);
    } finally {
      fixture.preload = "";
    }
  });
});
