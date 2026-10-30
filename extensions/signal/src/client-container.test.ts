import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as fetchModule from "openclaw/plugin-sdk/fetch-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createClosedChunkStream,
  createStreamingResponse,
} from "../../test-support/streaming-error-response.js";
import { containerCheck, containerRpcRequest } from "./client-container.js";
import { expectPreparedHandoff, useSignalHttpServer } from "./client.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
describe("container mocked responses", () => {
  const account = "+14259798283";
  const recipient = ["+15550001111"];
  const timestamp = 1700000000000;
  const baseUrl = "http://localhost:8080";
  const mockFetch = vi.fn<typeof fetch>();
  type Options = Omit<Parameters<typeof containerRpcRequest>[2], "baseUrl">;
  const rpc = (method: string, params?: Record<string, unknown>, options: Options = {}) =>
    containerRpcRequest(method, params, { baseUrl, ...options });
  const attachment = (options: Options = {}) =>
    rpc("getAttachment", { id: "path/with/slashes" }, options);
  const respond = (value: unknown = {}) => mockFetch.mockResolvedValue(Response.json(value));
  const respondBody = (body: BodyInit | null, init?: ResponseInit) => {
    const response = new Response(body, init);
    mockFetch.mockResolvedValue(response);
    return response;
  };
  const send = (params: Record<string, unknown>, options: Options = {}) =>
    rpc("send", { account, recipient, ...params }, options);
  function expectPayload(endpoint: string, method: string, body: unknown) {
    expect(request()).toMatchObject({ url: `${baseUrl}/v1/${endpoint}/%2B14259798283`, method });
    expect(payload()).toEqual(body);
  }
  const request = () => ({ url: mockFetch.mock.calls[0]?.[0], ...mockFetch.mock.calls[0]?.[1] });
  function payload(): unknown {
    const { body } = request();
    if (typeof body !== "string") {
      throw new Error("expected a JSON request body");
    }
    return JSON.parse(body);
  }
  async function file(name: string, bytes: number) {
    const path = join(tempDirs.make("signal-container-"), name);
    await writeFile(path, Buffer.alloc(bytes));
    return path;
  }
  beforeEach(() => {
    mockFetch.mockReset();
    vi.spyOn(fetchModule, "resolveFetch").mockReturnValue(mockFetch);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("reports a network failure", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));
    await expect(containerCheck(baseUrl)).resolves.toEqual({
      ok: false,
      status: null,
      error: "Network error",
    });
  });
  it.each([
    ["   ", "Signal base URL is required"],
    ["http://user:pass@localhost:8080", "Signal base URL must not include credentials"],
  ])("rejects invalid base URL %s", async (url, error) => {
    await expect(containerCheck(url)).rejects.toThrow(error);
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it.each([
    { operation: "health", status: 200, expected: { ok: true, status: 200, error: null } },
    { operation: "health", status: 503, expected: { ok: false, status: 503, error: "HTTP 503" } },
    { operation: "attachment", status: 404, expected: { data: undefined } },
  ])(
    "does not wait for unread body cancellation: $operation HTTP $status",
    async ({ operation, status, expected }) => {
      vi.useFakeTimers();
      const release = createDeferred<void>();
      const cancel = vi.fn(() => release.promise);
      respondBody(
        new ReadableStream({
          start: (controller) => controller.enqueue(new Uint8Array([0xff])),
          cancel,
        }),
        { status },
      );
      const settled = vi.fn();
      const healthUrl = status === 200 ? "localhost:8080/" : "https://signal.example.com";
      const result = (
        operation === "health" ? containerCheck(healthUrl, 25) : attachment({ timeoutMs: 25 })
      ).then(settled);
      try {
        await vi.advanceTimersByTimeAsync(25);
        expect(cancel).toHaveBeenCalledOnce();
        expect(settled).toHaveBeenCalledWith(expected);
        if (operation === "health") {
          expect(request().url).toBe(`${status === 200 ? baseUrl : healthUrl}/v1/about`);
        }
      } finally {
        release.resolve();
        await result;
      }
    },
  );
  it.each([
    { status: 500, text: "x".repeat(20_000), error: `Signal REST 500: ${"x".repeat(16 * 1024)}` },
    { status: 500, text: "", error: "Signal REST 500: Internal Server Error" },
    { status: 200, text: "not-valid-json", error: "Signal REST returned malformed JSON" },
    {
      status: 200,
      text: '{"timestamp":"0x18bcfe56800"}',
      error: "Signal REST send returned invalid timestamp",
    },
  ])("bounds and reports REST response %#", async ({ status, text, error }) => {
    respondBody(text, { status, statusText: "Internal Server Error" });
    await expect(rpc("send")).rejects.toThrow(error);
  });
  it("accepts an empty success body", async () => {
    respondBody("");
    await expect(rpc("version")).resolves.toBeUndefined();
  });
  it("preserves the deadline error for slow-drip non-ok bodies", async () => {
    vi.useFakeTimers();
    let drip: ReturnType<typeof setInterval>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        drip = setInterval(() => controller.enqueue(new Uint8Array([32])), 10);
      },
      cancel() {
        clearInterval(drip);
      },
    });
    respondBody(body, { status: 503 });
    const result = expect(rpc("version", undefined, { timeoutMs: 25 })).rejects.toThrow(
      "Signal REST request timed out",
    );
    await vi.advanceTimersByTimeAsync(25);
    await result;
    expect(request().signal?.aborted).toBe(true);
  });
  it("cancels oversized success streams without draining them", async () => {
    const oversized = createStreamingResponse({ chunkCount: 20, chunkSize: 1024 * 1024 });
    mockFetch.mockResolvedValue(oversized.response);
    await expect(rpc("version")).rejects.toThrow(/exceeds \d+ bytes/);
    expect(oversized.getReadCount()).toBeLessThan(20);
    expect(oversized.wasCanceled()).toBe(true);
  });
  it.each([false, true])(
    "prepares the REST handoff and rechecks its caller after waiting (revoked=%s)",
    (revoked) =>
      expectPreparedHandoff(revoked, async ({ arrive, response, assertHandoff }) => {
        const result = { timestamp: 1700000000000 };
        mockFetch.mockImplementation(async () => {
          arrive();
          await response;
          return Response.json(result);
        });
        return {
          send: () => send({ message: "prepared" }, { assertDirectAdapterHandoff: assertHandoff }),
          assertCount: (count) => expect(mockFetch).toHaveBeenCalledTimes(count),
          result,
        };
      }),
  );

  it.each([
    {
      name: "styled text with literal markers and backslashes",
      result: {},
      input: { message: "Bold * C:\\Temp\\file and /foo\\bar/", "text-style": ["0:4:BOLD"] },
      output: { message: "**Bold** \\* C:\\Temp\\file and /foo\\bar/", text_mode: "styled" },
    },
    {
      name: "native quote and UUID author",
      result: { timestamp: String(timestamp) },
      input: {
        message: "reply",
        quoteTimestamp: timestamp - 1,
        quoteAuthor: "uuid:author-uuid",
        quoteMessage: "original",
      },
      output: {
        message: "reply",
        quote_timestamp: timestamp - 1,
        quote_author: "author-uuid",
        quote_message: "original",
      },
    },
  ])("translates $name", async ({ input, output, result }) => {
    respond(result);
    await expect(send(input)).resolves.toEqual(result.timestamp ? { timestamp } : {});
    expect(payload()).toEqual({ number: account, recipients: recipient, ...output });
  });
  it("applies one attachment budget to the whole request", async () => {
    const attachments = [await file("first.bin", 6), await file("second.bin", 6)];
    await expect(send({ attachments }, { maxAttachmentBytes: 10 })).rejects.toThrow(
      "exceeds 4 bytes",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it.each([
    { params: { recipient }, method: "PUT", target: "+15550001111" },
    {
      params: { groupId: "group-123", stop: true },
      method: "DELETE",
      target: "group.Z3JvdXAtMTIz",
    },
  ])("translates $method typing", async ({ params, method, target }) => {
    respondBody(null, { status: 204 });
    await expect(rpc("sendTyping", { account, ...params })).resolves.toBeUndefined();
    expectPayload("typing-indicator", method, { recipient: target });
  });
  it("sends a read receipt", async () => {
    respondBody(null, { status: 204 });
    await expect(
      rpc("sendReceipt", { account, recipient, targetTimestamp: 1700000000000 }),
    ).resolves.toBeUndefined();
    expectPayload("receipts", "POST", {
      recipient: "+15550001111",
      timestamp: 1700000000000,
      receipt_type: "read",
    });
  });
  it.each([
    {
      groupIds: ["group-123"],
      remove: false,
      method: "POST",
      target: { recipient: "group.Z3JvdXAtMTIz", group_id: "group.Z3JvdXAtMTIz" },
    },
    { groupIds: undefined, remove: true, method: "DELETE", target: { recipient: "author-uuid" } },
  ])("translates a $method reaction", async ({ groupIds, remove, method, target }) => {
    respond({ timestamp: 1700000000000 });
    await expect(
      rpc("sendReaction", {
        account,
        recipients: ["uuid:author-uuid"],
        groupIds,
        remove,
        emoji: "👍",
        targetAuthor: remove ? undefined : "uuid:author-uuid",
        targetTimestamp: 1699999999999,
      }),
    ).resolves.toEqual({ timestamp: 1700000000000 });
    expectPayload("reactions", method, {
      ...target,
      reaction: "👍",
      target_author: "author-uuid",
      timestamp: 1699999999999,
    });
  });
  it("encodes the attachment path and returns base64 bytes", async () => {
    respondBody(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    await expect(attachment()).resolves.toEqual({ data: "iVBORw==" });
    expect(request()).toMatchObject({
      url: `${baseUrl}/v1/attachments/path%2Fwith%2Fslashes`,
      method: "GET",
    });
  });
  it.each([true, false])(
    "rejects oversized attachments (content-length=%s)",
    async (lengthHeader) => {
      const body = createClosedChunkStream([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]);
      const response = respondBody(
        body,
        lengthHeader ? { headers: { "content-length": "5" } } : undefined,
      );
      const read = vi.spyOn(response.body!, "getReader");
      await expect(attachment({ maxResponseBytes: 4 })).rejects.toThrow(
        "Signal REST attachment exceeded size limit",
      );
      if (lengthHeader) {
        expect(read).not.toHaveBeenCalled();
      }
    },
  );
});

describe("container REST real server", () => {
  const startServer = useSignalHttpServer();
  const params = { account: "+15550001111", recipient: ["+15551234567"], message: "Photo" };
  afterEach(() => vi.restoreAllMocks());
  it("rejects malformed UTF-8 before JSON parsing", async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(Buffer.from('{"versions":["\xff"]}', "latin1"));
    });
    await expect(containerRpcRequest("version", undefined, { baseUrl })).rejects.toBeInstanceOf(
      TypeError,
    );
  });
  it("aborts an unfinished response at its deadline and closes the connection", async () => {
    let flushed = false;
    let closed = false;
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{", (error) => {
        flushed = !error;
      });
      const drip = setInterval(() => res.write(" "), 50);
      res.on("close", () => {
        clearInterval(drip);
        closed = true;
      });
    });
    const start = Date.now();
    await expect(
      containerRpcRequest("version", undefined, { baseUrl, timeoutMs: 300 }),
    ).rejects.toThrow("Signal REST request timed out");
    expect(flushed).toBe(true);
    expect(Date.now() - start).toBeLessThan(2_000);
    await expect.poll(() => closed).toBe(true);
  });
  it("posts a provider-safe original attachment filename and intact bytes", async () => {
    let received: unknown;
    const baseUrl = await startServer(async (req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/v2/send");
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(201, { "content-type": "application/json" });
      res.end('{"timestamp":"1735689600000"}');
    });
    const content = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const file = join(
      tempDirs.make("signal-filename-"),
      "mixed;semi;comma,comma,hash#name---a1b2c3d4-5678-90ab-cdef-1234567890ab.jpg",
    );
    await writeFile(file, content);
    await expect(
      containerRpcRequest(
        "send",
        { ...params, attachments: [file] },
        { baseUrl, timeoutMs: 1_000 },
      ),
    ).resolves.toEqual({ timestamp: 1735689600000 });
    const dataUri = "data:image/jpeg;filename=mixed_semi_comma_comma_hash_name.jpg;base64,/9j/4A==";
    expect(received).toEqual({
      message: params.message,
      number: params.account,
      recipients: params.recipient,
      base64_attachments: [dataUri],
    });
  });
});
