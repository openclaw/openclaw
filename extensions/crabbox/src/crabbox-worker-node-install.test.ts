import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable } from "node:stream";
import { runInNewContext } from "node:vm";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCrabboxNodeRuntimeSetup } from "./crabbox-worker-node-enrollment.js";
import {
  createNodeBootstrapFixture,
  createWorkerArchiveFixture,
} from "./crabbox-worker-node-enrollment.test-support.js";

const require = createRequire(import.meta.url);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.each(["linux", "win32"])("%s bootstrap install settlement", (platform) => {
  it.each(["download", "timeout", "cancel"])(
    "terminates npm's tree on %s and joins close before cleanup",
    async (failure) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const home = fs.realpathSync(tempDirs.make("crabbox-install-settlement-"));
      const bytes = Buffer.from("synthetic bootstrap archive");
      const nodeBootstrap = createNodeBootstrapFixture({
        url: "http://gateway.example.test/bootstrap",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      const workerBundle = {
        ...createWorkerArchiveFixture(),
        url: "http://gateway.example.test/worker",
      };
      const setup = createCrabboxNodeRuntimeSetup({
        leaseId: "cbx_settlement",
        nodeBootstrap,
        workerBundle,
        target: "windows/normal",
      });
      const encoded = setup.command.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/u)![1]!;
      const spawned = Promise.withResolvers<void>();
      const workerRequested = Promise.withResolvers<void>();
      const child = Object.assign(new EventEmitter(), { pid: 12345 });
      const spawn = vi.fn(() => {
        spawned.resolve();
        return child;
      });
      const spawnSync = vi.fn(() => ({ status: 0 }));
      const processFixture = Object.assign(new EventEmitter(), {
        platform,
        execPath: "/fixture/node",
        env: { ...setup.forwardedEnv },
        umask: vi.fn(),
        kill: vi.fn(),
        exitCode: 0,
      });
      let workerRequest: EventEmitter & { destroy: (error: Error) => void };
      const request = (url: URL, options: { signal: AbortSignal }) => {
        const current = Object.assign(new EventEmitter(), {
          end: () => {
            if (url.pathname === "/worker") {
              workerRequest = current;
              workerRequested.resolve();
              return;
            }
            const response = Object.assign(Readable.from([bytes]), {
              statusCode: 200,
              headers: { "content-length": String(bytes.length) },
            });
            current.emit("response", response);
          },
          destroy: (error: Error) => {
            current.emit("error", error);
          },
        });
        options.signal.addEventListener("abort", () => current.destroy(options.signal.reason), {
          once: true,
        });
        return current;
      };
      const output: string[] = [];
      const runtimeRoot = path.join(home, ".openclaw-worker", "node-runtimes");
      const running = runInNewContext(Buffer.from(encoded, "base64").toString("utf8"), {
        Buffer,
        URL,
        AbortController,
        setTimeout,
        clearTimeout,
        process: processFixture,
        console: { error: (line: string) => output.push(line) },
        require: (name: string) => {
          if (name === "node:fs") {
            return {
              ...fs,
              existsSync: (file: string) => file.endsWith("npm-cli.js") || fs.existsSync(file),
            };
          }
          if (name === "node:os") {
            return { homedir: () => home };
          }
          if (name === "node:child_process") {
            return { spawn, spawnSync };
          }
          if (name === "node:http") {
            return { request };
          }
          return require(name);
        },
      }) as Promise<void>;
      try {
        await Promise.all([spawned.promise, workerRequested.promise]);
        if (failure === "download") {
          workerRequest!.destroy(new Error("synthetic worker download failure"));
          // The download catch aborts its peer after the response promise rejects.
          await vi.advanceTimersByTimeAsync(0);
        } else if (failure === "timeout") {
          await vi.advanceTimersByTimeAsync(600000);
        } else {
          processFixture.emit("SIGTERM");
        }
        if (platform === "win32") {
          expect(spawnSync).toHaveBeenCalledWith(
            "taskkill.exe",
            ["/PID", "12345", "/T", "/F"],
            expect.any(Object),
          );
        } else {
          expect(processFixture.kill).toHaveBeenCalledExactlyOnceWith(-12345, "SIGKILL");
        }
        expect(fs.readdirSync(runtimeRoot)).toEqual([expect.stringMatching(/^node-bootstrap-/)]);
      } finally {
        child.emit("close", null, "SIGKILL");
        await running;
        vi.useRealTimers();
      }
      expect(processFixture.exitCode).toBe(1);
      expect(output.at(-1)).toContain(
        failure === "download"
          ? "synthetic worker download failure"
          : failure === "timeout"
            ? "installation timed out"
            : "installation cancelled",
      );
      expect(fs.readdirSync(runtimeRoot)).toEqual([]);
      expect(processFixture.listenerCount("SIGTERM")).toBe(0);
    },
  );
});
