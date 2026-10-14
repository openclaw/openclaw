import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as fetchModule from "openclaw/plugin-sdk/fetch-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { containerCheck, containerRpcRequest } from "./client-container.js";

const account = "+14259798283";
const recipient = ["+15550001111"];
const baseUrl = "http://localhost:8080";
const mockFetch = vi.fn<typeof fetch>();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type Options = Omit<Parameters<typeof containerRpcRequest>[2], "baseUrl">;
const rpc = (method: string, params?: Record<string, unknown>, options: Options = {}) =>
  containerRpcRequest(method, params, { baseUrl, ...options });
const attachment = (options: Options = {}) =>
  rpc("getAttachment", { id: "path/with/slashes" }, options);
const respond = (value: unknown = {}) => mockFetch.mockResolvedValue(Response.json(value));
function request() {
  const call = mockFetch.mock.calls[0];
  if (!call?.[1]) {
    throw new Error("expected a fetch request");
  }
  return { url: call[0], ...call[1] };
}
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

describe("container health", () => {
  it("normalizes the endpoint and cancels the unused health body", async () => {
    const response = new Response(new Uint8Array([0xff]));
    const cancel = vi.spyOn(response.body!, "cancel");
    mockFetch.mockResolvedValue(response);
    await expect(containerCheck("localhost:8080/")).resolves.toEqual({
      ok: true,
      status: 200,
      error: null,
    });
    expect(request().url).toBe(`${baseUrl}/v1/about`);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("reports a failed health status", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 404 }));
    await expect(containerCheck("https://signal.example.com")).resolves.toEqual({
      ok: false,
      status: 404,
      error: "HTTP 404",
    });
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
});

describe("discarded container responses", () => {
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
      mockFetch.mockResolvedValue(new Response(new ReadableStream({ cancel }), { status }));
      const settled = vi.fn();
      const result = (
        operation === "health" ? containerCheck(baseUrl, 25) : attachment({ timeoutMs: 25 })
      ).then(settled);
      try {
        await vi.advanceTimersByTimeAsync(25);
        expect(cancel).toHaveBeenCalledOnce();
        expect(settled).toHaveBeenCalledWith(expected);
      } finally {
        release.resolve();
        await result;
      }
    },
  );
});

describe("container REST responses", () => {
  it.each([
    { status: 500, text: "x".repeat(20_000), error: `Signal REST 500: ${"x".repeat(16 * 1024)}` },
    { status: 500, text: "", error: "Signal REST 500: Internal Server Error" },
    { status: 200, text: "not-valid-json", error: "Signal REST returned malformed JSON" },
  ])("bounds and reports REST response %#", async ({ status, text, error }) => {
    mockFetch.mockResolvedValue(
      new Response(text, { status, statusText: "Internal Server Error" }),
    );
    await expect(rpc("send")).rejects.toThrow(error);
  });
  it("accepts an empty success body", async () => {
    mockFetch.mockResolvedValue(new Response(""));
    await expect(rpc("version")).resolves.toBeUndefined();
  });
  it("preserves the deadline error for slow-drip non-ok bodies", async () => {
    vi.useFakeTimers();
    const timers: ReturnType<typeof setTimeout>[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const [index, text] of ["{", '"error"', ':"busy"', "}"].entries()) {
          timers.push(
            setTimeout(() => controller.enqueue(new TextEncoder().encode(text)), 10 + index * 20),
          );
        }
      },
      cancel() {
        timers.forEach(clearTimeout);
      },
    });
    mockFetch.mockResolvedValue(new Response(body, { status: 503 }));
    const result = expect(rpc("version", undefined, { timeoutMs: 25 })).rejects.toThrow(
      "Signal REST request timed out",
    );
    await vi.advanceTimersByTimeAsync(25);
    await result;
    expect(request().signal?.aborted).toBe(true);
  });
  it("cancels oversized success streams without draining them", async () => {
    let emitted = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted === 20) {
          controller.close();
          return;
        }
        emitted++;
        controller.enqueue(chunk);
      },
    });
    mockFetch.mockResolvedValue(new Response(body));
    await expect(rpc("version")).rejects.toThrow(/exceeds \d+ bytes/);
    expect(emitted).toBeLessThan(20);
  });
});

describe("container send payloads", () => {
  it.each([false, true])(
    "prepares the REST handoff and rechecks its caller after waiting (revoked=%s)",
    async (revoked) => {
      const preparing = createDeferred<void>();
      const prepared = createDeferred<void>();
      const arrived = createDeferred<void>();
      const response = createDeferred<Response>();
      const authority = fetchModule.captureEffectAuthority();
      vi.spyOn(fetchModule, "captureEffectAuthority").mockReturnValue({
        ...authority,
        async initiate(effect) {
          preparing.resolve();
          await prepared.promise;
          return authority.initiate(effect);
        },
      });
      mockFetch.mockImplementation(() => {
        arrived.resolve();
        return response.promise;
      });
      const caller = new AbortController();
      const failure = new Error("Signal caller ended during preparation");
      const sending = rpc(
        "send",
        { account, recipient, message: "prepared" },
        {
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
            throw new Error("REST request bypassed preparation");
          }),
        ]);
        expect(mockFetch).not.toHaveBeenCalled();
        if (revoked) {
          caller.abort(failure);
        }
        prepared.resolve();
        if (!revoked) {
          await arrived.promise;
          response.resolve(Response.json({ timestamp: 1700000000000 }));
        }
        expect(await sending).toEqual(
          revoked ? { error: failure } : { value: { timestamp: 1700000000000 } },
        );
        expect(mockFetch).toHaveBeenCalledTimes(revoked ? 0 : 1);
      } finally {
        prepared.resolve();
        response.resolve(Response.json({ timestamp: 1700000000000 }));
        await sending;
      }
    },
  );

  it("rejects a non-decimal send timestamp", async () => {
    respond({ timestamp: "0x18bcfe56800" });
    await expect(rpc("send", { account, recipient, message: "Hello" })).rejects.toThrow(
      "Signal REST send returned invalid timestamp",
    );
  });
  it("renders styled text while preserving literal markers and backslashes", async () => {
    respond();
    await rpc("send", {
      account,
      recipient,
      message: "Bold * C:\\Temp\\file and /foo\\bar/",
      "text-style": ["0:4:BOLD"],
    });
    expect(payload()).toEqual({
      number: account,
      recipients: recipient,
      message: "**Bold** \\* C:\\Temp\\file and /foo\\bar/",
      text_mode: "styled",
    });
  });
  it("translates a native quote and strips its author's uuid prefix", async () => {
    respond({ timestamp: "1700000000000" });
    await expect(
      rpc("send", {
        account,
        recipient,
        message: "reply",
        quoteTimestamp: 1699999999999,
        quoteAuthor: "uuid:author-uuid",
        quoteMessage: "original",
      }),
    ).resolves.toEqual({ timestamp: 1700000000000 });
    expect(payload()).toEqual({
      number: account,
      recipients: recipient,
      message: "reply",
      quote_timestamp: 1699999999999,
      quote_author: "author-uuid",
      quote_message: "original",
    });
  });
  it("applies one attachment budget to the whole request", async () => {
    const attachments = [await file("first.bin", 6), await file("second.bin", 6)];
    await expect(
      rpc("send", { account, recipient, attachments }, { maxAttachmentBytes: 10 }),
    ).rejects.toThrow("exceeds 4 bytes");
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
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(rpc("sendTyping", { account, ...params })).resolves.toBeUndefined();
    expect(request()).toMatchObject({
      url: `${baseUrl}/v1/typing-indicator/%2B14259798283`,
      method,
    });
    expect(payload()).toEqual({ recipient: target });
  });
  it("sends a read receipt", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(
      rpc("sendReceipt", { account, recipient, targetTimestamp: 1700000000000 }),
    ).resolves.toBeUndefined();
    expect(request()).toMatchObject({
      url: `${baseUrl}/v1/receipts/%2B14259798283`,
      method: "POST",
    });
    expect(payload()).toEqual({
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
    expect(request()).toMatchObject({ url: `${baseUrl}/v1/reactions/%2B14259798283`, method });
    expect(payload()).toEqual({
      ...target,
      reaction: "👍",
      target_author: "author-uuid",
      timestamp: 1699999999999,
    });
  });
});

describe("container attachments", () => {
  it("encodes the attachment path and returns base64 bytes", async () => {
    mockFetch.mockResolvedValue(new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47])));
    await expect(attachment()).resolves.toEqual({ data: "iVBORw==" });
    expect(request()).toMatchObject({
      url: `${baseUrl}/v1/attachments/path%2Fwith%2Fslashes`,
      method: "GET",
    });
  });
  it("cancels a missing attachment response", async () => {
    const response = new Response("missing", { status: 404 });
    const cancel = vi.spyOn(response.body!, "cancel");
    mockFetch.mockResolvedValue(response);
    await expect(attachment()).resolves.toEqual({ data: undefined });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects oversized content-length before reading bytes", async () => {
    const response = new Response(new Uint8Array(5), { headers: { "content-length": "5" } });
    const read = vi.spyOn(response.body!, "getReader");
    mockFetch.mockResolvedValue(response);
    await expect(attachment({ maxResponseBytes: 4 })).rejects.toThrow(
      "Signal REST attachment exceeded size limit",
    );
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects streamed attachments above the response cap", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
        controller.close();
      },
    });
    mockFetch.mockResolvedValue(new Response(body));
    await expect(attachment({ maxResponseBytes: 4 })).rejects.toThrow(
      "Signal REST attachment exceeded size limit",
    );
  });
  it("times out a stalled attachment within the request deadline", async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue(new Response(new ReadableStream<Uint8Array>()));
    const result = expect(attachment({ timeoutMs: 25 })).rejects.toThrow(
      /Signal REST (attachment response body stalled after 25ms|request timed out)/,
    );
    await vi.advanceTimersByTimeAsync(25);
    await result;
    expect(request().signal).toBeInstanceOf(AbortSignal);
  });
});
