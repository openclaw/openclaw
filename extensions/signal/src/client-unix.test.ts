import { once } from "node:events";
import { chmod, realpath } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as fetchRuntime from "openclaw/plugin-sdk/fetch-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signalCheck, signalRpcRequest, streamSignalEvents } from "./client.js";
import * as socketEndpoint from "./socket-path.js";
import { runSignalSseLoop } from "./sse-reconnect.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

async function serve(onRequest: (request: Record<string, unknown>, socket: net.Socket) => void) {
  const dir = tempDirs.make("signal-unix-", await realpath(os.tmpdir()));
  await chmod(dir, 0o700);
  const socketPath = path.join(dir, "rpc socket");
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      const newline = input.indexOf("\n");
      if (newline !== -1) {
        onRequest(JSON.parse(input.slice(0, newline)), socket);
        input = input.slice(newline + 1);
      }
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  cleanups.push(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
  return { baseUrl: pathToFileURL(socketPath).href.replace(/^file:/, "unix:"), dir };
}

function response(id: unknown, result: unknown) {
  return `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;
}

describe.skipIf(process.platform === "win32")("Signal UNIX transport", () => {
  it.each([false, true])(
    "prepares the socket write and rechecks its caller after waiting (revoked=%s)",
    async (revoked) => {
      const preparing = createDeferred<void>();
      const prepared = createDeferred<void>();
      const arrived = createDeferred<void>();
      const reply = createDeferred<void>();
      const authority = fetchRuntime.captureEffectAuthority();
      vi.spyOn(fetchRuntime, "captureEffectAuthority").mockReturnValue({
        ...authority,
        async initiate(effect) {
          preparing.resolve();
          await prepared.promise;
          return authority.initiate(effect);
        },
      });
      const requests: Record<string, unknown>[] = [];
      const { baseUrl } = await serve((request, socket) => {
        requests.push(request);
        arrived.resolve();
        void reply.promise.then(() => socket.end(response(request.id, { sent: true })));
      });
      const caller = new AbortController();
      const failure = new Error("Signal caller ended during preparation");
      const sending = signalRpcRequest(
        "send",
        { message: "prepared" },
        {
          baseUrl,
          assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
        },
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([
          preparing.promise,
          arrived.promise.then(() => {
            throw new Error("socket write bypassed preparation");
          }),
        ]);
        expect(requests).toEqual([]);
        if (revoked) {
          caller.abort(failure);
        }
        prepared.resolve();
        if (!revoked) {
          await arrived.promise;
          reply.resolve();
        }
        expect(await sending).toEqual(revoked ? { error: failure } : { value: { sent: true } });
        expect(requests).toHaveLength(revoked ? 0 : 1);
      } finally {
        caller.abort(failure);
        prepared.resolve();
        reply.resolve();
        await sending;
      }
    },
  );

  it("sends newline JSON-RPC and matches a fragmented UTF-8 response by id", async () => {
    const caller = new AbortController();
    const requests: Record<string, unknown>[] = [];
    const { baseUrl } = await serve((request, socket) => {
      requests.push(request);
      caller.abort(new Error("Signal caller closed after transmission"));
      const bytes = Buffer.from(response(request.id, { text: "héllo" }));
      const split = bytes.indexOf(Buffer.from("é")) + 1;
      socket.write(response("unrelated", "wrong"));
      socket.write(bytes.subarray(0, split));
      setImmediate(() => socket.write(bytes.subarray(split)));
    });
    await expect(
      signalRpcRequest(
        "send",
        { message: "test" },
        {
          baseUrl,
          assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
        },
      ),
    ).resolves.toEqual({
      text: "héllo",
    });
    expect(requests).toEqual([
      expect.objectContaining({ jsonrpc: "2.0", method: "send", params: { message: "test" } }),
    ]);
  });

  it("stops before writing when the caller closes during socket preparation", async () => {
    const requests: Record<string, unknown>[] = [];
    const { baseUrl } = await serve((request, socket) => {
      requests.push(request);
      socket.end(response(request.id, { timestamp: 1700000000999 }));
    });
    const caller = new AbortController();
    const validate = socketEndpoint.assertSignalSocketEndpoint;
    const preparation = vi
      .spyOn(socketEndpoint, "assertSignalSocketEndpoint")
      .mockImplementationOnce(async (endpoint) => {
        await validate(endpoint);
        caller.abort(new Error("Signal caller closed during socket preparation"));
      });

    await expect(
      signalRpcRequest(
        "send",
        { message: "pending" },
        {
          baseUrl,
          assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
        },
      ),
    ).rejects.toThrow("Signal caller closed during socket preparation");
    expect(preparation).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(0);
  });

  it("checks the daemon using the supported version RPC", async () => {
    const { baseUrl } = await serve((request, socket) => {
      expect(request.method).toBe("version");
      socket.write(response(request.id, { version: "test" }));
    });
    await expect(signalCheck(baseUrl)).resolves.toEqual({ ok: true, status: null, error: null });
  });

  it.each([
    ["malformed JSON", "private +15550000001\n", /^Signal UNIX RPC returned malformed JSON$/],
    ["incomplete frame", '{"jsonrpc":', /incomplete frame/],
    ["oversized frame", "x".repeat(129), /size limit/],
  ] as const)("rejects %s without falling back to HTTP", async (_name, reply, error) => {
    const { baseUrl } = await serve((_request, socket) => socket.end(reply));
    await expect(
      signalRpcRequest("send", undefined, { baseUrl, maxResponseBytes: 128 }),
    ).rejects.toThrow(error);
  });

  it.each([
    [
      -32602,
      'quote rejected: Unrecognized field "quoteTimestamp" for +15550000001',
      "quote metadata rejected (redacted)",
    ],
    [-32602, "quote metadata invalid: unknown author", "quote metadata rejected (redacted)"],
    [-32602, "private +15550000001", "remote error"],
    [-32000, "quote metadata was rejected after an ambiguous send +15550000001", "remote error"],
  ] as const)("redacts RPC %s: %s", async (code, message, classification) => {
    const { baseUrl } = await serve((request, socket) =>
      socket.end(
        `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code, message } })}\n`,
      ),
    );
    await expect(signalRpcRequest("send", undefined, { baseUrl })).rejects.toMatchObject({
      message: `Signal RPC ${code}: ${classification}`,
    });
  });

  it.each(["request", "subscription"] as const)(
    "bounds an unanswered %s and closes its socket",
    async (mode) => {
      let closed: Promise<unknown> | undefined;
      const { baseUrl } = await serve((_request, socket) => {
        closed = once(socket, "close");
      });
      const opened = vi.fn();
      const pending =
        mode === "request"
          ? signalRpcRequest("send", undefined, { baseUrl, timeoutMs: 30 })
          : streamSignalEvents({ baseUrl, timeoutMs: 30, onStreamOpen: opened, onEvent: () => {} });
      await expect(pending).rejects.toThrow(/deadline/);
      expect(opened).not.toHaveBeenCalled();
      await closed;
    },
  );

  it("rejects an insecure parent before sending account data", async () => {
    const onRequest = vi.fn();
    const { baseUrl, dir } = await serve(onRequest);
    await chmod(dir, 0o755);
    await expect(signalRpcRequest("send", { message: "private" }, { baseUrl })).rejects.toThrow();
    expect(onRequest).not.toHaveBeenCalled();
  });

  it("subscribes, unwraps manual notifications, filters other accounts and aborts", async () => {
    const controller = new AbortController();
    const opened = vi.fn();
    const events: unknown[] = [];
    const payload = { account: "+15550000001", envelope: { dataMessage: { message: "hello" } } };
    const { baseUrl } = await serve((request, socket) => {
      expect(request).toMatchObject({
        method: "subscribeReceive",
        params: { account: payload.account },
      });
      socket.write(response(request.id, 7));
      for (const result of [{ ...payload, account: "+15550000002" }, payload]) {
        socket.write(
          `${JSON.stringify({ jsonrpc: "2.0", method: "receive", params: { subscription: 7, result } })}\n`,
        );
      }
    });
    await expect(
      streamSignalEvents({
        baseUrl,
        account: payload.account,
        abortSignal: controller.signal,
        onStreamOpen: opened,
        onEvent: (event) => {
          events.push(event);
          controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(opened).toHaveBeenCalledOnce();
    expect(events).toEqual([{ event: "receive", data: JSON.stringify(payload) }]);
  });

  it("receives after a delayed subscription through the monitor's zero-timeout reconnect path", async () => {
    const controller = new AbortController();
    const events: unknown[] = [];
    const statusSink = vi.fn();
    const error = vi.fn(() => controller.abort());
    const payload = { envelope: { dataMessage: { message: "delayed" } } };
    const { baseUrl } = await serve((request, socket) => {
      expect(request.method).toBe("subscribeReceive");
      const timer = setTimeout(() => {
        socket.write(response(request.id, 7));
        socket.write(
          `${JSON.stringify({ jsonrpc: "2.0", method: "receive", params: { subscription: 7, result: payload } })}\n`,
        );
      }, 30);
      socket.once("close", () => clearTimeout(timer));
    });
    await runSignalSseLoop({
      baseUrl,
      timeoutMs: 0,
      abortSignal: controller.signal,
      runtime: { log: vi.fn(), error, exit: vi.fn() },
      statusSink,
      onEvent: (event) => {
        events.push(event);
        controller.abort();
      },
    });
    expect(error).not.toHaveBeenCalled();
    expect(statusSink).toHaveBeenCalledWith(expect.objectContaining({ connected: true }));
    expect(events).toEqual([{ event: "receive", data: JSON.stringify(payload) }]);
  });

  it("closes a subscribed socket when the event consumer throws", async () => {
    let closed: Promise<unknown> | undefined;
    const { baseUrl } = await serve((request, socket) => {
      closed = once(socket, "close");
      socket.write(response(request.id, 0));
      socket.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "receive", params: { subscription: 0, result: { envelope: {} } } })}\n`,
      );
    });
    await expect(
      streamSignalEvents({
        baseUrl,
        onEvent: () => {
          throw new Error("consumer failure");
        },
      }),
    ).rejects.toThrow("consumer failure");
    await closed;
  });
});
