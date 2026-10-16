import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IMessagePrivateApiStatus } from "./private-api-status.js";

const spawnMock = vi.hoisted(() => vi.fn());
const effectGate = vi.hoisted(() => ({ prepare: undefined as (() => Promise<void>) | undefined }));
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>();
  return {
    ...actual,
    captureEffectAuthority: () => {
      const authority = actual.captureEffectAuthority();
      const prepare = effectGate.prepare;
      return prepare
        ? {
            ...authority,
            initiate: async <T>(effect: () => T | Promise<T>) => {
              await prepare();
              return authority.initiate(effect);
            },
          }
        : authority;
    },
  };
});
const runIMessageCliJsonCommandMock = vi.hoisted(() => vi.fn());
const logVerboseMock = vi.hoisted(() => vi.fn());
const contactsChangeDiagnostic =
  "Could not fetch group for change type 1 with identifier 9E2F71C2:ABGroup, making it a delete change type.";

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  logVerbose: logVerboseMock,
}));

vi.mock("./cli-output.js", () => ({
  runIMessageCliJsonCommand: runIMessageCliJsonCommandMock,
}));

// Raw EventEmitters expose unhandled stdio errors that would crash the Gateway.
type MockStream = EventEmitter & { errored: Error | null };
type MockChild = EventEmitter & {
  stdout: MockStream;
  stderr: MockStream;
  stdin: MockStream & {
    write: (line: string, cb?: (err?: Error | null) => void) => boolean;
    end: () => void;
  };
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
};

function createMockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdout = Object.assign(new EventEmitter(), { errored: null });
  child.stderr = Object.assign(new EventEmitter(), { errored: null });
  const stdin = Object.assign(new EventEmitter(), { errored: null }) as MockChild["stdin"];
  stdin.write = (_line, cb) => {
    cb?.(null);
    return true;
  };
  stdin.end = () => {};
  child.stdin = stdin;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

function emitRpcError(child: MockChild, error: { code: number; message: string; data?: unknown }) {
  child.stdout.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, error })}\n`));
}

let IMessageRpcClient: typeof import("./client.js").IMessageRpcClient;
let IMessageRpcRequestError: typeof import("./client.js").IMessageRpcRequestError;
let privateApiStatus: typeof import("./private-api-status.js");
const fullDiskAccessError =
  "imsg cannot access ~/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.";
function runtime(error: ReturnType<typeof vi.fn>) {
  return { error, exit: vi.fn(), log: vi.fn() };
}
async function startClient(options: ConstructorParameters<typeof IMessageRpcClient>[0] = {}) {
  const client = new IMessageRpcClient(options);
  await client.start();
  return client;
}
function enableSpawn() {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("VITEST", "");
}
async function useRealSpawn() {
  const { spawn } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  spawnMock.mockImplementationOnce((command, args, options) => spawn(command, args, options));
}
function rpcWrapper(prelude: string[], handle: string[], result: string) {
  return [
    "#!/usr/bin/env node",
    ...prelude,
    'let buffered = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => {',
    "  buffered += chunk;",
    '  let newline = buffered.indexOf("\\n");',
    "  while (newline !== -1) {",
    "    const line = buffered.slice(0, newline);",
    "    buffered = buffered.slice(newline + 1);",
    "    const request = JSON.parse(line);",
    ...handle,
    `    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: ${result} }) + "\\n");`,
    '    newline = buffered.indexOf("\\n");',
    "  }",
    "});",
  ].join("\n");
}

beforeAll(async () => {
  vi.resetModules();
  ({ IMessageRpcClient, IMessageRpcRequestError } = await import("./client.js"));
  // Imported after resetModules so this is the same module instance the client
  // mutates; a separate copy would hold a different cache map.
  privateApiStatus = await import("./private-api-status.js");
});

afterAll(() => {
  vi.doUnmock("node:child_process");
  vi.doUnmock("./cli-output.js");
  vi.resetModules();
});

beforeEach(() => {
  enableSpawn();
  runIMessageCliJsonCommandMock.mockReset().mockResolvedValue({ status: "launched" });
  logVerboseMock.mockReset();
});
afterEach(() => {
  effectGate.prepare = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("IMessageRpcClient LF framing", () => {
  let child: ReturnType<typeof createMockChild> & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
  };
  let client: InstanceType<typeof IMessageRpcClient>;
  const runtimeError = vi.fn();
  const onNotification = vi.fn();

  beforeEach(async () => {
    child = Object.assign(createMockChild(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    spawnMock.mockReset().mockReturnValue(child);
    runtimeError.mockReset();
    onNotification.mockReset();
    client = await startClient({ runtime: runtime(runtimeError), onNotification });
  });

  afterEach(async () => {
    child.emit("close", 0, null);
    await client.stop();
  });

  it("delivers multiple LF responses and notifications in order, trimming CRLF and blanks", async () => {
    const responses: unknown[] = [];
    const first = client.request("first").then((value) => responses.push(value));
    const second = client.request("second").then((value) => responses.push(value));
    child.stdout.setEncoding("utf8");
    child.stdout.write(
      ' \r\n{"id":2,"result":"second"}\r\n{"method":"first"}\n{"id":1,"result":"first"}\n{"method":"second"}\r',
    );
    expect(onNotification.mock.calls).toEqual([[{ method: "first", params: undefined }]]);

    child.stdout.write("\n");

    expect(onNotification.mock.calls).toEqual([
      [{ method: "first", params: undefined }],
      [{ method: "second", params: undefined }],
    ]);
    await Promise.all([first, second]);
    expect(responses).toEqual(["second", "first"]);
    expect(runtimeError).not.toHaveBeenCalled();
  });

  it("reports malformed notifications without logging inbound content and keeps reading", () => {
    child.stdout.write('private-inbound-message\n{"method":"next","params":{"text":"kept"}}\n');

    expect(onNotification).toHaveBeenCalledExactlyOnceWith({
      method: "next",
      params: { text: "kept" },
    });
    expect(runtimeError).toHaveBeenCalledExactlyOnceWith("imsg rpc: failed to parse JSON response");
  });

  it("keeps interleaved stdout/stderr decoder state independent and bypasses decoding strings", async () => {
    const pending = client.request("ping");
    const stdout = Buffer.from('{"id":1,"result":"\u20ac"}\n');
    const stderr = Buffer.from("notice \u732b\r\n");
    const stdoutSplit = stdout.indexOf(Buffer.from("\u20ac")) + 1;
    const stderrSplit = stderr.indexOf(Buffer.from("\u732b")) + 1;

    child.stdout.write(stdout.subarray(0, stdoutSplit));
    child.stderr.write(stderr.subarray(0, stderrSplit));
    // A string data event must not consume a buffered partial UTF-8 sequence.
    child.stdout.emit("data", "prefix ");
    child.stderr.emit("data", "prefix ");
    child.stderr.write(stderr.subarray(stderrSplit));
    child.stdout.write(stdout.subarray(stdoutSplit));

    await expect(pending).resolves.toBe("prefix \u20ac");
    expect(runtimeError.mock.calls).toEqual([["imsg rpc: stderr diagnostic received"]]);
  });

  it("resolves an unterminated stdout response before rejecting remaining requests on child close", async () => {
    const response = client.request("first");
    const remaining = expect(client.request("second")).rejects.toThrow("imsg rpc exited (code 1)");
    child.stdout.write('{"id":1,"result":"final"}');
    child.stdout.emit("close");
    child.emit("close", 1, null);

    await expect(response).resolves.toBe("final");
    await remaining;
    await expect(client.waitForClose()).rejects.toThrow("imsg rpc exited (code 1)");
  });

  it("flushes stdout then stderr only on child close, before choosing the terminal diagnostic", async () => {
    const order: string[] = [];
    onNotification.mockImplementation(() => order.push("stdout"));
    runtimeError.mockImplementation(() => order.push("stderr"));
    const pending = expect(client.request("ping")).rejects.toThrow(fullDiskAccessError);
    child.stdout.write('{"method":"final"}');
    child.stderr.write("notice Full Disk Access denied for chat.db");

    child.stdout.emit("close");
    child.stderr.emit("close");
    expect(order).toEqual([]);
    child.emit("close", 1, null);

    expect(order).toEqual(["stdout", "stderr"]);
    expect(runtimeError).toHaveBeenCalledExactlyOnceWith(fullDiskAccessError);
    await pending;
  });

  it("ignores both streams from a stale child after stop", async () => {
    child.stdin.once("finish", () => child.emit("close", 0, null));
    await client.stop();

    child.stdout.write('{"method":"messages.changed","params":{}}\n');
    child.stderr.write("late diagnostic\n");

    expect(onNotification).not.toHaveBeenCalled();
    expect(runtimeError).not.toHaveBeenCalled();
  });
});

describe("IMessageRpcClient child stream error handling", () => {
  let child: MockChild;
  const tempDirs: string[] = [];

  beforeEach(() => {
    child = createMockChild();
    spawnMock.mockReset().mockReturnValue(child);
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })),
    );
  });

  it.each(["closed", "revoked"] as const)(
    "refuses a %s RPC request after authority preparation without writing stdin",
    async (outcome) => {
      const preparing = Promise.withResolvers<void>();
      const prepared = Promise.withResolvers<void>();
      const refusal = new Error("scheduled request retired");
      let current = true;
      effectGate.prepare = async () => {
        preparing.resolve();
        await prepared.promise;
      };
      const written = Promise.withResolvers<void>();
      const write = vi.fn(() => {
        written.resolve();
        return true;
      });
      child.stdin.write = write;
      const client = await startClient({ cliPath: "imsg" });
      const response = client
        .request(
          "send",
          { text: "hello" },
          {
            assertCurrent: () => {
              if (!current) {
                throw refusal;
              }
            },
          },
        )
        .catch((error: unknown) => error);
      try {
        await Promise.race([
          preparing.promise,
          written.promise.then(() => {
            throw new Error("RPC handoff bypassed authority preparation");
          }),
        ]);
        expect(write).not.toHaveBeenCalled();
        if (outcome === "closed") {
          child.emit("close", 0, null);
        } else {
          current = false;
        }
        prepared.resolve();
        if (outcome === "revoked") {
          expect(await response).toBe(refusal);
        } else {
          expect(await response).toMatchObject({
            message: "imsg rpc process changed before request initiation",
          });
        }
        expect(write).not.toHaveBeenCalled();
      } finally {
        prepared.resolve();
        child.emit("close", 0, null);
        await client.stop();
      }
    },
  );

  it("rejects in-flight requests when an errored stdout closes without an error event", async () => {
    const client = await startClient({ cliPath: "imsg" });

    const pending = client.request("ping", {}, { timeoutMs: 0 });
    // Observe rejection before triggering a stream event.
    pending.catch(() => {});

    const streamError = new Error("stdout broke");
    child.stdout.errored = streamError;
    try {
      expect(() => child.stdout.emit("close")).not.toThrow();
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
      await expect(pending).rejects.toThrow("stdout broke");
      await expect(client.waitForClose()).rejects.toThrow("stdout broke");
    } finally {
      child.emit("close", null, "SIGTERM");
      await client.stop();
    }
  });

  it("propagates a synchronous stdin write failure as a terminal transport error", async () => {
    vi.useFakeTimers();
    const writeError = new Error("write after end");
    child.stdin.write = () => {
      throw writeError;
    };
    const client = await startClient({ cliPath: "imsg" });

    await expect(client.request("ping", {}, { timeoutMs: 10 })).rejects.toBe(writeError);
    expect(vi.getTimerCount()).toBe(0);
    await expect(client.waitForClose()).rejects.toBe(writeError);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("close", null, "SIGTERM");
    await client.stop();
  });

  it("finishes graceful shutdown without scheduling escalation after synchronous close", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const client = await startClient({ cliPath: "imsg" });
    const endMock = vi.fn(() => child.emit("close", 0, null));
    child.stdin.end = endMock;

    await client.stop();

    expect(endMock).toHaveBeenCalledOnce();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("escalates EOF to SIGTERM and SIGKILL, then waits for close", async () => {
    vi.useFakeTimers();
    const client = await startClient({ cliPath: "imsg" });
    child.stdin.end = vi.fn();
    child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
      if (signal === "SIGKILL") {
        queueMicrotask(() => child.emit("close", null, "SIGKILL"));
      }
      return true;
    });

    const stopping = client.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(500);
    await stopping;

    expect(child.kill.mock.calls.map((call) => call[0])).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("settles the client after a real child stdout stream failure", async () => {
    const childProcess =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const realChild = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    spawnMock.mockReturnValueOnce(realChild);
    const client = await startClient({ cliPath: "imsg" });

    try {
      const pending = client.request("ping", {}, { timeoutMs: 0 });
      pending.catch(() => {});
      realChild.stdout.destroy(new Error("real stdout failure"));

      await expect(pending).rejects.toThrow("real stdout failure");
      await expect(client.waitForClose()).rejects.toThrow("real stdout failure");
      expect(realChild.killed).toBe(true);
    } finally {
      if (!realChild.killed) {
        realChild.kill("SIGTERM");
      }
      await client.stop();
    }
  });

  it("classifies real child stderr for the documented reconciliation line and a framework error", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-imessage-rpc-stderr-"));
    tempDirs.push(root);
    const wrapperPath = path.join(root, "imsg");
    const documented = `2026-08-04 00:32:38.518 imsg[88305:38969629] ${contactsChangeDiagnostic}`;
    const frameworkError = "CoreData: error: Failed to load persistent store";
    await fs.writeFile(
      wrapperPath,
      rpcWrapper(
        [
          `process.stderr.write(${JSON.stringify(documented)} + "\\n");`,
          `process.stderr.write(${JSON.stringify(frameworkError)} + "\\n");`,
        ],
        [],
        "{ ok: true }",
      ),
      { mode: 0o700 },
    );
    await useRealSpawn();
    const runtimeError = vi.fn();
    const client = await startClient({ cliPath: wrapperPath, runtime: runtime(runtimeError) });
    await expect(client.request("ping", {}, { timeoutMs: 5_000 })).resolves.toEqual({ ok: true });
    await client.stop();

    expect(logVerboseMock).not.toHaveBeenCalled();
    expect(runtimeError).toHaveBeenCalledExactlyOnceWith("imsg rpc: stderr diagnostic received");
  });

  it("expands cliPath locally while preserving remote dbPath and JSON data", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-imessage-rpc-boundary-"));
    tempDirs.push(root);
    const wrapperDir = path.join(root, ".openclaw");
    const wrapperPath = path.join(wrapperDir, "imsg remote");
    const reportPath = path.join(root, "rpc-report.jsonl");
    await fs.mkdir(wrapperDir, { recursive: true });
    await fs.writeFile(
      wrapperPath,
      rpcWrapper(
        ['const fs = require("node:fs");', `const reportPath = ${JSON.stringify(reportPath)};`],
        [
          '    fs.appendFileSync(reportPath, JSON.stringify({ args: process.argv.slice(2), request }) + "\\n");',
        ],
        "request.params",
      ),
      { mode: 0o700 },
    );
    vi.stubEnv("HOME", root);
    await useRealSpawn();
    const client = await startClient({
      cliPath: "~/.openclaw/imsg remote",
      dbPath: "~/Library/Messages/chat.db",
      remoteHost: "messages-mac",
    });
    const params = {
      text: `spaces ; $(touch ${path.join(root, "should-not-exist")}) ' " & |`,
      to: "person name@example.test",
    };

    await expect(client.request("send", params)).resolves.toEqual(params);
    await client.stop();

    const records = (await fs.readFile(reportPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; request: Record<string, unknown> });
    expect(records).toHaveLength(1);
    expect(records[0]?.args).toEqual(["rpc", "--json", "--db", "~/Library/Messages/chat.db"]);
    expect(records[0]?.request).toMatchObject({ method: "send", params });
    await expect(fs.access(path.join(root, "should-not-exist"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps local dbPath home expansion", async () => {
    vi.stubEnv("HOME", "/Users/gateway");
    const client = await startClient({
      cliPath: "~/.openclaw/imsg-local",
      dbPath: "~/Library/Messages/chat.db",
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "/Users/gateway/.openclaw/imsg-local",
      ["rpc", "--json", "--db", "/Users/gateway/Library/Messages/chat.db"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child.emit("close", 0, null);
    await client.stop();
  });
});

describe("IMessageRpcClient bridge-stall cache invalidation", () => {
  let child: MockChild;

  const seeded: IMessagePrivateApiStatus = {
    available: true,
    v2Ready: true,
    selectors: {},
    rpcMethods: [],
  };

  beforeEach(() => {
    child = createMockChild();
    spawnMock.mockReset().mockReturnValue(child);
  });

  it("logs recovery failure while preserving the original structured error", async () => {
    const recoveryError = new Error("launch stderr stream failed");
    const runtimeError = vi.fn();
    runIMessageCliJsonCommandMock.mockRejectedValueOnce(recoveryError);
    const client = await startClient({
      cliPath: "/tmp/imsg-stall-recovery-failure",
      runtime: runtime(runtimeError),
    });
    const pending = client.request("send", {}, { timeoutMs: 0 });
    pending.catch(() => {});
    emitRpcError(child, {
      code: -32603,
      message: "Timed out waiting for response to 'send-message'",
      data: { disposition: "may_have_completed", retry_safe: false },
    });

    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(IMessageRpcRequestError);
    expect(error).toMatchObject({
      code: -32603,
      data: { disposition: "may_have_completed", retry_safe: false },
      message: expect.stringContaining("Timed out waiting for response to 'send-message'"),
    });
    expect(runtimeError).toHaveBeenCalledWith(
      "imessage: automatic bridge recovery failed. The imsg private API bridge stopped responding. Run `imsg launch` to re-inject the dylib, then `openclaw channels status --probe` to refresh capability detection.",
    );

    child.emit("close", 0, null);
    await client.stop();
  });

  // The cache uses the configured path, while spawning expands it. Recovery
  // must evict that same key and preserve send reconciliation's structured data.
  it.each([{ name: "structured errors", data: { disposition: "not_started", retry_safe: true } }])(
    "invalidates the configured bridge cache and preserves $name",
    async ({ data }) => {
      const cliPath = "~/imsg-stall-tilde/imsg";
      privateApiStatus.setCachedIMessagePrivateApiStatus(cliPath, { ...seeded });
      expect(privateApiStatus.getCachedIMessagePrivateApiStatus(cliPath)?.available).toBe(true);

      const client = await startClient({ cliPath });
      const pending = client.request("send", {}, { timeoutMs: 0 });
      pending.catch(() => {});
      emitRpcError(child, {
        code: -32603,
        message: "Timed out waiting for response to 'send-message'",
        data,
      });

      const error = (await pending.catch((cause: unknown) => cause)) as Error;
      expect(privateApiStatus.getCachedIMessagePrivateApiStatus(cliPath)).toBeUndefined();
      expect(runIMessageCliJsonCommandMock).toHaveBeenCalledWith({
        cliPath,
        args: ["launch"],
        timeoutMs: 30_000,
      });
      expect(error.message).toContain("Timed out waiting for response to 'send-message'");
      expect(error.message).toContain("imsg launch");
      expect(error.message).toContain("channels status --probe");
      expect(error).toBeInstanceOf(IMessageRpcRequestError);
      expect(error).toMatchObject({
        code: -32603,
        data,
      });

      child.emit("close", 0, null);
      await client.stop();
    },
  );

  // send.ts matches this timeout wording; a wrapper deadline is not a bridge stall.
  it("leaves a client-side timeout undecorated without disturbing another pending request", async () => {
    vi.useFakeTimers();
    const client = await startClient({ cliPath: "/tmp/imsg-stall-clienttimeout" });
    const pending = client.request("send", {}, { timeoutMs: 10 });
    pending.catch(() => {});
    const untimed = client.request("ping", {}, { timeoutMs: -1 });
    untimed.catch(() => {});
    await vi.advanceTimersByTimeAsync(20);

    const error = (await pending.catch((cause: unknown) => cause)) as Error;
    expect(error.message).toBe("imsg rpc timeout (send)");
    expect(error.message).not.toContain("imsg launch");
    child.stdout.emit("data", '{"id":1,"result":"late"}\n{"id":2,"result":"alive"}\n');
    await expect(untimed).resolves.toBe("alive");
    expect(vi.getTimerCount()).toBe(0);

    child.emit("close", 0, null);
    await client.stop();
  });
});
