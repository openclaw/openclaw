import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable } from "node:stream";
import { isNativeError } from "node:util/types";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCrabboxNodeRuntimeSetup } from "./crabbox-worker-node-enrollment.js";
import {
  createNodeBootstrapFixture,
  createWorkerArchiveFixture,
} from "./crabbox-worker-node-enrollment.test-support.js";

const require = createRequire(import.meta.url);
const archive = Buffer.from("verified worker archive".repeat(3));
const runtimeArchive = Buffer.from("verified runtime archive".repeat(3));

type DownloadOutcome =
  | string
  | number
  | {
      durationMs: number;
      failure?: string;
      progress?: boolean;
      stall?: "headers" | "body";
      resetAfterBytes?: number;
      ignoreRange?: boolean;
    };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

function waitForDownload(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      const reason = signal?.reason;
      reject(isNativeError(reason) ? reason : new Error("download aborted", { cause: reason }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
  });
}

async function download(
  outcomes: DownloadOutcome[] | ((elapsedMs: number) => DownloadOutcome),
  freshRuntime = false,
  install = { durationMs: 0, exitCode: 0 },
  bootstrapTimeoutMs?: number,
) {
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const workerBundle = {
    ...createWorkerArchiveFixture(),
    sha256,
    bytes: archive.length,
    packageRelativePath: `worker-artifacts/${sha256}.tgz`,
    ...(Array.isArray(outcomes) && outcomes[0] === "pin" ? { tlsFingerprint: "a".repeat(64) } : {}),
  };
  const nodeBootstrap = createNodeBootstrapFixture({
    sha256: createHash("sha256").update(runtimeArchive).digest("hex"),
    bytes: runtimeArchive.length,
  });
  const setup = createCrabboxNodeRuntimeSetup({
    leaseId: "cbx_download_fixture",
    nodeBootstrap,
    workerBundle,
  });
  const requests: string[] = [];
  const ranges: Array<string | undefined> = [];
  const created: string[] = [];
  const files = new Map<string, Buffer>();
  const removed: Array<{ file: string; bytes: number }> = [];
  const delays: number[] = [];
  const output: string[] = [];
  const installations: number[] = [];
  let elapsedMs = 0;
  const aborted: string[] = [];
  const completedAt: number[] = [];
  const grants = new Map<string, AbortSignal>(
    [nodeBootstrap, workerBundle].map((artifact) => {
      const controller = new AbortController();
      setTimeout(
        () => {
          controller.abort(Object.assign(new Error("capability expired"), { code: "ECONNRESET" }));
        },
        bootstrapTimeoutMs ?? 10 * 60_000,
      );
      return [`Bearer ${artifact.token}`, controller.signal] as const;
    }),
  );
  const transport = {
    request: (
      url: URL,
      options: { headers: { authorization: string; range?: string }; signal: AbortSignal },
    ) => {
      const content = url.href === nodeBootstrap.url ? runtimeArchive : archive;
      const outcome =
        typeof outcomes === "function"
          ? outcomes(Date.now())
          : outcomes[Math.min(requests.length, outcomes.length - 1)];
      requests.push(options.headers.authorization);
      ranges.push(options.headers.range);
      const offset =
        options.headers.range &&
        outcome !== "ignore-range" &&
        !(typeof outcome === "object" && outcome.ignoreRange)
          ? Number(options.headers.range.slice(6, -1))
          : 0;
      const split = Math.min(
        offset +
          (typeof outcome === "object" && outcome.resetAfterBytes !== undefined
            ? outcome.resetAfterBytes
            : Math.floor(content.length * 0.4)),
        content.length,
      );
      const grant = grants.get(options.headers.authorization)!;
      const destroyed = new AbortController();
      const signal = AbortSignal.any([options.signal, grant, destroyed.signal]);
      const unavailable = grant.aborted;
      let finished = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const socket = Object.assign(new EventEmitter(), {
        getPeerCertificate: () => ({ fingerprint256: "b".repeat(64) }),
        setTimeout: (ms: number, callback: () => void) => {
          idleTimer = setTimeout(() => socket.emit("timeout"), ms);
          socket.once("timeout", callback);
        },
      });
      signal.addEventListener(
        "abort",
        () => {
          if (!finished) {
            aborted.push(options.headers.authorization);
          }
          clearTimeout(idleTimer);
          request.emit("error", signal.reason);
        },
        { once: true },
      );
      const request = Object.assign(new EventEmitter(), {
        destroy: (error: unknown) => destroyed.abort(error),
        end: () => {
          const response = Object.assign(
            Readable.from(
              (async function* () {
                if (typeof outcome === "object") {
                  if (outcome.progress) {
                    const startedAt = Date.now();
                    for (let index = offset; index < content.length; index++) {
                      const arrival = Math.round(
                        (outcome.durationMs * (index + 1 - offset)) / (content.length - offset),
                      );
                      await waitForDownload(startedAt + arrival - Date.now(), signal);
                      idleTimer?.refresh();
                      yield content.subarray(index, index + 1);
                    }
                    finished = true;
                    completedAt.push(Date.now());
                    return;
                  }
                  if (!outcome.stall) {
                    await waitForDownload(outcome.durationMs, signal);
                  }
                  if (outcome.failure) {
                    throw new Error(outcome.failure);
                  }
                }
                if (outcome === "busy") {
                  yield Buffer.from('{"error":"transfer_in_progress"}');
                  return;
                }
                signal.throwIfAborted();
                idleTimer?.refresh();
                yield content.subarray(offset, split);
                if (typeof outcome === "object" && outcome.resetAfterBytes !== undefined) {
                  throw Object.assign(new Error("transport interrupted"), { code: "ECONNRESET" });
                }
                if (typeof outcome === "object" && outcome.stall === "body") {
                  await waitForDownload(outcome.durationMs, signal);
                }
                if (outcome === "short") {
                  return;
                }
                if (
                  typeof outcome === "string" &&
                  ![
                    "success",
                    "digest",
                    "size",
                    "ignore-range",
                    "range-mismatch",
                    "late-reset",
                  ].includes(outcome)
                ) {
                  throw Object.assign(new Error("transport interrupted"), { code: outcome });
                }
                signal.throwIfAborted();
                idleTimer?.refresh();
                yield outcome === "digest"
                  ? Buffer.alloc(content.length - split)
                  : content.subarray(split);
                if (outcome === "size") {
                  yield Buffer.from("excess");
                }
                if (outcome === "late-reset") {
                  throw Object.assign(new Error("transport interrupted"), { code: "ECONNRESET" });
                }
                finished = true;
                completedAt.push(Date.now());
              })(),
            ),
            {
              statusCode: unavailable
                ? 404
                : outcome === "busy"
                  ? 503
                  : typeof outcome === "number"
                    ? outcome
                    : offset
                      ? 206
                      : 200,
              headers: offset
                ? {
                    "content-range": `bytes ${outcome === "range-mismatch" ? 0 : offset}-${content.length - 1}/${content.length}`,
                  }
                : {},
            },
          );
          response.once("close", () => clearTimeout(idleTimer));
          void (async () => {
            // Native requests receive their socket before response headers.
            await Promise.resolve();
            if (typeof outcome === "object" && outcome.stall === "headers") {
              await waitForDownload(outcome.durationMs, signal);
            }
            signal.throwIfAborted();
            idleTimer?.refresh();
            request.emit("response", response);
          })().catch((error: unknown) => request.destroy(error));
        },
      });
      queueMicrotask(() => {
        let listeners = 0;
        socket.on("newListener", (event) => {
          if (event === "secureConnect" && ++listeners === (outcome === "pin" ? 2 : 1)) {
            queueMicrotask(() => socket.emit("secureConnect"));
          }
        });
        request.emit("socket", socket);
        socket.emit("connect");
      });
      return request;
    },
  };
  const fileSystem = {
    constants: fs.constants,
    realpathSync: (file: string) => file,
    existsSync: () => !freshRuntime,
    lstatSync: () => ({ isDirectory: () => true }),
    readFileSync: () => JSON.stringify({ name: "openclaw", version: "2026.8.1" }),
    writeFileSync: () => {},
    openSync: () => 1,
    closeSync: () => {},
    mkdirSync: () => {},
    mkdtempSync: () => "/fixture/stage",
    readdirSync: () => [],
    renameSync: (from: string, to: string) => {
      for (const [file, bytes] of files) {
        if (file === from || file.startsWith(from + "/")) {
          files.set(to + file.slice(from.length), bytes);
          files.delete(file);
        }
      }
    },
    rmSync: (file: string, options?: { recursive?: boolean }) => {
      removed.push({ file, bytes: files.get(file)?.length ?? 0 });
      files.delete(file);
      if (options?.recursive) {
        for (const entry of files.keys()) {
          if (entry.startsWith(file + "/")) {
            files.delete(entry);
          }
        }
      }
    },
    promises: {
      stat: async (file: string) => {
        const content = files.get(file);
        if (!content) {
          throw Object.assign(new Error("missing archive"), { code: "ENOENT" });
        }
        return { size: content.length };
      },
      open: async (file: string, flags: string | number) => {
        if (typeof flags === "number") {
          throw Object.assign(new Error("missing archive"), { code: "ENOENT" });
        }
        if (files.has(file) && flags === "wx") {
          throw Object.assign(new Error("archive already exists"), { code: "EEXIST" });
        }
        created.push(file);
        if (flags !== "a" || !files.has(file)) {
          files.set(file, Buffer.alloc(0));
        }
        return {
          writeFile: async (chunk: Buffer) => {
            files.set(file, Buffer.concat([files.get(file)!, chunk]));
          },
          close: async () => {},
        };
      },
    },
    createReadStream: (file: string) => Readable.from([files.get(file)!]),
  };
  const processFixture = {
    platform: "linux",
    env: { ...setup.forwardedEnv },
    execPath: "/fixture/node",
    umask: () => {},
    exitCode: 0,
  };
  const execution = runInNewContext(setup.command.split("\n").slice(2, -1).join("\n"), {
    Buffer,
    URL,
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
    AbortController,
    AbortSignal: {
      any: (signals: AbortSignal[]) => AbortSignal.any(signals),
      timeout: (ms: number) => {
        const controller = new AbortController();
        setTimeout(
          () =>
            controller.abort(
              Object.assign(new Error("request deadline exceeded"), { code: "ABORT_ERR" }),
            ),
          ms,
        );
        return controller.signal;
      },
    },
    process: processFixture,
    console: { error: (line: string) => output.push(line) },
    require: (name: string) => {
      if (name === "node:fs") {
        return fileSystem;
      }
      if (name === "node:path") {
        return path.posix;
      }
      if (name === "node:os") {
        return { homedir: () => "/fixture" };
      }
      if (name === "node:http" || name === "node:https") {
        return transport;
      }
      if (name === "node:timers/promises") {
        return {
          setTimeout: async (ms: number, _value: unknown, options?: { signal: AbortSignal }) => {
            delays.push(ms);
            await waitForDownload(ms, options?.signal);
          },
        };
      }
      if (name === "node:child_process") {
        return {
          spawnSync: () => ({ status: 0, stdout: "OpenClaw 2026.8.1" }),
          spawn: () => {
            installations.push(Date.now());
            const child = new EventEmitter();
            setTimeout(() => child.emit("close", install.exitCode), install.durationMs);
            return child;
          },
        };
      }
      return require(name);
    },
  });
  const completion = Promise.resolve(execution).finally(() => {
    elapsedMs = Date.now();
    vi.clearAllTimers();
  });
  await vi.runAllTimersAsync();
  await completion;
  return {
    code: processFixture.exitCode,
    requests,
    ranges,
    created,
    removed,
    delays,
    elapsedMs,
    completedAt,
    aborted,
    installations,
    output: output.join("\n"),
    published: [...files.values()],
  };
}

describe("bootstrap artifact download retries", () => {
  it("completes after five resets that each advance the partial file", async () => {
    const result = await download([
      ...Array.from({ length: 5 }, () => ({ durationMs: 0, resetAfterBytes: 1 })),
      "success",
    ]);
    expect(result.code, result.output).toBe(0);
    expect(result.requests).toEqual(Array(6).fill("Bearer synthetic-worker-archive-token"));
    expect(result.ranges).toEqual([
      undefined,
      "bytes=1-",
      "bytes=2-",
      "bytes=3-",
      "bytes=4-",
      "bytes=5-",
    ]);
    expect(result.published).toEqual([archive]);
  });

  it("resets the failure budget only when retained bytes advance", async () => {
    const reset = { durationMs: 0, resetAfterBytes: 1 };
    const result = await download([503, 503, reset, "busy", 503, 503, reset, "success"]);
    expect(result.code, result.output).toBe(0);
    expect(result.requests).toHaveLength(8);
    expect(result.ranges).toEqual([
      undefined,
      undefined,
      undefined,
      "bytes=1-",
      "bytes=1-",
      "bytes=1-",
      "bytes=1-",
      "bytes=2-",
    ]);
    expect(result.published).toEqual([archive]);
  });

  it.each([false, true])(
    "stops after three consecutive resets without retained progress (ignore Range: %s)",
    async (ignoreRange) => {
      const result = await download([
        { durationMs: 0, resetAfterBytes: 1 },
        { durationMs: 0, resetAfterBytes: ignoreRange ? 1 : 0, ignoreRange },
      ]);
      expect(result.code).toBe(1);
      expect(result.requests).toHaveLength(4);
      expect(result.ranges).toEqual([undefined, "bytes=1-", "bytes=1-", "bytes=1-"]);
      expect(result.published).toEqual([]);
      expect(result.output).toContain("download attempt 4; 3 consecutive no-progress failures");
    },
  );

  it.each([
    { runtimeMinutes: 8, workerMinutes: 9, bootstrapTimeoutMs: undefined },
    { runtimeMinutes: 48, workerMinutes: 46, bootstrapTimeoutMs: 60 * 60_000 },
  ])(
    "completes $runtimeMinutes/$workerMinutes-minute downloads before both grants expire",
    async ({ runtimeMinutes, workerMinutes, bootstrapTimeoutMs }) => {
      const result = await download(
        [
          { durationMs: runtimeMinutes * 60_000, progress: true },
          { durationMs: workerMinutes * 60_000, progress: true },
        ],
        true,
        { durationMs: 2 * 60_000, exitCode: 0 },
        bootstrapTimeoutMs,
      );
      expect(result.code, result.output).toBe(0);
      expect(result.elapsedMs).toBe(Math.max(runtimeMinutes + 2, workerMinutes) * 60_000);
      expect(result.completedAt).toEqual(
        [runtimeMinutes, workerMinutes]
          .toSorted((left, right) => left - right)
          .map((minutes) => minutes * 60_000),
      );
      expect(result.aborted).toEqual([]);
      expect(result.requests).toEqual([
        "Bearer synthetic-bootstrap-token",
        "Bearer synthetic-worker-archive-token",
      ]);
      expect(result.installations).toEqual([runtimeMinutes * 60_000]);
      expect(result.published).toEqual([archive]);
      expect(result.output).toContain("CRABBOX_PHASE:openclaw-bootstrap-complete");
    },
  );

  it.each(["headers", "body"] as const)(
    "retries a stalled %s attempt after two idle minutes, retaining received bytes",
    async (stall) => {
      const result = await download([{ durationMs: 5 * 60_000, stall }, "success"]);
      expect(result.code, result.output).toBe(0);
      expect(result.elapsedMs).toBe(2 * 60_000 + 250);
      expect(result.requests).toEqual(Array(2).fill("Bearer synthetic-worker-archive-token"));
      expect(result.ranges).toEqual([
        undefined,
        stall === "body" ? `bytes=${Math.floor(archive.length * 0.4)}-` : undefined,
      ]);
      expect(result.aborted).toEqual(["Bearer synthetic-worker-archive-token"]);
      expect(result.output).toContain("failed (ETIMEDOUT); retrying download attempt 2");
      expect(result.removed.filter(({ bytes }) => bytes > 0)).toEqual([]);
      expect(result.published).toEqual([archive]);
    },
  );

  it.each(["runtime", "worker", "runtime during peer backoff"] as const)(
    "aborts the peer download and preserves the first terminal %s failure and phase",
    async (failed) => {
      const failure = { durationMs: 1_000, failure: "synthetic archive failure" };
      const slow = failed === "runtime during peer backoff" ? "busy" : { durationMs: 8 * 60_000 };
      const result = await download(failed === "worker" ? [slow, failure] : [failure, slow], true);
      expect(result.code).toBe(1);
      expect(result.elapsedMs).toBe(1_000);
      expect(result.requests.length).toBeGreaterThanOrEqual(2);
      expect(result.aborted).toContain(
        failed === "worker"
          ? "Bearer synthetic-bootstrap-token"
          : "Bearer synthetic-worker-archive-token",
      );
      expect(result.output).toContain(
        `Cloud worker ${failed === "worker" ? "archive" : "node bootstrap"} download body failed: synthetic archive failure (download attempt 1)`,
      );
      expect(result.installations).toEqual([]);
      expect(result.published).toEqual([]);
    },
  );

  it("preserves the worker failure while an already-started npm installation settles", async () => {
    const result = await download(
      ["success", { durationMs: 1_000, failure: "synthetic worker failure" }],
      true,
      { durationMs: 2_000, exitCode: 17 },
    );
    expect(result.code).toBe(1);
    expect(result.installations).toEqual([0]);
    expect(result.elapsedMs).toBe(2_000);
    expect(result.output).toContain("archive download body failed: synthetic worker failure");
    expect(result.output).not.toContain("package installation failed");
    expect(result.published).toEqual([]);
  });

  it("cancels worker retry backoff when npm fails first", async () => {
    const result = await download(["success", "busy"], true, { durationMs: 1_000, exitCode: 17 });
    expect(result.code).toBe(1);
    expect(result.elapsedMs).toBe(1_000);
    expect(result.installations).toEqual([0]);
    expect(result.output).toContain("installation and worker download failed");
    expect(result.output).toContain("package installation failed (exit code 17)");
    expect(result.published).toEqual([]);
  });

  it("waits for delayed serve settlement without spending content-transfer attempts", async () => {
    let transfers = 0;
    const result = await download((elapsedMs) => {
      if (transfers === 1 && elapsedMs < 5_000) {
        return "busy";
      }
      return ++transfers < 3 ? "ECONNRESET" : "success";
    });
    expect(result.code).toBe(0);
    expect(transfers).toBe(3);
    expect(result.requests.length).toBeGreaterThan(5);
    expect(new Set(result.requests)).toEqual(new Set(["Bearer synthetic-worker-archive-token"]));
    expect(result.published).toEqual([archive]);
    expect(result.created).toHaveLength(3);
  });

  it.each(["ECONNRESET", 502, 503])(
    "recovers from %s with the same token and retained partial bytes",
    async (failure) => {
      const result = await download([failure, "success"]);
      expect(result.code).toBe(0);
      expect(result.requests).toEqual(Array(2).fill("Bearer synthetic-worker-archive-token"));
      expect(result.published).toEqual([archive]);
      expect(result.delays).toEqual([250]);
      if (typeof failure === "string") {
        expect(result.ranges).toEqual([undefined, `bytes=${Math.floor(archive.length * 0.4)}-`]);
        expect(result.removed.filter(({ bytes }) => bytes > 0)).toEqual([]);
      }
    },
  );
  it("restarts from the full response when the server ignores Range", async () => {
    const result = await download(["ECONNRESET", "ignore-range"]);
    expect(result.code, result.output).toBe(0);
    expect(result.ranges).toEqual([undefined, `bytes=${Math.floor(archive.length * 0.4)}-`]);
    expect(result.published).toEqual([archive]);
  });
  it.each(["range-mismatch", 416])(
    "discards range failure %s before retrying from byte zero",
    async (failure) => {
      const result = await download(["ECONNRESET", failure, "success"]);
      expect(result.code, result.output).toBe(0);
      expect(result.ranges).toEqual([
        undefined,
        `bytes=${Math.floor(archive.length * 0.4)}-`,
        undefined,
      ]);
      expect(result.published).toEqual([archive]);
    },
  );
  it("verifies all received bytes after a reset without requesting an empty range", async () => {
    const result = await download(["late-reset"]);
    expect(result.code, result.output).toBe(0);
    expect(result.ranges).toEqual([undefined]);
    expect(result.published).toEqual([archive]);
  });
  it("rejects corrupted resumed bytes before publishing the archive", async () => {
    const result = await download(["ECONNRESET", "digest"]);
    expect(result.code).toBe(1);
    expect(result.ranges).toEqual([undefined, `bytes=${Math.floor(archive.length * 0.4)}-`]);
    expect(result.published).toEqual([]);
    expect(result.output).toContain("failed integrity verification (download attempt 2)");
  });
  it.each(["short", "size", "pin", 401])("keeps %s terminal without retrying", async (failure) => {
    const result = await download([failure, "success"]);
    expect(result.code).toBe(1);
    expect(result.requests).toHaveLength(1);
    expect(result.delays).toEqual([]);
    expect(result.published).toEqual([]);
    expect(result.output).toContain("download attempt 1");
  });
  it.each([{ durationMs: 0, resetAfterBytes: 0 }, 503])(
    "reports %s and total attempts after exhaustion",
    async (failure) => {
      const result = await download([failure]);
      expect(result.code).toBe(1);
      expect(result.requests).toEqual(Array(3).fill("Bearer synthetic-worker-archive-token"));
      expect(result.delays).toEqual([250, 500]);
      expect(result.published).toEqual([]);
      expect(result.output).toContain(
        (failure === 503 ? "HTTP 503" : "transport interrupted") +
          " (download attempt 3; 3 consecutive no-progress failures)",
      );
    },
  );
});
