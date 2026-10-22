import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IMessagePrivateApiStatus } from "./private-api-status.js";

const spawnMock = vi.hoisted(() => vi.fn());
const effectGate = vi.hoisted(() => ({ prepare: undefined as (() => Promise<void>) | undefined }));
// mock-isolation: gate effect preparation through the export-preserving test helper.
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>();
  const { withEffectPreparation } = await import("./test-support/authority.js");
  return withEffectPreparation(actual, effectGate);
});
const runIMessageCliJsonCommandMock = vi.hoisted(() => vi.fn());
const logVerboseMock = vi.hoisted(() => vi.fn());
const contactsChangeDiagnostic =
  "Could not fetch group for change type 1 with identifier 9E2F71C2:ABGroup, making it a delete change type.";

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  logVerbose: logVerboseMock,
}));

// mock-isolation: keep transport effects in test-owned doubles.
vi.mock("./cli-output.js", () => ({ runIMessageCliJsonCommand: runIMessageCliJsonCommandMock }));

// Raw emitters retain the unhandled-error behavior that real streams can hide.
class MockStream extends EventEmitter {
  errored: Error | null = null;
}
class MockChild extends EventEmitter {
  stdout = new MockStream();
  stderr = new MockStream();
  stdin = Object.assign(new MockStream(), {
    write: (_line: string, cb?: (err?: Error | null) => void) => {
      cb?.(null);
      return true;
    },
    end: () => {},
  });
  killed = false;
  kill: ReturnType<typeof vi.fn> = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

function emitRpcError(child: MockChild, error: { code: number; message: string; data?: unknown }) {
  child.stdout.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, error })}\n`));
}

let IMessageRpcClient: typeof import("./client.js").IMessageRpcClient;
let IMessageRpcRequestError: typeof import("./client.js").IMessageRpcRequestError;
let privateApiStatus: typeof import("./private-api-status.js");
const fullDiskAccessError =
  "imsg cannot access ~/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.";
function runtime(error: (...args: unknown[]) => void) {
  return { error, exit: vi.fn(), log: vi.fn() };
}
let child: MockChild;
const clients: { client: InstanceType<typeof IMessageRpcClient>; child: MockChild | null }[] = [];
async function startClient(
  options: ConstructorParameters<typeof IMessageRpcClient>[0] = {},
  ownedChild: MockChild | null = child,
) {
  const client = new IMessageRpcClient(options);
  await client.start();
  clients.push({ client, child: ownedChild });
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
    'require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {',
    "    const request = JSON.parse(line);",
    ...handle,
    `    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: ${result} }) + "\\n");`,
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
  child = new MockChild();
  spawnMock.mockReset().mockReturnValue(child);
  enableSpawn();
  runIMessageCliJsonCommandMock.mockReset().mockResolvedValue({ status: "launched" });
  logVerboseMock.mockReset();
});
afterEach(async () => {
  for (const owned of clients.splice(0)) {
    owned.child?.emit("close", 0, null);
    await owned.client.stop();
  }
  effectGate.prepare = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("IMessageRpcClient LF framing", () => {
  let framedChild: MockChild & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
  };
  let client: InstanceType<typeof IMessageRpcClient>;
  const runtimeError = vi.fn();
  const onNotification = vi.fn();

  beforeEach(async () => {
    framedChild = Object.assign(new MockChild(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    spawnMock.mockReset().mockReturnValue(framedChild);
    runtimeError.mockReset();
    onNotification.mockReset();
    client = await startClient({ runtime: runtime(runtimeError), onNotification }, framedChild);
  });

  it("delivers multiple LF responses and notifications in order, trimming CRLF and blanks", async () => {
    const responses: unknown[] = [];
    const first = client.request("first").then((value) => responses.push(value));
    const second = client.request("second").then((value) => responses.push(value));
    framedChild.stdout.setEncoding("utf8");
    framedChild.stdout.write(
      ' \r\n{"id":2,"result":"second"}\r\n{"method":"first"}\n{"id":1,"result":"first"}\n{"method":"second"}\r',
    );
    expect(onNotification.mock.calls).toEqual([[{ method: "first", params: undefined }]]);

    framedChild.stdout.write("\n");

    expect(onNotification.mock.calls).toEqual([
      [{ method: "first", params: undefined }],
      [{ method: "second", params: undefined }],
    ]);
    await Promise.all([first, second]);
    expect(responses).toEqual(["second", "first"]);
    expect(runtimeError).not.toHaveBeenCalled();
  });

  it("reports malformed notifications without logging inbound content and keeps reading", () => {
    framedChild.stdout.write(
      'private-inbound-message\n{"method":"next","params":{"text":"kept"}}\n',
    );

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

    framedChild.stdout.write(stdout.subarray(0, stdoutSplit));
    framedChild.stderr.write(stderr.subarray(0, stderrSplit));
    // A string data event must not consume a buffered partial UTF-8 sequence.
    framedChild.stdout.emit("data", "prefix ");
    framedChild.stderr.emit("data", "prefix ");
    framedChild.stderr.write(stderr.subarray(stderrSplit));
    framedChild.stdout.write(stdout.subarray(stdoutSplit));

    await expect(pending).resolves.toBe("prefix \u20ac");
    expect(runtimeError.mock.calls).toEqual([["imsg rpc: stderr diagnostic received"]]);
  });

  it("resolves an unterminated stdout response before rejecting remaining requests on child close", async () => {
    const response = client.request("first");
    const remaining = expect(client.request("second")).rejects.toThrow("imsg rpc exited (code 1)");
    framedChild.stdout.write('{"id":1,"result":"final"}');
    framedChild.stdout.emit("close");
    framedChild.emit("close", 1, null);

    await expect(response).resolves.toBe("final");
    await remaining;
    await expect(client.waitForClose()).rejects.toThrow("imsg rpc exited (code 1)");
  });

  it("flushes stdout then stderr only on child close, before choosing the terminal diagnostic", async () => {
    const order: string[] = [];
    onNotification.mockImplementation(() => order.push("stdout"));
    runtimeError.mockImplementation(() => order.push("stderr"));
    const pending = expect(client.request("ping")).rejects.toThrow(fullDiskAccessError);
    framedChild.stdout.write('{"method":"final"}');
    framedChild.stderr.write("notice Full Disk Access denied for chat.db");

    framedChild.stdout.emit("close");
    framedChild.stderr.emit("close");
    expect(order).toEqual([]);
    framedChild.emit("close", 1, null);

    expect(order).toEqual(["stdout", "stderr"]);
    expect(runtimeError).toHaveBeenCalledExactlyOnceWith(fullDiskAccessError);
    await pending;
  });

  it("ignores both streams from a stale child after stop", async () => {
    framedChild.stdin.once("finish", () => framedChild.emit("close", 0, null));
    await client.stop();

    framedChild.stdout.write('{"method":"messages.changed","params":{}}\n');
    framedChild.stderr.write("late diagnostic\n");

    expect(onNotification).not.toHaveBeenCalled();
    expect(runtimeError).not.toHaveBeenCalled();
  });
});

describe("IMessageRpcClient child stream error handling", () => {
  const tempDirs: string[] = [];

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
      const write = vi.fn((): true => {
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
    expect(() => child.stdout.emit("close")).not.toThrow();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    await expect(pending).rejects.toThrow("stdout broke");
    await expect(client.waitForClose()).rejects.toThrow("stdout broke");
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
    const client = await startClient({ cliPath: "imsg" }, null);

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
    const client = await startClient(
      { cliPath: wrapperPath, runtime: runtime(runtimeError) },
      null,
    );
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
    const client = await startClient(
      {
        cliPath: "~/.openclaw/imsg remote",
        dbPath: "~/Library/Messages/chat.db",
        remoteHost: "messages-mac",
      },
      null,
    );
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
    await startClient({
      cliPath: "~/.openclaw/imsg-local",
      dbPath: "~/Library/Messages/chat.db",
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "/Users/gateway/.openclaw/imsg-local",
      ["rpc", "--json", "--db", "/Users/gateway/Library/Messages/chat.db"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
  });
});

describe("IMessageRpcClient bridge-stall cache invalidation", () => {
  const seeded: IMessagePrivateApiStatus = {
    available: true,
    v2Ready: true,
    selectors: {},
    rpcMethods: [],
  };

  it.each([
    {
      name: "logs recovery failure while preserving the original structured error",
      cliPath: "/tmp/imsg-stall-recovery-failure",
      recoveryFails: true,
      data: { disposition: "may_have_completed", retry_safe: false },
    },
    {
      name: "invalidates the configured bridge cache and preserves structured errors",
      cliPath: "~/imsg-stall-tilde/imsg",
      recoveryFails: false,
      data: { disposition: "not_started", retry_safe: true },
    },
  ])("$name", async ({ cliPath, recoveryFails, data }) => {
    const stallMessage = "Timed out waiting for response to 'send-message'";
    const runtimeError = vi.fn();
    if (recoveryFails) {
      runIMessageCliJsonCommandMock.mockRejectedValueOnce(new Error("launch stderr stream failed"));
    }
    privateApiStatus.setCachedIMessagePrivateApiStatus(cliPath, { ...seeded });
    expect(privateApiStatus.getCachedIMessagePrivateApiStatus(cliPath)?.available).toBe(true);
    const client = await startClient({ cliPath, runtime: runtime(runtimeError) });
    const pending = client.request("send", {}, { timeoutMs: 0 });
    pending.catch(() => {});
    emitRpcError(child, { code: -32603, message: stallMessage, data });
    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(IMessageRpcRequestError);
    expect(error).toMatchObject({
      code: -32603,
      data,
      message: expect.stringContaining(stallMessage),
    });
    if (recoveryFails) {
      expect(runtimeError).toHaveBeenCalledWith(
        "imessage: automatic bridge recovery failed. The imsg private API bridge stopped responding. Run `imsg launch` to re-inject the dylib, then `openclaw channels status --probe` to refresh capability detection.",
      );
    } else {
      // The cache key stays configured (tilde-relative), unlike the expanded spawn path.
      expect(privateApiStatus.getCachedIMessagePrivateApiStatus(cliPath)).toBeUndefined();
      expect(runIMessageCliJsonCommandMock).toHaveBeenCalledWith({
        cliPath,
        args: ["launch"],
        timeoutMs: 30_000,
      });
      expect(error).toHaveProperty("message", expect.stringContaining("imsg launch"));
      expect(error).toHaveProperty("message", expect.stringContaining("channels status --probe"));
    }
  });

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
  });
});
