import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { createClickClackClient, normalizeClickClackCorrelationId } from "./http-client.js";

const effectGate = await vi.hoisted(async () =>
  (
    await import("../../test-support/effect-preparation.test-support.js")
  ).createEffectPreparationGate(),
);
// mock-isolation: Share the export-preserving factory, but keep the preparation gate suite-local.
vi.mock("openclaw/plugin-sdk/fetch-runtime", effectGate.mockRuntime);

const LOOPBACK_RESPONSE_BYTES = 18 * 1024 * 1024;
const CLICKCLACK_REQUEST_BODY_LIMIT_BYTES = 1024 * 1024;
const CLICKCLACK_INBOUND_JSON_LIMIT_BYTES = 16 * 1024 * 1024;

function createTestClient(
  fetch: typeof globalThis.fetch,
  options: Omit<Partial<Parameters<typeof createClickClackClient>[0]>, "fetch"> = {},
) {
  return createClickClackClient({
    baseUrl: "https://clickclack.example",
    token: "fake",
    ...options,
    fetch,
  });
}

function historyRoot(sequence: number, replies: number) {
  return {
    id: "msg_root",
    channel_seq: sequence,
    created_at: "2026-07-19T10:00:00.000Z",
    thread_state: { reply_count: replies, last_reply_at: "2026-07-19T13:00:00.000Z" },
  };
}

function jsonResponses(...bodies: unknown[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const body of bodies) {
    fetch.mockResolvedValueOnce(Response.json(body));
  }
  return fetch;
}

function expectRequest(
  calls: readonly (readonly unknown[])[],
  index: number,
  path: string,
  method?: string,
  body?: unknown,
) {
  expect(calls[index - 1]).toEqual([
    `https://clickclack.example/api/${path}`,
    method ? expect.objectContaining({ method }) : expect.any(Object),
  ]);
  if (body !== undefined) {
    expect(requestBodyJson(calls[index - 1]?.[1])).toEqual(body);
  }
}

function jsonFetch(body: unknown, status = 200) {
  return vi.fn<typeof globalThis.fetch>(async () => Response.json(body, { status }));
}

function nonceResponses(kind: "Upload" | "Message", found: unknown) {
  return vi
    .fn()
    .mockResolvedValueOnce(Response.json(found))
    .mockResolvedValueOnce(
      Response.json(
        { error: "missing" },
        { status: 404, headers: { [`X-ClickClack-${kind}-Nonce`]: "supported" } },
      ),
    )
    .mockResolvedValueOnce(Response.json({ error: "old server" }, { status: 404 }))
    .mockResolvedValueOnce(Response.json({ error: "broken" }, { status: 503 }));
}

async function expectNonceErrors(
  find: (nonce: string) => Promise<unknown>,
  kind: "upload" | "message",
) {
  await expect(find("missing")).resolves.toBeUndefined();
  await expect(find("unsupported")).rejects.toMatchObject({
    message: expect.stringContaining(`does not support durable ${kind} nonce lookup`),
    cause: expect.objectContaining({ status: 404 }),
  });
  await expect(find("broken")).rejects.toThrow("ClickClack 503");
}

function requestBodyJson(init: unknown): unknown {
  const body = init && typeof init === "object" && "body" in init ? init.body : undefined;
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
  const closed = createDeferred<number>();
  const server = createServer((req, res) => {
    const prefix = Buffer.from('{"user":{"id":"');
    const body = Buffer.alloc(64 * 1024, 0x61);
    const suffix = Buffer.from('"}}');
    function* chunks() {
      yield prefix;
      for (
        let size = prefix.length;
        size + body.length + suffix.length < LOOPBACK_RESPONSE_BYTES;
        size += body.length
      ) {
        yield body;
      }
      yield suffix;
    }
    const stream = Readable.from(chunks(), { objectMode: false });
    let sentBytes = 0;
    stream.on("data", (chunk: Buffer) => {
      sentBytes += chunk.length;
    });
    res.writeHead(200, { connection: "close", "content-type": "application/json" });
    res.on("close", () => {
      stream.destroy();
      closed.resolve(sentBytes);
    });
    req.on("aborted", () => res.destroy());
    // pipe owns backpressure; response closure stops the remaining generator.
    stream.pipe(res);
  });
  return { server, closed: closed.promise };
}

function streamedErrorResponse(body: string) {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
    },
    cancel,
  });
  return { response: new Response(stream, { status: 502 }), stream, cancel };
}

describe("ClickClack HTTP client", () => {
  it("serializes explicit archive requests", async () => {
    const fetchMock = jsonFetch({ channel: { id: "chn_discussion" } });
    const patch = { archived: true, name: "release-done", sidebar_section: "Archive" };
    await createTestClient(fetchMock).updateChannel("chn_discussion", patch);
    expectRequest(fetchMock.mock.calls, 1, "channels/chn_discussion", "PATCH", patch);
  });

  it("merges recent thread replies into the global latest-message window", async () => {
    const root = historyRoot(10, 1);
    const newerRoot = {
      ...root,
      id: "msg_newer",
      channel_seq: 11,
      created_at: "2026-07-19T12:00:00.000Z",
      thread_state: { root_message_id: "msg_newer", reply_count: 0, last_reply_author_ids: [] },
    };
    const reply = {
      ...root,
      id: "msg_reply",
      parent_message_id: "msg_root",
      thread_seq: 1,
      created_at: "2026-07-19T13:00:00.000Z",
      thread_state: undefined,
    };
    const fetchMock = jsonResponses(
      { messages: [newerRoot], oldest_seq: 11, newest_seq: 11, has_older: true },
      { messages: [root], oldest_seq: 10, newest_seq: 10, has_older: false },
      { replies: [reply] },
    );
    expect(await createTestClient(fetchMock).latestChannelMessages("chn_discussion", 2)).toEqual({
      messages: [
        expect.objectContaining({ id: "msg_newer" }),
        expect.objectContaining({ id: "msg_reply" }),
      ],
      truncated: false,
    });
    expectRequest(
      fetchMock.mock.calls,
      2,
      "channels/chn_discussion/messages?limit=200&before_seq=11",
    );
    expectRequest(fetchMock.mock.calls, 3, "messages/msg_root/thread?limit=200");
  });

  it("fails closed when a capped thread response cannot contain the latest replies", async () => {
    const root = historyRoot(1, 201);
    const oldestReply = {
      ...root,
      id: "msg_oldest_reply",
      parent_message_id: "msg_root",
      thread_seq: 1,
      created_at: "2026-07-19T10:01:00.000Z",
      thread_state: undefined,
    };
    const fetchMock = jsonResponses(
      { messages: [root], oldest_seq: 1, newest_seq: 1, has_older: false },
      { replies: [oldestReply] },
    );
    expect(await createTestClient(fetchMock).latestChannelMessages("chn_discussion", 30)).toEqual({
      messages: [root],
      truncated: true,
    });
  });

  it("bounds discussion history pagination and reports truncation", async () => {
    let sequence = 1_000;
    const fetchMock = vi.fn(async () => {
      const current = sequence;
      sequence -= 1;
      return Response.json({
        messages: [
          {
            id: `msg_${current}`,
            channel_seq: current,
            created_at: `2026-07-19T10:00:${String(current % 60).padStart(2, "0")}.000Z`,
            thread_state: {
              reply_count: 0,
            },
          },
        ],
        oldest_seq: current,
        newest_seq: current,
        has_older: true,
      });
    });
    const client = createTestClient(fetchMock);

    const result = await client.latestChannelMessages("chn_discussion", 1);

    expect(result.truncated).toBe(true);
    expect(result.messages).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it("replaces the authenticated bot command menu", async () => {
    const botCommand = { id: "botcmd_1", command: "/status" };
    const fetchMock = jsonFetch({ bot_commands: [botCommand] });
    const commands = [{ command: "status", description: "Show agent status", args_hint: "" }];
    expect(await createTestClient(fetchMock).setBotCommands(commands)).toEqual([botCommand]);
    expectRequest(fetchMock.mock.calls, 1, "bots/self/commands", "PUT", { commands });
    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer fake");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("adds paged tail queries without changing the legacy events result", async () => {
    const fetchMock = vi.fn(async () => Response.json({ events: [], tail_cursor: "cursor-900" }));
    const client = createTestClient(fetchMock);

    const page = await client.eventPage("workspace-1", {
      afterCursor: "cursor-500",
      limit: 500,
      includeTail: true,
    });
    const legacyEvents = await client.events("workspace-1", "cursor-900");

    expectRequest(
      fetchMock.mock.calls,
      1,
      "realtime/events?workspace_id=workspace-1&after_cursor=cursor-500&limit=500&include_tail=true",
    );
    expectRequest(
      fetchMock.mock.calls,
      2,
      "realtime/events?workspace_id=workspace-1&after_cursor=cursor-900",
    );
    expect(page).toEqual({ events: [], tailCursor: "cursor-900" });
    expect(legacyEvents).toEqual([]);
  });

  it.each<[string, string | null]>([
    [" fakeco.case_1 ", "fakeco.case_1"],
    ["bad\rcorrelation", null],
  ])("sends only safe request correlation: %j", async (correlationId, expected) => {
    const fetchMock = jsonFetch({ user: { id: "usr_1" } });
    const client = createTestClient(fetchMock, { correlationId });
    await client.me();
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("X-Correlation-ID")).toBe(
      expected,
    );
    expect(normalizeClickClackCorrelationId("bad\ncorrelation")).toBeUndefined();
    expect(normalizeClickClackCorrelationId("x".repeat(129))).toBeUndefined();
  });

  it("bounds oversized success JSON responses and closes the stream early", async () => {
    const { server, closed } = createOversizedJsonServer();
    const port = await listenLoopbackServer(server);
    const client = createClickClackClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token: "fake",
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
    const streamed = streamedErrorResponse("x".repeat(9000));
    const text = vi.spyOn(streamed.response, "text");
    const fetchMock = vi.fn(async () => streamed.response);
    const client = createTestClient(fetchMock);

    await expect(client.me()).rejects.toThrow(`ClickClack 502: ${"x".repeat(8 * 1024)}`);

    expect(text).not.toHaveBeenCalled();
    expect(streamed.cancel).toHaveBeenCalledTimes(1);
    expect(streamed.stream.locked).toBe(false);
  });

  it("redacts non-2xx response details with built-in patterns", async () => {
    const fieldA = ["access", "token"].join("_");
    const fieldB = ["client", "secret"].join("_");
    const valueA = ["redact", "fixture", "a", "123"].join("_");
    const valueB = ["redact", "fixture", "b", "123"].join("_");
    const fetchMock = jsonFetch({ safe: "diagnostic", [fieldA]: valueA, [fieldB]: valueB }, 502);
    const client = createTestClient(fetchMock, { token: "test-token" });

    let message = "";
    try {
      await client.me();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('"safe":"diagnostic"');
    expect(message).not.toContain(valueA);
    expect(message).not.toContain(valueB);
  });

  it.each([
    [{ channelId: "chn_1" }, "agent_tool", "channels/chn_1/messages"],
    [{ conversationId: "dcn_1" }, "agent_commentary", "dms/dcn_1/messages"],
  ] as const)("creates activity rows for %j", async (target, kind, path) => {
    const fetchMock = jsonFetch({ message: { id: "msg_9" } }, 201);
    const client = createTestClient(fetchMock);
    expect(
      await client.createActivityMessage({ ...target, body: "activity", kind, turnId: "t1" }),
    ).toMatchObject({ id: "msg_9" });
    expectRequest(fetchMock.mock.calls, 1, path, "POST", { body: "activity", kind, turn_id: "t1" });
  });

  it("serializes retry nonces and reads persisted attachments", async () => {
    const fetchMock = jsonResponses(
      { message: { id: "msg_retry" } },
      { message: { id: "msg_retry", attachments: [{ id: "upl_1" }] } },
    );
    const client = createTestClient(fetchMock);

    await client.createChannelMessage("chn_1", "retry-safe", { nonce: "media-queue-1" });
    const persisted = await client.message("msg_retry");

    expect(requestBodyJson(fetchMock.mock.calls[0]?.[1])).toEqual({
      body: "retry-safe",
      nonce: "media-queue-1",
    });
    expectRequest(fetchMock.mock.calls, 2, "messages/msg_retry");
    expect(persisted.attachments).toEqual([{ id: "upl_1" }]);
  });

  it("uploads multipart bytes with filename and MIME, then attaches by id", async () => {
    const NativeBlob = Blob;
    let uploadBlobPart: BlobPart | undefined;
    class CapturingBlob extends NativeBlob {
      constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
        uploadBlobPart = parts?.[0];
        super(parts, options);
      }
    }
    const fetchMock = jsonResponses({ upload: { id: "upl_1" } }, { ok: true });
    const client = createTestClient(fetchMock);

    const uploadBuffer = Buffer.from("const proof = true;");
    vi.stubGlobal("Blob", CapturingBlob);
    const upload = await client
      .createUpload({
        workspaceId: "wsp_1",
        buffer: uploadBuffer,
        filename: "viewer-proof.ts",
        contentType: "text/typescript",
        nonce: "upload-queue-1",
      })
      .finally(() => vi.unstubAllGlobals());
    await client.attachUpload("msg_1", upload.id);

    expect(uploadBlobPart).toBeInstanceOf(Uint8Array);
    const uploadBytes = uploadBlobPart as Uint8Array;
    expect(uploadBytes.buffer).toBe(uploadBuffer.buffer);
    expect(uploadBytes).toMatchObject({
      byteOffset: uploadBuffer.byteOffset,
      byteLength: uploadBuffer.byteLength,
    });
    const uploadRequest = fetchMock.mock.calls[0];
    expect(uploadRequest?.[0]).toBe(
      "https://clickclack.example/api/uploads?workspace_id=wsp_1&nonce=upload-queue-1",
    );
    const uploadInit = uploadRequest?.[1] as RequestInit;
    expect(uploadInit.method).toBe("POST");
    expect(uploadInit.body).toBeInstanceOf(FormData);
    const uploadHeaders = new Headers(uploadInit.headers);
    expect(uploadHeaders.get("Authorization")).toBe("Bearer fake");
    expect(uploadHeaders.has("Content-Type")).toBe(false);
    const file = (uploadInit.body as FormData).get("file");
    expect(file).toBeInstanceOf(File);
    expect(file).toMatchObject({ name: "viewer-proof.ts", type: "text/typescript" });
    expect(await (file as File).text()).toBe("const proof = true;");
    expectRequest(fetchMock.mock.calls, 2, "messages/msg_1/attachments", "POST", {
      upload_id: "upl_1",
    });
  });

  it.each([
    { kind: "upload", nonce: "upload-queue-1", found: { id: "upl_1", nonce: "upload-queue-1" } },
    {
      kind: "message",
      nonce: "message-queue-1",
      found: { id: "msg_1", attachments: [{ id: "upl_1" }] },
    },
  ] as const)(
    "looks up $kind nonces and distinguishes absent, unsupported, and failed",
    async ({ kind, nonce, found }) => {
      const fetchMock = nonceResponses(kind === "upload" ? "Upload" : "Message", { [kind]: found });
      const client = createTestClient(fetchMock);
      const find = (value: string) =>
        kind === "upload"
          ? client.findUploadByNonce({ workspaceId: "wsp_1", nonce: value })
          : client.findMessageByNonce({ workspaceId: "wsp_1", nonce: value });
      await expect(find(nonce)).resolves.toEqual(expect.objectContaining(found));
      await expectNonceErrors(find, kind);
      expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(
        [nonce, "missing", "unsupported", "broken"].map(
          (value) =>
            `https://clickclack.example/api/${kind}s/by-nonce?workspace_id=wsp_1&nonce=${value}`,
        ),
      );
    },
  );

  it("rejects activity rows without a channel or conversation target", async () => {
    const fetchMock = vi.fn();
    const client = createTestClient(fetchMock);

    await expect(
      client.createActivityMessage({ body: "orphan row", kind: "agent_commentary" }),
    ).rejects.toThrow("createActivityMessage requires a channelId or conversationId");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("PATCHes message bodies for activity row coalescing", async () => {
    const fetchMock = jsonFetch({ message: { id: "msg_9", body: "longer" } }, 200);
    await createTestClient(fetchMock).updateMessageBody("msg_9", "longer");
    expectRequest(fetchMock.mock.calls, 1, "messages/msg_9", "PATCH", { body: "longer" });
  });

  it("POSTs ephemeral agent progress frames to the realtime endpoint", async () => {
    const fetchMock = jsonFetch({ event: { id: "evt_1" } }, 202);
    const client = createTestClient(fetchMock, { token: "placeholder" });

    await client.publishEphemeral({
      workspaceId: "wsp_1",
      channelId: "chn_1",
      type: "agent.progress",
      payload: { op: "append", turn_id: "msg_1" },
    });

    expectRequest(fetchMock.mock.calls, 1, "realtime/ephemeral", "POST", {
      workspace_id: "wsp_1",
      channel_id: "chn_1",
      type: "agent.progress",
      payload: { op: "append", turn_id: "msg_1" },
    });
  });

  it("aborts a stalled ephemeral request", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), delay);
      return controller.signal;
    });
    try {
      const fetchMock = vi.fn(
        async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              },
              { once: true },
            );
          }),
      );
      const client = createTestClient(fetchMock, { token: "placeholder" });

      const pending = client.publishEphemeral({
        workspaceId: "wsp_1",
        channelId: "chn_1",
        type: "agent.progress",
      });
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(15_000);

      await rejected;
      expect(timeout).toHaveBeenCalledWith(15_000);
      expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeDefined();
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("createClickClackClient websocket", () => {
  async function runFrameCase(frame: string): Promise<{ delivered: boolean; error?: string }> {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => {
      wss.once("listening", () => resolve());
    });
    const address = wss.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback ws address");
    }
    wss.on("connection", (server) => server.send(frame));
    const client = createClickClackClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "fake",
    });
    const socket = client.websocket("ws-1");
    try {
      return await new Promise<{ delivered: boolean; error?: string }>((resolve) => {
        socket.on("message", () => resolve({ delivered: true }));
        socket.on("error", (error) => resolve({ delivered: false, error: error.message }));
      });
    } finally {
      socket.terminate();
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }

  it.each([
    ["accepts a valid frame above the request limit", CLICKCLACK_REQUEST_BODY_LIMIT_BYTES, true],
    ["rejects a frame above the inbound limit", CLICKCLACK_INBOUND_JSON_LIMIT_BYTES + 1, false],
  ] as const)("%s", async (_label, size, delivered) => {
    // Accepted request payloads grow when the server wraps them as events.
    const frame = delivered
      ? JSON.stringify({
          id: "evt-1",
          cursor: "cursor-1",
          type: "agent.progress",
          workspace_id: "workspace-1",
          created_at: "2026-07-09T00:00:00Z",
          payload: { line: { text: "x".repeat(size) } },
        })
      : "x".repeat(size);
    if (delivered) {
      expect(Buffer.byteLength(frame)).toBeGreaterThan(CLICKCLACK_REQUEST_BODY_LIMIT_BYTES);
    }
    const result = await runFrameCase(frame);
    expect(result.delivered).toBe(delivered);
    if (!delivered) {
      expect(result.error).toMatch(/max payload/i);
    }
  });
});

it.each([false, true])(
  "rechecks the message caller after effect preparation (retired=%s)",
  async (retired) => {
    const preparing = createDeferred();
    const prepared = createDeferred();
    const dispatched = createDeferred();
    const response = createDeferred<Response>();
    const caller = new AbortController();
    const failure = new Error("ClickClack caller retired");
    effectGate.prepare = async () => {
      preparing.resolve();
      await prepared.promise;
    };
    const fetch = vi.fn<typeof globalThis.fetch>(() => {
      dispatched.resolve();
      return response.promise;
    });
    const client = createTestClient(fetch, {
      beforeRequest: () => caller.signal.throwIfAborted(),
    });
    const sending = client.createChannelMessage("chn_1", "hello").then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await Promise.race([
        preparing.promise,
        dispatched.promise.then(() => {
          throw new Error("dispatched before preparation");
        }),
      ]);
      expect(fetch).not.toHaveBeenCalled();
      if (retired) {
        caller.abort(failure);
      }
      prepared.resolve();
      if (!retired) {
        await dispatched.promise;
        caller.abort(failure);
      }
      response.resolve(Response.json({ message: { id: "msg_1" } }));
      expect(await sending).toEqual(retired ? { error: failure } : { value: { id: "msg_1" } });
      expect(fetch).toHaveBeenCalledTimes(retired ? 0 : 1);
    } finally {
      prepared.resolve();
      response.resolve(Response.json({ message: { id: "msg_1" } }));
      await sending;
      effectGate.prepare = undefined;
    }
  },
);
