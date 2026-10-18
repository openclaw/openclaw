import { once } from "node:events";
import { chmod, realpath } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signalCheck, signalRpcRequest, streamSignalEvents } from "./client.js";
import { expectPreparedHandoff } from "./client.test-support.js";
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
function notify(socket: net.Socket, result: unknown, subscription = 7) {
  socket.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "receive", params: { subscription, result } })}\n`,
  );
}
const send = (
  baseUrl: string,
  message?: string,
  options: Partial<Parameters<typeof signalRpcRequest>[2]> = {},
) => signalRpcRequest("send", message ? { message } : undefined, { baseUrl, ...options });

describe.skipIf(process.platform === "win32")("Signal UNIX transport", () => {
  it.each([false, true])(
    "prepares the socket write and rechecks its caller after waiting (revoked=%s)",
    async (revoked) => {
      await expectPreparedHandoff(revoked, async ({ arrive, response: reply, assertHandoff }) => {
        const requests: Record<string, unknown>[] = [];
        const { baseUrl } = await serve((request, socket) => {
          requests.push(request);
          arrive();
          void reply.then(() => socket.end(response(request.id, { sent: true })));
        });
        return {
          send: () => send(baseUrl, "prepared", { assertDirectAdapterHandoff: assertHandoff }),
          assertCount: (count) => expect(requests).toHaveLength(count),
          result: { sent: true },
        };
      });
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
      send(baseUrl, "test", {
        assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
      }),
    ).resolves.toEqual({ text: "héllo" });
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
      send(baseUrl, "pending", {
        assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
      }),
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
    await expect(send(baseUrl, undefined, { maxResponseBytes: 128 })).rejects.toThrow(error);
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
    await expect(send(baseUrl)).rejects.toMatchObject({
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
          ? send(baseUrl, undefined, { timeoutMs: 30 })
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
    await expect(send(baseUrl, "private")).rejects.toThrow();
    expect(onRequest).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "receives notifications and aborts (delayed reconnect=%s)",
    async (delayed) => {
      const controller = new AbortController();
      const opened = vi.fn();
      const events: unknown[] = [];
      const statusSink = vi.fn();
      const error = vi.fn(() => controller.abort());
      const payload = { account: "+15550000001", envelope: { dataMessage: { message: "hello" } } };
      const { baseUrl } = await serve((request, socket) => {
        expect(request.method).toBe("subscribeReceive");
        if (!delayed) {
          expect(request.params).toEqual({ account: payload.account });
        }
        const deliver = () => {
          socket.write(response(request.id, 7));
          if (!delayed) {
            notify(socket, { ...payload, account: "+15550000002" });
          }
          notify(socket, payload);
        };
        if (!delayed) {
          deliver();
        } else {
          const timer = setTimeout(deliver, 30);
          socket.once("close", () => clearTimeout(timer));
        }
      });
      const options = {
        baseUrl,
        abortSignal: controller.signal,
        onEvent: (event: Parameters<Parameters<typeof streamSignalEvents>[0]["onEvent"]>[0]) => {
          events.push(event);
          controller.abort();
        },
      };
      if (delayed) {
        await runSignalSseLoop({
          ...options,
          timeoutMs: 0,
          statusSink,
          runtime: { log: vi.fn(), error, exit: vi.fn() },
        });
        expect(error).not.toHaveBeenCalled();
        expect(statusSink).toHaveBeenCalledWith(expect.objectContaining({ connected: true }));
      } else {
        await expect(
          streamSignalEvents({ ...options, account: payload.account, onStreamOpen: opened }),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(opened).toHaveBeenCalledOnce();
      }
      expect(events).toEqual([{ event: "receive", data: JSON.stringify(payload) }]);
    },
  );

  it("closes a subscribed socket when the event consumer throws", async () => {
    let closed: Promise<unknown> | undefined;
    const { baseUrl } = await serve((request, socket) => {
      closed = once(socket, "close");
      socket.write(response(request.id, 0));
      notify(socket, { envelope: {} }, 0);
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
