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
const workerToken = "Bearer synthetic-worker-archive-token";
const runtimeToken = "Bearer synthetic-bootstrap-token";
const resumedRange = `bytes=${Math.floor(archive.length * 0.4)}-`;
const transferError = (code = "ECONNRESET", message = "transport interrupted") =>
  Object.assign(new Error(message), { code });
function abortAfter(ms: number, error: Error) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(error), ms);
  return controller.signal;
}

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
  const terminations: Array<{ pid: number; signal: string; atMs: number }> = [];
  let elapsedMs = 0;
  const aborted: string[] = [];
  const completedAt: number[] = [];
  const grants = new Map<string, AbortSignal>(
    [nodeBootstrap, workerBundle].map((artifact): [string, AbortSignal] => [
      `Bearer ${artifact.token}`,
      abortAfter(
        bootstrapTimeoutMs ?? 10 * 60_000,
        transferError("ECONNRESET", "capability expired"),
      ),
    ]),
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
      const behavior = typeof outcome === "object" ? outcome : undefined;
      requests.push(options.headers.authorization);
      ranges.push(options.headers.range);
      const offset =
        options.headers.range && outcome !== "ignore-range" && !behavior?.ignoreRange
          ? Number(options.headers.range.slice(6, -1))
          : 0;
      const split = Math.min(
        offset + (behavior?.resetAfterBytes ?? Math.floor(content.length * 0.4)),
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
                if (behavior) {
                  if (behavior.progress) {
                    const startedAt = Date.now();
                    for (let index = offset; index < content.length; index++) {
                      const arrival = Math.round(
                        (behavior.durationMs * (index + 1 - offset)) / (content.length - offset),
                      );
                      await waitForDownload(startedAt + arrival - Date.now(), signal);
                      idleTimer?.refresh();
                      yield content.subarray(index, index + 1);
                    }
                    finished = true;
                    completedAt.push(Date.now());
                    return;
                  }
                  if (!behavior.stall) {
                    await waitForDownload(behavior.durationMs, signal);
                  }
                  if (behavior.failure) {
                    throw new Error(behavior.failure);
                  }
                }
                if (outcome === "busy") {
                  yield Buffer.from('{"error":"transfer_in_progress"}');
                  return;
                }
                signal.throwIfAborted();
                idleTimer?.refresh();
                yield content.subarray(offset, split);
                if (behavior?.resetAfterBytes !== undefined) {
                  throw transferError();
                }
                if (behavior?.stall === "body") {
                  await waitForDownload(behavior.durationMs, signal);
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
                  throw transferError(outcome);
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
                  throw transferError();
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
            if (behavior?.stall === "headers") {
              await waitForDownload(behavior.durationMs, signal);
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
  const processFixture = Object.assign(new EventEmitter(), {
    platform: "linux",
    env: { ...setup.forwardedEnv },
    execPath: "/fixture/node",
    umask: () => {},
    kill: (pid: number, signal: string) => {
      terminations.push({ pid, signal, atMs: Date.now() });
      return true;
    },
    exitCode: 0,
  });
  const script = setup.command
    .split("CRABBOX_NODE_ENROLLMENT_SCRIPT'\n")[1]!
    .split("\nCRABBOX_NODE_ENROLLMENT_SCRIPT")[0]!;
  const dependencies: Record<string, unknown> = {
    "node:fs": fileSystem,
    "node:path": path.posix,
    "node:os": { homedir: () => "/fixture" },
    "node:http": transport,
    "node:https": transport,
    "node:timers/promises": {
      setTimeout: async (ms: number, _value: unknown, options?: { signal: AbortSignal }) => {
        delays.push(ms);
        await waitForDownload(ms, options?.signal);
      },
    },
    "node:child_process": {
      spawnSync: () => ({ status: 0, stdout: "OpenClaw 2026.8.1" }),
      spawn: () => {
        installations.push(Date.now());
        const child = Object.assign(new EventEmitter(), { pid: 1234 });
        // Keep close delayed even after kill so the join must await actual settlement.
        setTimeout(
          () =>
            child.emit(
              "close",
              terminations.length ? null : install.exitCode,
              terminations.length ? "SIGKILL" : null,
            ),
          install.durationMs,
        );
        return child;
      },
    },
  };
  const execution = runInNewContext(script, {
    Buffer,
    URL,
    setTimeout,
    clearTimeout,
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
    AbortController,
    AbortSignal: {
      any: (signals: AbortSignal[]) => AbortSignal.any(signals),
      timeout: (ms: number) =>
        abortAfter(ms, transferError("ABORT_ERR", "request deadline exceeded")),
    },
    process: processFixture,
    console: { error: (line: string) => output.push(line) },
    require: (name: string) => dependencies[name] ?? require(name),
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
    terminations,
    output: output.join("\n"),
    published: [...files.values()],
  };
}

function expectDownload(
  result: Awaited<ReturnType<typeof download>>,
  code: 0 | 1,
  details: Partial<Awaited<ReturnType<typeof download>>> = {},
) {
  expect(result.code, result.output).toBe(code);
  expect(result.published).toEqual(code === 0 ? [archive] : []);
  expect(result).toMatchObject(details);
}

describe("bootstrap artifact download retries", () => {
  it.each([502, 503, 504, 520, 521, 522, 523, 524, 530])(
    "recovers after HTTP %s",
    async (statusCode) => {
      const result = await download([statusCode, "success"]);
      expectDownload(result, 0);
      expect(result.requests).toHaveLength(2);
    },
  );

  it("rides out a 30-second edge outage for both bootstrap artifacts", async () => {
    const result = await download((elapsedMs) => (elapsedMs < 30_000 ? 530 : "success"), true);
    expectDownload(result, 0, { elapsedMs: 31_750, installations: [31_750] });
  });

  it("resets the failure budget only when retained bytes advance", async () => {
    const reset = { durationMs: 0, resetAfterBytes: 1 };
    const result = await download([
      ...Array(8).fill(503),
      reset,
      "busy",
      ...Array(8).fill(503),
      reset,
      "success",
    ]);
    expectDownload(result, 0, {
      ranges: [...Array(9).fill(undefined), ...Array(10).fill("bytes=1-"), "bytes=2-"],
    });
    expect(result.requests).toHaveLength(20);
  });

  it.each(["resume", "ignore Range", "discard partial"])(
    "stops after nine consecutive failures without retained progress (%s)",
    async (mode) => {
      const ignoreRange = mode === "ignore Range";
      const result = await download([
        { durationMs: 0, resetAfterBytes: 1 },
        ...(mode === "discard partial" ? [416] : []),
        { durationMs: 0, resetAfterBytes: ignoreRange ? 1 : 0, ignoreRange },
      ]);
      expectDownload(result, 1);
      expect(result.requests).toHaveLength(10);
      expect(result.ranges).toEqual(
        mode === "discard partial"
          ? [undefined, "bytes=1-", ...Array(8).fill(undefined)]
          : [undefined, ...Array(9).fill("bytes=1-")],
      );
      expect(result.output).toContain("download attempt 10; 9 consecutive no-progress failures");
      expect(result.output).not.toContain("The worker could not reach");
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
      expectDownload(result, 0, {
        elapsedMs: Math.max(runtimeMinutes + 2, workerMinutes) * 60_000,
        completedAt: [runtimeMinutes, workerMinutes]
          .toSorted((left, right) => left - right)
          .map((minutes) => minutes * 60_000),
        aborted: [],
        requests: [runtimeToken, workerToken],
        installations: [runtimeMinutes * 60_000],
      });
      expect(result.output).toContain("CRABBOX_PHASE:openclaw-bootstrap-complete");
    },
  );

  it.each(["headers", "body"] as const)(
    "retries a stalled %s attempt after two idle minutes, retaining received bytes",
    async (stall) => {
      const result = await download([{ durationMs: 5 * 60_000, stall }, "success"]);
      expectDownload(result, 0, {
        elapsedMs: 2 * 60_000 + 250,
        requests: [workerToken, workerToken],
        ranges: [
          undefined,
          stall === "body" ? `bytes=${Math.floor(archive.length * 0.4)}-` : undefined,
        ],
        aborted: [workerToken],
      });
      expect(result.output).toContain(
        "failed (ETIMEDOUT) from https://gateway.example.test; retrying download attempt 2",
      );
      expect(result.removed.filter(({ bytes }) => bytes > 0)).toEqual([]);
    },
  );

  it.each(["runtime", "worker", "runtime during peer backoff"] as const)(
    "aborts the peer download and preserves the first terminal %s failure and phase",
    async (failed) => {
      const failure = { durationMs: 1_000, failure: "synthetic archive failure" };
      const slow = failed === "runtime during peer backoff" ? "busy" : { durationMs: 8 * 60_000 };
      const result = await download(failed === "worker" ? [slow, failure] : [failure, slow], true);
      expectDownload(result, 1, { elapsedMs: 1_000, installations: [] });
      expect(result.requests.length).toBeGreaterThanOrEqual(2);
      expect(result.aborted).toContain(failed === "worker" ? runtimeToken : workerToken);
      expect(result.output).toContain(
        `Cloud worker ${failed === "worker" ? "archive" : "node bootstrap"} download body failed from https://gateway.example.test: synthetic archive failure (download attempt 1)`,
      );
    },
  );

  it("preserves the worker failure while an already-started npm installation settles", async () => {
    const result = await download(
      ["success", { durationMs: 1_000, failure: "synthetic worker failure" }],
      true,
      { durationMs: 2_000, exitCode: 17 },
    );
    expectDownload(result, 1, {
      installations: [0],
      elapsedMs: 2_000,
      terminations: [{ pid: -1234, signal: "SIGKILL", atMs: 1_000 }],
    });
    expect(result.output).toContain(
      "archive download body failed from https://gateway.example.test: synthetic worker failure",
    );
    expect(result.output).not.toContain("package installation failed");
  });

  it("cancels worker retry backoff when npm fails first", async () => {
    const result = await download(["success", "busy"], true, { durationMs: 1_000, exitCode: 17 });
    expectDownload(result, 1, { elapsedMs: 1_000, installations: [0] });
    expect(result.output).toContain("installation and worker download failed");
    expect(result.output).toContain("package installation failed (exit code 17)");
  });

  it("waits for delayed serve settlement without spending content-transfer attempts", async () => {
    let transfers = 0;
    const result = await download((elapsedMs) => {
      if (transfers === 1 && elapsedMs < 5_000) {
        return "busy";
      }
      return ++transfers < 3 ? "ECONNRESET" : "success";
    });
    expectDownload(result, 0);
    expect(transfers).toBe(3);
    expect(result.requests.length).toBeGreaterThan(5);
    expect(new Set(result.requests)).toEqual(new Set([workerToken]));
    expect(result.created).toHaveLength(3);
  });

  it.each<[DownloadOutcome, 0 | 1, Array<string | undefined>]>([
    ["ignore-range", 0, [undefined, resumedRange]],
    ["range-mismatch", 0, [undefined, resumedRange, undefined]],
    [416, 0, [undefined, resumedRange, undefined]],
    ["digest", 1, [undefined, resumedRange]],
  ])("validates resumed response %s before publishing", async (outcome, code, ranges) => {
    const result = await download(["ECONNRESET", outcome, "success"]);
    expectDownload(result, code, { ranges });
    if (outcome === "digest") {
      expect(result.output).toContain("failed integrity verification (download attempt 2)");
    }
  });
  it("verifies all received bytes after a reset without requesting an empty range", async () => {
    const result = await download(["late-reset"]);
    expectDownload(result, 0, { ranges: [undefined] });
  });
  it.each(["short", "size", "pin", 401, 403, 404, 429, 500, 501, 505, 525, 526, 529, 531])(
    "keeps %s terminal without retrying",
    async (failure) => {
      const result = await download([failure, "success"]);
      expectDownload(result, 1, { delays: [] });
      expect(result.requests).toHaveLength(1);
      expect(result.output).toContain("download attempt 1");
    },
  );
  it.each([{ durationMs: 0, resetAfterBytes: 0 }, 503, 530])(
    "reports %s and total attempts after exhaustion",
    async (failure) => {
      const result = await download([failure]);
      expectDownload(result, 1, {
        requests: Array(9).fill(workerToken),
        delays: [250, 500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000],
        elapsedMs: 31_750,
      });
      expect(result.output).toContain(
        (typeof failure === "number" ? `HTTP ${failure}` : "transport interrupted") +
          " (download attempt 9; 9 consecutive no-progress failures)",
      );
      expect(result.output.includes("The worker could not reach")).toBe(
        typeof failure !== "number",
      );
    },
  );
});
