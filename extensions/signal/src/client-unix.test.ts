import { once } from "node:events";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signalCheck, signalRpcRequest, streamSignalEvents } from "./client.js";
import { runSignalSseLoop } from "./sse-reconnect.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

async function serve(onRequest: (request: Record<string, unknown>, socket: net.Socket) => void) {
  const dir = await mkdtemp(path.join(await realpath(os.tmpdir()), "signal-unix-"));
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
    await rm(dir, { recursive: true, force: true });
  });
  return { baseUrl: pathToFileURL(socketPath).href.replace(/^file:/, "unix:"), dir };
}

function response(id: unknown, result: unknown) {
  return `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;
}

describe.skipIf(process.platform === "win32")("Signal UNIX transport", () => {
  it("sends newline JSON-RPC and matches a fragmented UTF-8 response by id", async () => {
    const requests: Record<string, unknown>[] = [];
    const { baseUrl } = await serve((request, socket) => {
      requests.push(request);
      const bytes = Buffer.from(response(request.id, { text: "héllo" }));
      const split = bytes.indexOf(Buffer.from("é")) + 1;
      socket.write(response("unrelated", "wrong"));
      socket.write(bytes.subarray(0, split));
      setImmediate(() => socket.write(bytes.subarray(split)));
    });
    await expect(signalRpcRequest("send", { message: "test" }, { baseUrl })).resolves.toEqual({
      text: "héllo",
    });
    expect(requests).toEqual([
      expect.objectContaining({ jsonrpc: "2.0", method: "send", params: { message: "test" } }),
    ]);
  });

  it("checks the daemon using the supported version RPC", async () => {
    const { baseUrl } = await serve((request, socket) => {
      expect(request.method).toBe("version");
      socket.write(response(request.id, { version: "test" }));
    });
    await expect(signalCheck(baseUrl)).resolves.toEqual({ ok: true, status: null, error: null });
  });

  it.each([
    [
      "RPC error",
      (id: unknown) =>
        `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -1, message: "denied" } })}\n`,
      /Signal RPC -1: denied/,
    ],
    ["malformed JSON", () => "bad json\n", /JSON/],
    ["incomplete frame", () => '{"jsonrpc":', /incomplete frame/],
    ["oversized frame", () => "x".repeat(129), /size limit/],
  ] as const)("rejects %s without falling back to HTTP", async (_name, reply, error) => {
    const { baseUrl } = await serve((request, socket) => socket.end(reply(request.id)));
    await expect(
      signalRpcRequest("send", undefined, { baseUrl, maxResponseBytes: 128 }),
    ).rejects.toThrow(error);
  });

  it("enforces a response deadline and closes the connection", async () => {
    let closed: Promise<unknown> | undefined;
    const { baseUrl } = await serve((_request, socket) => {
      closed = once(socket, "close");
    });
    await expect(signalRpcRequest("send", undefined, { baseUrl, timeoutMs: 30 })).rejects.toThrow(
      /deadline/,
    );
    await closed;
  });

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

  it("times out an unacknowledged subscription without reporting stream ready", async () => {
    const { baseUrl } = await serve(() => {});
    const opened = vi.fn();
    await expect(
      streamSignalEvents({ baseUrl, timeoutMs: 30, onStreamOpen: opened, onEvent: () => {} }),
    ).rejects.toThrow(/deadline/);
    expect(opened).not.toHaveBeenCalled();
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
