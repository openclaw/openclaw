import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable } from "node:stream";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { createCrabboxNodeRuntimeSetup } from "./crabbox-worker-node-enrollment.js";
import {
  createNodeBootstrapFixture,
  createWorkerArchiveFixture,
} from "./crabbox-worker-node-enrollment.test-support.js";

const require = createRequire(import.meta.url);
const archive = Buffer.from("verified worker archive");

async function download(outcomes: Array<string | number>) {
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const workerBundle = {
    ...createWorkerArchiveFixture(),
    sha256,
    bytes: archive.length,
    packageRelativePath: `worker-artifacts/${sha256}.tgz`,
    ...(outcomes[0] === "pin" ? { tlsFingerprint: "a".repeat(64) } : {}),
  };
  const setup = createCrabboxNodeRuntimeSetup({
    leaseId: "cbx_download_fixture",
    nodeBootstrap: createNodeBootstrapFixture(),
    workerBundle,
  });
  const requests: string[] = [];
  const created: string[] = [];
  const files = new Map<string, Buffer>();
  const removed: Array<{ file: string; bytes: number }> = [];
  const delays: number[] = [];
  const output: string[] = [];
  const transport = {
    request: (_url: URL, options: { headers: { authorization: string } }) => {
      const outcome = outcomes[Math.min(requests.length, outcomes.length - 1)];
      requests.push(options.headers.authorization);
      const request = Object.assign(new EventEmitter(), {
        setTimeout: () => {},
        destroy: (error: Error) => request.emit("error", error),
        end: () => {
          const response = Object.assign(
            Readable.from(
              (async function* () {
                yield archive.subarray(0, 4);
                if (outcome === "short") {
                  return;
                }
                if (
                  typeof outcome === "string" &&
                  !["success", "digest", "size"].includes(outcome)
                ) {
                  throw Object.assign(new Error("transport interrupted"), { code: outcome });
                }
                yield outcome === "digest" ? Buffer.alloc(archive.length - 4) : archive.subarray(4);
                if (outcome === "size") {
                  yield Buffer.from("excess");
                }
              })(),
            ),
            { statusCode: typeof outcome === "number" ? outcome : 200, headers: {} },
          );
          request.emit("response", response);
        },
      });
      queueMicrotask(() => {
        const socket = Object.assign(new EventEmitter(), {
          getPeerCertificate: () => ({ fingerprint256: "b".repeat(64) }),
        });
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
    existsSync: () => true,
    lstatSync: () => ({ isDirectory: () => true }),
    readFileSync: () => JSON.stringify({ name: "openclaw", version: "2026.8.1" }),
    mkdirSync: () => {},
    mkdtempSync: () => "/fixture/stage",
    readdirSync: () => [],
    renameSync: (from: string, to: string) => {
      files.set(to, files.get(from)!);
      files.delete(from);
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
      open: async (file: string, flags: string | number) => {
        if (typeof flags === "number") {
          throw Object.assign(new Error("missing archive"), { code: "ENOENT" });
        }
        if (files.has(file)) {
          throw new Error("Attempt reused its partial archive");
        }
        created.push(file);
        files.set(file, Buffer.alloc(0));
        return {
          writeFile: async (chunk: Buffer) => {
            files.set(file, Buffer.concat([files.get(file)!, chunk]));
          },
          close: async () => {},
        };
      },
    },
  };
  const processFixture = {
    platform: "linux",
    env: { ...setup.forwardedEnv },
    execPath: "/fixture/node",
    umask: () => {},
    exitCode: 0,
  };
  await runInNewContext(setup.command.split("\n").slice(2, -1).join("\n"), {
    Buffer,
    URL,
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
    AbortSignal: { timeout: () => new AbortController().signal },
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
          setTimeout: async (ms: number) => {
            delays.push(ms);
          },
        };
      }
      if (name === "node:child_process") {
        return { spawnSync: () => ({ status: 0, stdout: "OpenClaw 2026.8.1" }) };
      }
      return require(name);
    },
  });
  return {
    code: processFixture.exitCode,
    requests,
    created,
    removed,
    delays,
    output: output.join("\n"),
    published: [...files.values()],
  };
}

describe("bootstrap artifact download retries", () => {
  it.each([
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "ENETDOWN",
    "EPIPE",
    "ERR_STREAM_PREMATURE_CLOSE",
    "ABORT_ERR",
    "ETIMEDOUT",
    "ESOCKETTIMEDOUT",
    "EAI_AGAIN",
    502,
    503,
    504,
  ])("recovers from %s with the same token and a fresh partial file", async (failure) => {
    const result = await download([failure, "success"]);
    expect(result.code).toBe(0);
    expect(result.requests).toEqual(Array(2).fill("Bearer synthetic-worker-archive-token"));
    expect(result.published).toEqual([archive]);
    expect(result.delays).toEqual([250]);
    if (typeof failure === "string") {
      expect(new Set(result.created).size).toBe(2);
      expect(result.removed).toContainEqual({ file: result.created[0], bytes: 4 });
    }
  });
  it.each(["digest", "short", "size", "pin", 401, 403, 404, 409, 410])(
    "keeps %s terminal without retrying",
    async (failure) => {
      const result = await download([failure, "success"]);
      expect(result.code).toBe(1);
      expect(result.requests).toHaveLength(1);
      expect(result.delays).toEqual([]);
      expect(result.published).toEqual([]);
      expect(result.output).toContain("download attempt 1/3");
    },
  );
  it("reports the transport failure and total attempts after exhaustion", async () => {
    const result = await download(["ECONNRESET"]);
    expect(result.code).toBe(1);
    expect(result.requests).toEqual(Array(3).fill("Bearer synthetic-worker-archive-token"));
    expect(result.delays).toEqual([250, 500]);
    expect(result.published).toEqual([]);
    expect(result.output).toContain("transport interrupted (download attempt 3/3)");
  });
});
