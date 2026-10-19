import { deepStrictEqual } from "node:assert/strict";
import { once } from "node:events";
// MCP framing and disposal preserve the spawn owner's independent cleanup receipt.
import fs from "node:fs/promises";
import type { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { EmptyResultSchema, JSONRPCRequestSchema } from "@modelcontextprotocol/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { OwnedStdioCleanupError, type OwnedStdioProcess } from "../process/owned-stdio.js";
import {
  connectMcpClient,
  disposeMcpClient,
  McpClientConnectTimeoutError,
} from "./mcp-client-lifecycle.js";
import { OpenClawStdioClientTransport } from "./mcp-stdio-transport.js";
import {
  createStdioProcessFixture,
  rejectStdioWrites,
  waitForStdioCleanup,
  writeRpc,
} from "./mcp-stdio.test-support.js";
import { createAgentCleanupScope } from "./run-cleanup-timeout.js";

const spawnMock = vi.hoisted(() => vi.fn());
const closeMock = vi.hoisted(() => vi.fn());
vi.mock("../process/owned-stdio.js", async (importOriginal) => {
  const { OwnedStdioCleanupError: CleanupError } =
    await importOriginal<typeof import("../process/owned-stdio.js")>();
  return {
    createOwnedStdioProcess: spawnMock,
    closeOwnedStdioProcess: closeMock,
    OwnedStdioCleanupError: CleanupError,
  };
});

const transports: OpenClawStdioClientTransport[] = [];
type TransportParams = ConstructorParameters<typeof OpenClawStdioClientTransport>[0];
function createTransport(params: Partial<TransportParams> = {}) {
  const transport = new OpenClawStdioClientTransport({ command: "node", ...params });
  transports.push(transport);
  return transport;
}
const childCleanups: Array<() => void> = [];
function createFixture(params: Partial<TransportParams> = {}) {
  const process = createStdioProcessFixture();
  const transport = createTransport(params);
  const events = { onclose: vi.fn(), onerror: vi.fn(), onmessage: vi.fn(), onexit: vi.fn() };
  Object.assign(transport, events);
  childCleanups.push(process.cleanup);
  spawnMock.mockImplementation(process.spawn);
  return { ...process, ...events, transport };
}

async function startedFixture(params: Partial<TransportParams> = {}) {
  const fixture = createFixture(params);
  await fixture.transport.start();
  return fixture;
}

function readRequest(stdin: PassThrough) {
  return JSONRPCRequestSchema.parse(JSON.parse(stdin.read().toString("utf8")));
}

function disposeTransport(transport: OpenClawStdioClientTransport, timeout?: number) {
  return disposeMcpClient(
    { transport, transportType: "stdio", client: { close: () => transport.close() } },
    timeout,
  );
}

beforeEach(() => {
  closeMock.mockImplementation(waitForStdioCleanup);
});
afterEach(async () => {
  for (const cleanup of childCleanups.splice(0)) {
    cleanup();
  }
  await Promise.allSettled(transports.splice(0).map((transport) => transport.close()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  spawnMock.mockReset();
  closeMock.mockReset();
});

describe("OpenClawStdioClientTransport", () => {
  it("binds an exact environment without importing MCP default variables", async () => {
    await startedFixture({
      exactEnv: true,
      env: { ONLY: "1", OMIT: undefined },
    });
    expect(spawnMock).toHaveBeenCalledWith(
      expect.objectContaining({ exactEnv: true, env: { ONLY: "1" } }),
    );
  });

  it("retires SDK requests immediately while TERM cleanup still owns descendants", async () => {
    const fixture = createFixture();
    const { transport, onmessage: received, onexit } = fixture;
    const client = new Client({ name: "stdio-ownership-test", version: "1" });
    const connecting = client.connect(transport);
    await vi.waitFor(() => expect(fixture.stdin.readableLength).toBeGreaterThan(0));
    const initialize = readRequest(fixture.stdin);
    writeRpc(fixture.stdout, {
      jsonrpc: "2.0",
      id: initialize.id,
      result: {
        protocolVersion: initialize.params?.protocolVersion,
        capabilities: {},
        serverInfo: { name: "fixture", version: "1" },
      },
    });
    await connecting;
    vi.useFakeTimers();
    const pending = client.request({ method: "ping" }, EmptyResultSchema, { timeout: 120_000 });
    const rejected = expect(pending).rejects.toThrow("Connection closed");
    const closed = vi.fn();
    const closing = transport.terminate().then(closed);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(fixture.child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    await expect(transport.send({ jsonrpc: "2.0", id: 9, method: "ping" })).rejects.toThrow(
      "Not connected",
    );
    fixture.stdout.write('{"jsonrpc":"2.0","id":9,"result":{}}\n');
    expect(received).toHaveBeenCalledOnce();
    expect(closed).not.toHaveBeenCalled();
    fixture.root.resolve({ code: null, signal: "SIGTERM" });
    await Promise.resolve();
    expect(onexit).toHaveBeenCalledExactlyOnceWith({ code: null, signal: "SIGTERM" });
    expect(closed).not.toHaveBeenCalled();
    fixture.extinction.resolve();
    await closing;
    expect(closed).toHaveBeenCalledOnce();
  });

  it("does not infer plugin data directory ownership from server environment", async () => {
    const mkdir = vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    await startedFixture({ env: { PLUGIN_ROOT: "/plugin", PLUGIN_DATA: "/user-owned-file" } });
    expect(mkdir).not.toHaveBeenCalled();
  });

  it("forceClose retires startup while its owned data directory is being prepared", async () => {
    const preparation = createDeferred<undefined>();
    vi.spyOn(fs, "mkdir").mockReturnValue(preparation.promise);
    const { transport, onclose } = createFixture({ prepareDataDir: "/owned-plugin-data" });
    const started = transport.start();
    const closing = transport.forceClose();
    expect(onclose).not.toHaveBeenCalled();
    preparation.resolve(undefined);

    await expect(started).rejects.toThrow("closed");
    await closing;
    expect(spawnMock).not.toHaveBeenCalled();
    expect(onclose).toHaveBeenCalledOnce();
    await transport.close();
    await transport.forceClose();
    expect(onclose).toHaveBeenCalledOnce();
    await expect(transport.start()).rejects.toThrow("closed");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("joins one disposal across root exit, repeated close and forced escalation", async () => {
    const fixture = createFixture();
    const { transport, onclose } = fixture;
    await transport.start();
    const closing = transport.close();
    const settled = vi.fn();
    void closing.then(settled);
    expect(transport.close()).toBe(closing);
    expect(transport.forceClose()).toBe(closing);
    expect(fixture.child.kill).toHaveBeenCalledWith("SIGKILL");
    fixture.root.resolve({ code: 0, signal: null });
    await vi.waitFor(() => expect(onclose).toHaveBeenCalledOnce());
    expect(settled).not.toHaveBeenCalled();
    expect(transport.pid).toBe(4321);
    fixture.extinction.resolve();
    await closing;
    expect(closeMock).toHaveBeenCalledOnce();
    expect(transport.pid).toBeNull();
    await transport.forceClose();
    await transport.close();
    expect(fixture.child.kill).toHaveBeenCalledOnce();
    expect(onclose).toHaveBeenCalledOnce();
  });

  it("keeps failed owner cleanup uncertain through repeated disposal", async () => {
    const fixture = await startedFixture();
    const failure = new Error("cleanup owner lost");
    const cleanupErrors: unknown[] = [];
    const cleanupScope = createAgentCleanupScope();
    const { transport } = fixture;
    const closing = transport.close();
    fixture.root.resolve({ code: 0, signal: null });
    fixture.extinction.reject(failure);
    await expect(closing).rejects.toBe(failure);
    await cleanupScope.run(async () => {
      await expect(
        disposeMcpClient({
          transport,
          transportType: "stdio",
          client: { close: vi.fn().mockRejectedValue(new Error("later client cleanup failure")) },
          onCleanupError: (error) => {
            cleanupErrors.push(error);
            throw new Error("diagnostic observer failed");
          },
        }),
      ).resolves.toBe("uncertain");
      await expect(transport.close()).rejects.toBe(failure);
    });
    expect(cleanupScope.outcome).toBe("uncertain");
    expect(cleanupErrors).toEqual([failure]);
  });

  it.each(["initialize-error", "aborted", "timed-out"] as const)(
    "contains SDK %s cleanup rejection without certifying closure",
    async (trigger) => {
      const fixture = createFixture();
      const failure = new Error("service child cleanup identity lost");
      const { transport } = fixture;
      const client = new Client({ name: "doctor-mcp-proof", version: "1" });
      const cleanupScope = createAgentCleanupScope();
      const cleanupStarted = createDeferred();
      closeMock.mockImplementationOnce(async (child: OwnedStdioProcess) => {
        cleanupStarted.resolve();
        await waitForStdioCleanup(child);
      });
      await cleanupScope.run(async () => {
        const controller = new AbortController();
        const initializeWritten = once(fixture.stdin, "readable");
        const connecting = connectMcpClient({
          client,
          transport,
          timeoutMs: trigger === "timed-out" ? 50 : 5_000,
          signal: controller.signal,
        });
        const rejected =
          trigger === "timed-out"
            ? expect(connecting).rejects.toBeInstanceOf(McpClientConnectTimeoutError)
            : expect(connecting).rejects.toThrow("fixture initialization failed");
        await initializeWritten;
        const initialize = readRequest(fixture.stdin);
        expect(initialize.method).toBe("initialize");
        if (trigger === "aborted") {
          controller.abort(new Error("fixture initialization failed"));
        } else if (trigger === "initialize-error") {
          writeRpc(fixture.stdout, {
            jsonrpc: "2.0",
            id: initialize.id,
            error: { code: -32603, message: "fixture initialization failed" },
          });
        }
        await cleanupStarted.promise;
        fixture.root.resolve({ code: 1, signal: null });
        fixture.extinction.reject(failure);
        await rejected;
        // Let the SDK's discarded close promise settle before explicit disposal.
        await nextTurn();
        const onCleanupError = vi.fn();
        await expect(
          disposeMcpClient({ client, transport, transportType: "stdio", onCleanupError }),
        ).resolves.toBe("uncertain");
        expect(onCleanupError).toHaveBeenCalledExactlyOnceWith(failure);
        await expect(transport.close()).rejects.toBe(failure);
      });
      expect(cleanupScope.outcome).toBe("uncertain");
    },
  );

  it.each([
    { confirmed: true, outcome: "closed" },
    { confirmed: false, outcome: "uncertain" },
  ] as const)(
    "reports $outcome when forced shutdown confirmation is $confirmed",
    async ({ confirmed, outcome }) => {
      vi.useFakeTimers();
      const fixture = createFixture();
      fixture.child.kill.mockImplementation(() => {
        if (confirmed) {
          fixture.root.resolve({ code: null, signal: "SIGKILL" });
          fixture.extinction.resolve();
        }
      });
      const { transport } = fixture;
      await transport.start();
      const cleanupScope = createAgentCleanupScope();
      const disposal = cleanupScope.run(() => disposeTransport(transport, 50));
      await vi.advanceTimersByTimeAsync(100);
      await expect(disposal).resolves.toBe(outcome);
      expect(cleanupScope.outcome).toBe(outcome);
    },
  );

  it.each([true, false])(
    "joins the owner's original deadline across MCP outer force (confirmed=%s)",
    async (confirmed) => {
      const { closeOwnedStdioProcess } = await vi.importActual<
        typeof import("../process/owned-stdio.js")
      >("../process/owned-stdio.js");
      closeMock.mockImplementation(closeOwnedStdioProcess);
      vi.useFakeTimers();
      const fixture = createFixture();
      let hardCancellationStarted = false;
      fixture.child.kill.mockImplementation((signal?: NodeJS.Signals) => {
        if (signal !== "SIGKILL" || hardCancellationStarted) {
          return;
        }
        hardCancellationStarted = true;
        setTimeout(() => {
          fixture.root.resolve({ code: null, signal: "SIGKILL" });
          if (confirmed) {
            fixture.extinction.resolve();
          } else {
            fixture.extinction.reject(new Error("owner cleanup deadline expired"));
          }
        }, 5_000);
      });
      const { transport } = fixture;
      await transport.start();
      const cleanupScope = createAgentCleanupScope();
      const finished = vi.fn();
      const disposal = cleanupScope.run(() => disposeTransport(transport));
      void disposal.then(finished);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(fixture.child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fixture.child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"], ["SIGKILL"]]);
      expect(finished).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(disposal).resolves.toBe(confirmed ? "closed" : "uncertain");
      expect(cleanupScope.outcome).toBe(confirmed ? "closed" : "uncertain");
      expect(closeMock).toHaveBeenCalledOnce();
      expect(fixture.child.dispose).toHaveBeenCalledOnce();
    },
  );

  it("cancels pending startup and replays its failed cleanup to later disposal", async () => {
    const failure = new OwnedStdioCleanupError("startup owner lost", {
      cause: new Error("MCP startup aborted"),
    });
    spawnMock.mockImplementation(
      ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal.addEventListener("abort", () => reject(failure), { once: true });
        }),
    );
    const transport = createTransport();
    const startup = transport.start().catch((error: unknown) => error);
    await expect(transport.forceClose()).rejects.toBe(failure);
    expect(await startup).toBe(failure);
    expect(transport.pid).toBeNull();

    const cleanupScope = createAgentCleanupScope();
    await cleanupScope.run(async () => {
      await expect(transport.close()).rejects.toBe(failure);
    });
    expect(cleanupScope.outcome).toBe("uncertain");
  });

  it.each(["callback", "throw"])("rejects failed stdin writes through %s", async (mode) => {
    const fixture = createFixture();
    const failure = new Error("write EPIPE");
    rejectStdioWrites(fixture.stdin, failure, mode);
    const { transport } = fixture;
    await transport.start();
    await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toBe(failure);
  });

  it("forwards owner stream errors and retains stderr diagnostics", async () => {
    const fixture = createFixture({ stderr: "pipe" });
    const { transport, onerror } = fixture;
    await transport.start();
    const failure = new Error("simulated pipe failure");
    fixture.emitError(failure);
    fixture.stderr.write("server diagnostic");
    expect(onerror).toHaveBeenCalledWith(failure);
    expect(transport.stderr?.read()?.toString()).toBe("server diagnostic");
  });

  it("backpressures unread stderr and delivers every byte when the reader resumes", async () => {
    const fixture = await startedFixture({ stderr: "pipe" });
    const { transport } = fixture;
    const destination = transport.stderr!;
    const chunk = Buffer.alloc(16 * 1024, 0xad);
    let completed = false;
    const writing = (async () => {
      for (let index = 0; index < 64; index += 1) {
        if (!fixture.stderr.write(chunk)) {
          await once(fixture.stderr, "drain");
        }
      }
      completed = true;
    })();
    await nextTurn();
    expect(completed).toBe(false);
    expect(destination.readableLength + destination.writableLength).toBeLessThanOrEqual(
      4 * destination.writableHighWaterMark,
    );
    const received: Buffer[] = [];
    destination.on("data", (data: Buffer) => received.push(data));
    await writing;
    fixture.root.resolve({ code: 0, signal: null });
    fixture.extinction.resolve();
    await transport.close();
    deepStrictEqual(Buffer.concat(received), Buffer.alloc(chunk.length * 64, 0xad));
  });

  it("keeps default malformed-frame recovery when the caller does not retire", async () => {
    const fixture = createFixture();
    const { transport, onerror, onmessage } = fixture;
    await transport.start();
    fixture.stdout.write('invalid\n{"jsonrpc":"2.0","id":1,"result":{}}\n');
    expect(onerror).toHaveBeenCalledOnce();
    expect(onmessage).toHaveBeenCalledExactlyOnceWith({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("accepts string response ids in the generic transport", async () => {
    const { transport, stdout, onerror, onmessage } = createFixture();
    await transport.start();
    stdout.write('{"jsonrpc":"2.0","id":"peer-request","result":{}}\n');
    expect(onerror).not.toHaveBeenCalled();
    expect(onmessage).toHaveBeenCalledExactlyOnceWith({
      jsonrpc: "2.0",
      id: "peer-request",
      result: {},
    });
  });

  it("reports an oversized stdout frame without an unhandled error crash", async () => {
    const fixture = createFixture();
    const { transport, onerror } = fixture;
    await transport.start();
    expect(() => fixture.stdout.write(Buffer.alloc(10 * 1024 * 1024 + 1, 0x20))).not.toThrow();
    expect(onerror).toHaveBeenCalledOnce();
    expect(onerror.mock.calls[0]?.[0].message).toMatch(/exceeded maximum size/);
  });
});
