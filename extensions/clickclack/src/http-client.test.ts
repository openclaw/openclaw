import { createServer, type Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createClickClackClient } from "./http-client.js";

const LOOPBACK_RESPONSE_BYTES = 18 * 1024 * 1024;

function requestBodyJson(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body !== "string") {
    throw new Error("expected string request body");
  }
  return JSON.parse(body);
}

async function listenLoopbackServer(server: Server): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected loopback TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

function createOversizedJsonServer(): { server: Server; closed: Promise<number> } {
  let resolveClosed: (sentBytes: number) => void = () => {};
  const closed = new Promise<number>((resolve) => {
    resolveClosed = resolve;
  });
  const server = createServer((req, res) => {
    let sentBytes = 0;
    let stopped = false;
    let prefixSent = false;
    const prefixChunk = Buffer.from('{"user":{"id":"');
    const bodyChunk = Buffer.alloc(64 * 1024, 0x61);
    const suffixChunk = Buffer.from('"}}');
    const writeBuffer = (buffer: Buffer) => {
      sentBytes += buffer.length;
      if (!res.write(buffer)) {
        res.once("drain", writeChunks);
        return false;
      }
      return true;
    };
    const writeChunks = () => {
      if (!prefixSent) {
        prefixSent = true;
        if (!writeBuffer(prefixChunk)) {
          return;
        }
      }
      while (true) {
        if (stopped) {
          return;
        }
        if (sentBytes + bodyChunk.length + suffixChunk.length >= LOOPBACK_RESPONSE_BYTES) {
          break;
        }
        if (!writeBuffer(bodyChunk)) {
          return;
        }
      }
      if (!stopped) {
        sentBytes += suffixChunk.length;
        res.end(suffixChunk);
      }
    };
    res.writeHead(200, { connection: "close", "content-type": "application/json" });
    res.on("close", () => {
      stopped = true;
      resolveClosed(sentBytes);
    });
    req.on("aborted", () => {
      stopped = true;
      res.destroy();
    });
    writeChunks();
  });
  return { server, closed };
}

function streamedErrorResponse(body: string, limit: number) {
  const encoded = new TextEncoder().encode(body);
  let readCount = 0;
  const cancel = vi.fn(async () => undefined);
  const releaseLock = vi.fn();
  const text = vi.fn(async () => {
    throw new Error("raw response.text() should not be used");
  });

  const response = {
    ok: false,
    status: 502,
    text,
    body: {
      getReader: () => ({
        read: async () => {
          if (readCount > 0) {
            return { done: true, value: undefined };
          }
          readCount += 1;
          return { done: false, value: encoded };
        },
        cancel,
        releaseLock,
      }),
    },
  } as unknown as Response;

  return {
    response,
    cancel,
    releaseLock,
    text,
    expectedDetail: body.slice(0, limit),
  };
}

describe("ClickClack HTTP client", () => {
  it("bounds oversized success JSON responses and closes the stream early", async () => {
    const { server, closed } = createOversizedJsonServer();
    const port = await listenLoopbackServer(server);
    const client = createClickClackClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token: "test-token",
    });

    try {
      await expect(client.me()).rejects.toThrow(
        "ClickClack response: JSON response exceeds 16777216 bytes",
      );
      const sentBytes = await closed;
      expect(sentBytes).toBeLessThan(LOOPBACK_RESPONSE_BYTES);
    } finally {
      server.close();
    }
  });

  it("bounds error response bodies without using raw response.text()", async () => {
    const streamed = streamedErrorResponse("x".repeat(9000), 8 * 1024);
    const fetchMock = vi.fn(async () => streamed.response);
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "test-token",
      fetch: fetchMock,
    });

    await expect(client.me()).rejects.toThrow(`ClickClack 502: ${streamed.expectedDetail}`);

    expect(streamed.text).not.toHaveBeenCalled();
    expect(streamed.cancel).toHaveBeenCalledTimes(1);
    expect(streamed.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("POSTs durable activity rows with kind and turn_id", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ message: { id: "msg_9" } }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "test-token",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const message = await client.createActivityMessage({
      channelId: "chn_1",
      body: "ran bash",
      kind: "agent_tool",
      turnId: "t1",
    });

    expect(message.id).toBe("msg_9");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://clickclack.example/api/channels/chn_1/messages",
      expect.objectContaining({ method: "POST" }),
    );
    const init = fetchMock.mock.calls[0]?.[1];
    expect(requestBodyJson(init)).toEqual({
      body: "ran bash",
      kind: "agent_tool",
      turn_id: "t1",
    });
  });

  it("rejects activity rows without a channel or conversation target", async () => {
    const fetchMock = vi.fn();
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "test-token",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      client.createActivityMessage({ body: "orphan row", kind: "agent_commentary" }),
    ).rejects.toThrow("createActivityMessage requires a channelId or conversationId");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes DM activity rows through the conversation create path", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: { id: "msg_10" } }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "test-token",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.createActivityMessage({
      conversationId: "dcn_1",
      body: "thinking about it",
      kind: "agent_commentary",
      turnId: "t1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://clickclack.example/api/dms/dcn_1/messages",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("PATCHes message bodies for activity row coalescing", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ message: { id: "msg_9", body: "longer" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "test-token",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.updateMessageBody("msg_9", "longer");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://clickclack.example/api/messages/msg_9",
      expect.objectContaining({ method: "PATCH" }),
    );
    const init = fetchMock.mock.calls[0]?.[1];
    expect(requestBodyJson(init)).toEqual({ body: "longer" });
  });
});
