import * as fetchModule from "openclaw/plugin-sdk/fetch-runtime";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { containerCheck, containerRpcRequest } from "./client-container.js";

type ContainerRpcOptions = Parameters<typeof containerRpcRequest>[2];

function rpc<T = unknown>(
  method: string,
  params?: Record<string, unknown>,
  options: Omit<ContainerRpcOptions, "baseUrl"> = {},
): Promise<T> {
  return containerRpcRequest<T>(method, params, { baseUrl: "http://localhost:8080", ...options });
}

function attachment(id: string, options: Omit<ContainerRpcOptions, "baseUrl"> = {}) {
  return rpc<{ data?: string }>("getAttachment", { id }, options);
}

// spyOn approach works with vitest forks pool for cross-directory imports
const mockFetch = vi.fn();

// Build Response-like `body` streams so production code exercises bounded readers instead
// of unbounded res.text()/arrayBuffer(). Kept local to avoid touching shared HTTP mocks.
function bodyStream(text: string): { body: ReadableStream<Uint8Array> } {
  const bytes = new TextEncoder().encode(text);
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        if (bytes.byteLength > 0) {
          controller.enqueue(bytes);
        }
        controller.close();
      },
    }),
  };
}

function mockJsonResponse(value: unknown = {}, status = 200): void {
  mockFetch.mockResolvedValue({ ok: true, status, ...bodyStream(JSON.stringify(value)) });
}

function stalledBodyStream(): { body: ReadableStream<Uint8Array> } {
  return {
    body: new ReadableStream<Uint8Array>(),
  };
}

function delayedBodyStream(
  chunks: Array<{ delayMs: number; text: string }>,
  closeDelayMs = 1,
): { body: ReadableStream<Uint8Array> } {
  const encoder = new TextEncoder();
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        let elapsedMs = 0;
        for (const chunk of chunks) {
          elapsedMs += chunk.delayMs;
          setTimeout(() => controller.enqueue(encoder.encode(chunk.text)), elapsedMs);
        }
        setTimeout(() => controller.close(), elapsedMs + closeDelayMs);
      },
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(fetchModule, "resolveFetch").mockReturnValue(mockFetch as unknown as typeof fetch);
});

function requireFetchCall(index = 0): [RequestInfo | URL, RequestInit] {
  const call = mockFetch.mock.calls[index];
  if (!call) {
    throw new Error(`expected fetch call ${index}`);
  }
  return call as [RequestInfo | URL, RequestInit];
}

function expectFetchCall(index: number, url: string, method?: string): RequestInit {
  const [actualUrl, init] = requireFetchCall(index);
  expect(actualUrl).toBe(url);
  if (method) {
    expect(init.method).toBe(method);
  }
  return init;
}

function expectFirstFetchCall(url: string, method?: string): RequestInit {
  return expectFetchCall(0, url, method);
}

function parseFetchBody(index = 0): Record<string, unknown> {
  const init = requireFetchCall(index)[1];
  if (typeof init.body !== "string") {
    throw new Error(`expected fetch call ${index} body to be a string`);
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("containerCheck", () => {
  it("cancels /v1/about response bodies after simple health checks", async () => {
    const cancel = vi.fn(async () => undefined);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: { cancel },
    });

    await expect(containerCheck("http://localhost:8080")).resolves.toEqual({
      ok: true,
      status: 200,
      error: null,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("returns ok:false when /v1/about returns 404", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
    });

    const result = await containerCheck("http://localhost:8080");
    expect(result).toEqual({ ok: false, status: 404, error: "HTTP 404" });
  });

  it("returns ok:false with error message on fetch failure", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));

    const result = await containerCheck("http://localhost:8080");
    expect(result).toEqual({ ok: false, status: null, error: "Network error" });
  });

  it("normalizes base URL by removing trailing slash", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await containerCheck("http://localhost:8080/");
    expectFirstFetchCall("http://localhost:8080/v1/about");
  });

  it("adds http:// prefix when missing", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await containerCheck("localhost:8080");
    expectFirstFetchCall("http://localhost:8080/v1/about");
  });
});

describe("containerRestRequest", () => {
  it("makes GET request with correct endpoint", async () => {
    mockJsonResponse({ version: "1.0" });

    const result = await rpc("version");
    expect(result).toEqual({ version: "1.0" });
    const init = expectFirstFetchCall("http://localhost:8080/v1/about", "GET");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("parses 201 response bodies", async () => {
    mockJsonResponse({ timestamp: 1700000000000 }, 201);

    const result = await rpc("send");
    expect(result).toEqual({ timestamp: 1700000000000 });
  });

  it("bounds REST error response bodies before reporting failures", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      ...bodyStream("x".repeat(20_000)),
    });

    await expect(rpc("send", undefined)).rejects.toThrow(
      `Signal REST 500: ${"x".repeat(16 * 1024)}`,
    );
  });

  it("preserves the deadline error for stalled REST error bodies", async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      mockFetch.mockImplementation(async (_url, init: RequestInit) => {
        observedSignal = init.signal ?? undefined;
        return new Response(stalledBodyStream().body, {
          status: 500,
          statusText: "Internal Server Error",
        });
      });

      const request = rpc("send", undefined, {
        timeoutMs: 25,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(observedSignal).toBeInstanceOf(AbortSignal);
      const requestRejection = expect(request).rejects.toThrow("Signal REST request timed out");

      await vi.advanceTimersByTimeAsync(25);
      await requestRejection;
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles empty response body", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      ...bodyStream(""),
    });

    const result = await rpc("version");
    expect(result).toBeUndefined();
  });

  it("caps oversized REST request timeouts before arming abort timers", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        ...bodyStream("{}"),
      });

      await rpc("version", undefined, {
        timeoutMs: Number.MAX_SAFE_INTEGER,
      });

      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
      expect(requireFetchCall()[1].signal).toBeInstanceOf(AbortSignal);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("rejects slow-drip REST bodies that exceed the overall timeout without idling", async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      mockFetch.mockImplementation(async (_url, init: RequestInit) => {
        observedSignal = init.signal ?? undefined;
        return new Response(
          delayedBodyStream([
            { delayMs: 5, text: "{" },
            { delayMs: 5, text: '"ok"' },
            { delayMs: 5, text: ":true" },
            { delayMs: 20, text: "}" },
          ]).body,
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      });

      const request = rpc<{ ok: boolean }>("version", undefined, {
        timeoutMs: 25,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(observedSignal?.aborted).toBe(false);
      const requestRejection = expect(request).rejects.toThrow("Signal REST request timed out");
      await vi.advanceTimersByTimeAsync(25);
      await requestRejection;
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the deadline error for slow-drip non-ok bodies", async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      mockFetch.mockImplementation(async (_url, init: RequestInit) => {
        observedSignal = init.signal ?? undefined;
        return new Response(
          delayedBodyStream([
            { delayMs: 10, text: "{" },
            { delayMs: 20, text: '"error"' },
            { delayMs: 20, text: ':"busy"' },
            { delayMs: 20, text: "}" },
          ]).body,
          { status: 503, statusText: "Service Unavailable" },
        );
      });

      const request = rpc("version", undefined, {
        timeoutMs: 25,
      });

      await vi.advanceTimersByTimeAsync(0);
      const requestRejection = expect(request).rejects.toThrow("Signal REST request timed out");
      await vi.advanceTimersByTimeAsync(25);
      await requestRejection;
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("containerSendMessage", () => {
  it.each(["0x18bcfe56800", "1700000000000.5"])(
    "rejects non-decimal integer send timestamp %s",
    async (timestamp) => {
      mockJsonResponse({ timestamp });

      await expect(
        rpc("send", {
          account: "+14259798283",
          recipient: ["+15550001111"],
          message: "Hello world",
        }),
      ).rejects.toThrow("Signal REST send returned invalid timestamp");
    },
  );

  it("uses container styled text mode when styles are provided", async () => {
    mockJsonResponse({});

    await rpc("send", {
      account: "+14259798283",
      recipient: ["+15550001111"],
      message: "Bold text",
      "text-style": ["0:4:BOLD"],
    });

    const body = parseFetchBody();
    expect(body.message).toBe("**Bold** text");
    expect(body.text_mode).toBe("styled");
    expect(body).not.toHaveProperty("text_style");
  });

  it("escapes unstyled formatting markers in styled container messages", async () => {
    mockJsonResponse({});

    await rpc("send", {
      account: "+14259798283",
      recipient: ["+15550001111"],
      message: "Bold * not italic",
      "text-style": ["0:4:BOLD"],
    });

    const body = parseFetchBody();
    expect(body.message).toBe("**Bold** \\* not italic");
  });

  it("preserves literal backslashes in styled container messages", async () => {
    mockJsonResponse({});

    await rpc("send", {
      account: "+14259798283",
      recipient: ["+15550001111"],
      message: "Bold C:\\Temp\\file and /foo\\bar/",
      "text-style": ["0:4:BOLD"],
    });

    const body = parseFetchBody();
    expect(body.message).toBe("**Bold** C:\\Temp\\file and /foo\\bar/");
  });

  it("rejects outbound attachments that exceed the size cap", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "signal-test-"));
    const tmpFile = path.join(tmpDir, "huge.bin");
    await fs.writeFile(tmpFile, Buffer.alloc(8 * 1024 * 1024 + 1));

    await expect(
      rpc("send", {
        account: "+14259798283",
        recipient: ["+15550001111"],
        message: "Photo",
        attachments: [tmpFile],
      }),
    ).rejects.toThrow("exceeds");

    await fs.rm(tmpDir, { recursive: true });
  });

  it("honors a configured attachment cap above the default", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "signal-test-"));
    const tmpFile = path.join(tmpDir, "configured-large.bin");
    const fileBytes = 8 * 1024 * 1024 + 1;
    try {
      await fs.writeFile(tmpFile, Buffer.alloc(fileBytes));
      mockJsonResponse({});

      await rpc(
        "send",
        {
          account: "+14259798283",
          recipient: ["+15550001111"],
          message: "Configured large attachment",
          attachments: [tmpFile],
        },
        { maxAttachmentBytes: fileBytes },
      );

      const body = parseFetchBody();
      expect(body.base64_attachments).toEqual([
        expect.stringMatching(
          /^data:application\/octet-stream;filename=configured-large\.bin;base64,/,
        ),
      ]);
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it("applies the attachment cap to the whole container request", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "signal-test-"));
    const firstFile = path.join(tmpDir, "first.bin");
    const secondFile = path.join(tmpDir, "second.bin");
    try {
      await fs.writeFile(firstFile, Buffer.alloc(6));
      await fs.writeFile(secondFile, Buffer.alloc(6));

      await expect(
        rpc(
          "send",
          {
            account: "+14259798283",
            recipient: ["+15550001111"],
            message: "Two attachments",
            attachments: [firstFile, secondFile],
          },
          { maxAttachmentBytes: 10 },
        ),
      ).rejects.toThrow("exceeds 4 bytes");
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

describe("containerSendTyping", () => {
  it("sends typing indicator with PUT", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
    });

    const result = await rpc("sendTyping", {
      account: "+14259798283",
      recipient: ["+15550001111"],
    });

    expect(result).toBeUndefined();
    const init = expectFirstFetchCall(
      "http://localhost:8080/v1/typing-indicator/%2B14259798283",
      "PUT",
    );
    expect(init.body).toBe(JSON.stringify({ recipient: "+15550001111" }));
  });

  it("stops typing indicator with DELETE", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
    });

    await rpc("sendTyping", {
      account: "+14259798283",
      recipient: ["+15550001111"],
      stop: true,
    });

    expect(requireFetchCall()[1].method).toBe("DELETE");
  });
});

describe("containerRpcRequest typing", () => {
  it("formats group ids for typing indicators", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
    });

    await rpc("sendTyping", {
      account: "+14259798283",
      groupId: "group-123",
    });

    const body = parseFetchBody();
    expect(body.recipient).toBe("group.Z3JvdXAtMTIz");
  });
});

describe("containerRpcRequest send", () => {
  it("translates native quote params to container send fields", async () => {
    mockJsonResponse({ timestamp: "1700000000000" });

    await rpc("send", {
      account: "+14259798283",
      recipient: ["+15550001111"],
      message: "Hello world",
      quoteTimestamp: 1699999999999,
      quoteAuthor: "+15550002222",
      quoteMessage: "original",
    });

    const body = parseFetchBody();
    expect(body.quote_timestamp).toBe(1699999999999);
    expect(body.quote_author).toBe("+15550002222");
    expect(body.quote_message).toBe("original");
  });

  it("strips uuid prefixes from native quote authors", async () => {
    mockJsonResponse({ timestamp: "1700000000000" });

    await rpc("send", {
      account: "+14259798283",
      recipient: ["+15550001111"],
      message: "Hello world",
      quoteTimestamp: 1699999999999,
      quoteAuthor: "uuid:author-uuid",
      quoteMessage: "original",
    });

    const body = parseFetchBody();
    expect(body.quote_author).toBe("author-uuid");
  });

  it("ignores malformed native quote params at the container boundary", async () => {
    mockJsonResponse({ timestamp: "1700000000000" });

    await rpc("send", {
      account: "+14259798283",
      recipient: ["+15550001111"],
      message: "Hello world",
      quoteTimestamp: "not-a-timestamp",
      quoteAuthor: ["+15550002222"],
      quoteMessage: { text: "original" },
    });

    const body = parseFetchBody();
    expect(body).not.toHaveProperty("quote_timestamp");
    expect(body).not.toHaveProperty("quote_author");
    expect(body).not.toHaveProperty("quote_message");
  });
});

describe("containerSendReceipt", () => {
  it("sends read receipt", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
    });

    const result = await rpc("sendReceipt", {
      account: "+14259798283",
      recipient: ["+15550001111"],
      targetTimestamp: 1700000000000,
    });

    expect(result).toBeUndefined();
    const init = expectFirstFetchCall("http://localhost:8080/v1/receipts/%2B14259798283", "POST");
    expect(init.body).toBe(
      JSON.stringify({
        recipient: "+15550001111",
        timestamp: 1700000000000,
        receipt_type: "read",
      }),
    );
  });

  it("sends viewed receipt when type specified", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
    });

    await rpc("sendReceipt", {
      account: "+14259798283",
      recipient: ["+15550001111"],
      targetTimestamp: 1700000000000,
      type: "viewed",
    });

    const body = parseFetchBody();
    expect(body.receipt_type).toBe("viewed");
  });
});

describe("containerFetchAttachment", () => {
  it("fetches attachment binary", async () => {
    const binaryData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => binaryData.buffer,
    });

    const result = await attachment("attachment-123");

    expect(result).toEqual({ data: Buffer.from(binaryData).toString("base64") });
    expectFirstFetchCall("http://localhost:8080/v1/attachments/attachment-123", "GET");
  });

  it("returns missing attachment data on non-ok response", async () => {
    const cancel = vi.fn(async () => undefined);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      body: { cancel },
    });

    const result = await attachment("attachment-123");

    expect(result).toEqual({ data: undefined });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("encodes attachment ID in URL", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    await attachment("path/with/slashes");

    expectFirstFetchCall("http://localhost:8080/v1/attachments/path%2Fwith%2Fslashes");
  });

  it("rejects attachments above the content-length cap", async () => {
    const arrayBuffer = vi.fn();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": "5" }),
      arrayBuffer,
    });

    await expect(
      attachment("attachment-123", {
        maxResponseBytes: 4,
      }),
    ).rejects.toThrow("Signal REST attachment exceeded size limit");
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects malformed content-length before reading attachments", async () => {
    const arrayBuffer = vi.fn();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": "0x3" }),
      arrayBuffer,
    });

    await expect(
      attachment("attachment-123", {
        maxResponseBytes: 4,
      }),
    ).rejects.toThrow("invalid content-length header: 0x3");
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects streamed attachments that exceed the response cap", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
        controller.close();
      },
    });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: stream,
    });

    await expect(
      attachment("attachment-123", {
        maxResponseBytes: 4,
      }),
    ).rejects.toThrow("Signal REST attachment exceeded size limit");
  });

  it("times out stalled attachment bodies within the request deadline", async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      mockFetch.mockImplementation(async (_url, init: RequestInit) => {
        observedSignal = init.signal ?? undefined;
        return new Response(stalledBodyStream().body, {
          status: 200,
          headers: new Headers(),
        });
      });

      const request = attachment("attachment-123", {
        timeoutMs: 25,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(observedSignal).toBeInstanceOf(AbortSignal);
      const requestRejection = expect(request).rejects.toThrow(
        /Signal REST (attachment response body stalled after 25ms|request timed out)/,
      );

      await vi.advanceTimersByTimeAsync(25);
      await requestRejection;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("normalizeBaseUrl edge cases", () => {
  it("throws error for whitespace-only base URL", async () => {
    await expect(containerCheck("   ")).rejects.toThrow("Signal base URL is required");
  });

  it("handles https URLs", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await containerCheck("https://signal.example.com");
    expectFirstFetchCall("https://signal.example.com/v1/about");
  });

  it("rejects base URLs with credentials", async () => {
    await expect(containerCheck("http://user:pass@localhost:8080")).rejects.toThrow(
      "Signal base URL must not include credentials",
    );
  });
});

describe("containerRestRequest edge cases", () => {
  it("handles error response with empty body", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      ...bodyStream(""),
    });

    await expect(rpc("send", undefined)).rejects.toThrow("Signal REST 500: Internal Server Error");
  });

  it("handles JSON parse errors gracefully", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      ...bodyStream("not-valid-json"),
    });

    await expect(rpc("version", undefined)).rejects.toThrow("Signal REST returned malformed JSON");
  });

  it("fails closed when the success body exceeds the response size cap", async () => {
    // Drive the real bounded reader with a >16 MiB stream. Pull lazily so the cap
    // (16 MiB) trips and cancels the stream long before 20 MiB is materialized.
    const ONE_MIB = new Uint8Array(1024 * 1024);
    let emitted = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= 20) {
          controller.close();
          return;
        }
        emitted += 1;
        controller.enqueue(ONE_MIB);
      },
    });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: stream,
    });

    await expect(rpc("version", undefined)).rejects.toThrow(/exceeds \d+ bytes/);
    // The stream must have been cancelled at the cap, not drained to completion.
    expect(emitted).toBeLessThan(20);
  });

  it("parses a large but under-cap success body without truncation", async () => {
    // Regression guard: a legitimate multi-MiB JSON response (well under the 16 MiB
    // cap) must still be read in full and parsed intact — the bound must not clip
    // valid container payloads. Build ~4 MiB of real JSON.
    const items = Array.from({ length: 50_000 }, (_, i) => ({
      id: i,
      note: "signal-container-payload-entry",
    }));
    const payload = JSON.stringify({ items });
    expect(payload.length).toBeGreaterThan(2 * 1024 * 1024);
    expect(payload.length).toBeLessThan(16 * 1024 * 1024);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      ...bodyStream(payload),
    });

    const result = await rpc<{ items: Array<{ id: number }> }>("version", undefined, {});
    // Full body round-trips: first and last entries survive, count is exact.
    expect(result.items).toHaveLength(50_000);
    expect(result.items[0]?.id).toBe(0);
    expect(result.items[49_999]?.id).toBe(49_999);
  });
});

describe("containerSendReaction", () => {
  it("sends reaction to recipient", async () => {
    mockJsonResponse({ timestamp: 1700000000000 });

    const result = await rpc("sendReaction", {
      account: "+14259798283",
      recipients: ["+15550001111"],
      emoji: "👍",
      targetAuthor: "+15550001111",
      targetTimestamp: 1699999999999,
      remove: false,
    });

    expect(result).toEqual({ timestamp: 1700000000000 });
    const init = expectFirstFetchCall("http://localhost:8080/v1/reactions/%2B14259798283", "POST");
    expect(init.body).toBe(
      JSON.stringify({
        recipient: "+15550001111",
        reaction: "👍",
        target_author: "+15550001111",
        timestamp: 1699999999999,
      }),
    );
  });
});

describe("containerRpcRequest reactions", () => {
  it("routes group reactions to the formatted group recipient", async () => {
    mockJsonResponse({});

    await rpc("sendReaction", {
      account: "+14259798283",
      recipients: ["uuid:author-uuid"],
      groupIds: ["group-123"],
      emoji: "👍",
      targetAuthor: "uuid:author-uuid",
      targetTimestamp: 1699999999999,
    });

    const body = parseFetchBody();
    expect(body.recipient).toBe("group.Z3JvdXAtMTIz");
    expect(body.group_id).toBe("group.Z3JvdXAtMTIz");
    expect(body.target_author).toBe("author-uuid");
  });
});

describe("containerRemoveReaction", () => {
  it("removes reaction with DELETE", async () => {
    mockJsonResponse({ timestamp: 1700000000000 });

    const result = await rpc("sendReaction", {
      account: "+14259798283",
      recipients: ["+15550001111"],
      emoji: "👍",
      targetAuthor: "+15550001111",
      targetTimestamp: 1699999999999,
      remove: true,
    });

    expect(result).toEqual({ timestamp: 1700000000000 });
    const init = expectFirstFetchCall(
      "http://localhost:8080/v1/reactions/%2B14259798283",
      "DELETE",
    );
    expect(init.body).toBe(
      JSON.stringify({
        recipient: "+15550001111",
        reaction: "👍",
        target_author: "+15550001111",
        timestamp: 1699999999999,
      }),
    );
  });
});
