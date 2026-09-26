// Signal tests cover client container plugin behavior.
import * as fetchModule from "openclaw/plugin-sdk/fetch-runtime";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { containerCheck, containerRpcRequest, streamContainerEvents } from "./client-container.js";

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
const wsMockState = vi.hoisted(() => ({
  behavior: "close" as
    | "close"
    | "open"
    | "error"
    | "message"
    | "buffered-message"
    | "pending"
    | "unexpected-response",
  urls: [] as string[],
  options: [] as Array<{ maxPayload?: number; handshakeTimeout?: number } | undefined>,
  terminations: 0,
}));

beforeEach(() => {
  vi.spyOn(fetchModule, "resolveFetch").mockReturnValue(mockFetch as unknown as typeof fetch);
  wsMockState.behavior = "close";
  wsMockState.urls = [];
  wsMockState.options = [];
  wsMockState.terminations = 0;
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

function expectMockLogNotContains(mock: ReturnType<typeof vi.fn>, expected: string): void {
  const messages = mock.mock.calls.map((call) => String(call[0] ?? ""));
  expect(messages.join("\n")).not.toContain(expected);
}

// Minimal WebSocket mock for connection-log assertions.
vi.mock("./ws-runtime.js", () => ({
  WebSocket: class MockWebSocket {
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    private bufferedMessageFlushed = false;

    constructor(url: string | URL, options?: { maxPayload?: number; handshakeTimeout?: number }) {
      wsMockState.urls.push(String(url));
      wsMockState.options.push(options);
      setTimeout(() => {
        if (wsMockState.behavior === "open") {
          this.emit("open");
          this.emit("close", 1000, Buffer.from("done"));
        } else if (wsMockState.behavior === "error") {
          this.emit("error", new Error("WebSocket failed"));
        } else if (wsMockState.behavior === "unexpected-response") {
          this.emit("unexpected-response", {}, { statusCode: 200, statusMessage: "OK" });
        } else if (wsMockState.behavior === "message") {
          this.emit("message", Buffer.from('{"envelope":{"timestamp":1}}'));
          this.emit("close", 1000, Buffer.from("done"));
        } else if (wsMockState.behavior === "buffered-message") {
          this.emit("open");
          this.emit("message", Buffer.from('{"envelope":{"timestamp":1}}'));
        } else if (wsMockState.behavior === "pending") {
          // Keep the opening handshake unresolved until shutdown closes it.
        } else {
          this.emit("close", 1000, Buffer.from("done"));
        }
      }, 0);
    }

    on(event: string, callback: (...args: unknown[]) => void) {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(callback);
      this.handlers.set(event, handlers);
      return this;
    }

    once(event: string, callback: (...args: unknown[]) => void) {
      const onceCallback = (...args: unknown[]) => {
        this.handlers.set(
          event,
          (this.handlers.get(event) ?? []).filter((handler) => handler !== onceCallback),
        );
        callback(...args);
      };
      return this.on(event, onceCallback);
    }

    close() {
      if (wsMockState.behavior === "buffered-message" && !this.bufferedMessageFlushed) {
        this.bufferedMessageFlushed = true;
        // ws flushes already-buffered receiver frames before its final close event.
        this.emit("message", Buffer.from('{"envelope":{"timestamp":2}}'));
      }
      this.emit("close", 1000, Buffer.from("done"));
    }

    terminate() {
      wsMockState.terminations += 1;
    }

    private emit(event: string, ...args: unknown[]) {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }
  },
}));

describe("containerCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok:true when /v1/about returns 200", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
    });

    const result = await containerCheck("http://localhost:8080");
    expect(result).toEqual({ ok: true, status: 200, error: null });
    expectFirstFetchCall("http://localhost:8080/v1/about", "GET");
  });

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

  it("validates the receive WebSocket when an account is provided", async () => {
    wsMockState.behavior = "open";
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const result = await containerCheck("http://localhost:8080", 1000, "+14259798283");

    expect(result).toEqual({ ok: true, status: 101, error: null });
    expect(wsMockState.urls).toEqual(["ws://localhost:8080/v1/receive/%2B14259798283"]);
    expect(wsMockState.options).toEqual([{ maxPayload: 1024 * 1024 }]);
  });

  it("rejects container receive endpoints that do not upgrade to WebSocket", async () => {
    wsMockState.behavior = "unexpected-response";
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const result = await containerCheck("http://localhost:8080", 1000, "+14259798283");

    expect(result).toEqual({
      ok: false,
      status: 200,
      error: "Signal container receive endpoint did not upgrade to WebSocket (HTTP 200)",
    });
  });

  it("rejects container receive endpoints that close before opening", async () => {
    wsMockState.behavior = "close";
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const result = await containerCheck("http://localhost:8080", 1000, "+14259798283");

    expect(result).toEqual({
      ok: false,
      status: null,
      error: "Signal container receive WebSocket closed before open (1000: done)",
    });
  });
});

describe("containerRpcRequest REST transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("makes GET request with correct endpoint", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      ...bodyStream(JSON.stringify({ version: "1.0" })),
    });

    const result = await containerRpcRequest("version", undefined, {
      baseUrl: "http://localhost:8080",
    });
    expect(result).toEqual({ version: "1.0" });
    const init = expectFirstFetchCall("http://localhost:8080/v1/about", "GET");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("makes POST request with body", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
      ...bodyStream(""),
    });

    await containerRpcRequest(
      "send",
      { message: "test", account: "+1234567890", recipient: ["+1234567890"] },
      { baseUrl: "http://localhost:8080" },
    );

    const init = expectFirstFetchCall("http://localhost:8080/v2/send", "POST");
    expect(init.body).toBe(
      JSON.stringify({
        message: "test",
        number: "+1234567890",
        recipients: ["+1234567890"],
      }),
    );
  });

  it("parses 201 response bodies", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
      ...bodyStream(JSON.stringify({ timestamp: 1700000000000 })),
    });

    const result = await containerRpcRequest(
      "send",
      { message: "", account: "", recipient: [] },
      { baseUrl: "http://localhost:8080" },
    );
    expect(result).toEqual({ timestamp: 1700000000000 });
  });

  it("returns undefined for 204 status", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
    });

    const result = await containerRpcRequest(
      "sendTyping",
      { account: "+1234567890", recipient: [""], stop: false },
      { baseUrl: "http://localhost:8080" },
    );
    expect(result).toBeUndefined();
  });

  it("throws error on non-ok response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      ...bodyStream("Server error details"),
    });

    await expect(
      containerRpcRequest(
        "send",
        { message: "", account: "", recipient: [] },
        { baseUrl: "http://localhost:8080" },
      ),
    ).rejects.toThrow("Signal REST 500: Server error details");
  });

  it("bounds REST error response bodies before reporting failures", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      ...bodyStream("x".repeat(20_000)),
    });

    await expect(
      containerRpcRequest(
        "send",
        { message: "", account: "", recipient: [] },
        { baseUrl: "http://localhost:8080" },
      ),
    ).rejects.toThrow(`Signal REST 500: ${"x".repeat(16 * 1024)}`);
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

      const request = containerRpcRequest(
        "send",
        { message: "", account: "", recipient: [] },
        {
          baseUrl: "http://localhost:8080",
          timeoutMs: 25,
        },
      );

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

    const result = await containerRpcRequest("version", undefined, {
      baseUrl: "http://localhost:8080",
    });
    expect(result).toBeUndefined();
  });

  it("respects custom timeout by using abort signal", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      ...bodyStream("{}"),
    });

    await containerRpcRequest("version", undefined, {
      baseUrl: "http://localhost:8080",
      timeoutMs: 5000,
    });

    // The timeout is enforced via AbortController, so we verify the call was made with a signal
    expect(mockFetch).toHaveBeenCalled();
    if (requireFetchCall()[1].signal === undefined) {
      throw new Error("expected fetch call to include an abort signal");
    }
  });

  it("caps oversized REST request timeouts before arming abort timers", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        ...bodyStream("{}"),
      });

      await containerRpcRequest("version", undefined, {
        baseUrl: "http://localhost:8080",
        timeoutMs: Number.MAX_SAFE_INTEGER,
      });

      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
      expect(requireFetchCall()[1].signal).toBeInstanceOf(AbortSignal);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("times out stalled REST response bodies within the request deadline", async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      mockFetch.mockImplementation(async (_url, init: RequestInit) => {
        observedSignal = init.signal ?? undefined;
        return new Response(stalledBodyStream().body, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      const request = containerRpcRequest("version", undefined, {
        baseUrl: "http://localhost:8080",
        timeoutMs: 25,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledOnce();
      expect(observedSignal).toBeInstanceOf(AbortSignal);
      const requestRejection = expect(request).rejects.toThrow(
        /Signal REST (response body stalled after 25ms|request timed out)/,
      );

      await vi.advanceTimersByTimeAsync(25);
      await requestRejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows slow REST response bodies that finish inside the overall timeout", async () => {
    vi.useFakeTimers();
    try {
      mockFetch.mockResolvedValue(
        new Response(
          delayedBodyStream([
            { delayMs: 10, text: "{" },
            { delayMs: 20, text: '"ok"' },
            { delayMs: 20, text: ":true" },
            { delayMs: 20, text: "}" },
          ]).body,
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

      const request = containerRpcRequest<{ ok: boolean }>("version", undefined, {
        baseUrl: "http://localhost:8080",
        timeoutMs: 100,
      });

      await vi.advanceTimersByTimeAsync(75);
      await expect(request).resolves.toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
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

      const request = containerRpcRequest<{ ok: boolean }>("version", undefined, {
        baseUrl: "http://localhost:8080",
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

      const request = containerRpcRequest("version", undefined, {
        baseUrl: "http://localhost:8080",
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

describe("containerRpcRequest send payloads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends message to recipients", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      ...bodyStream(JSON.stringify({ timestamp: "1700000000000" })),
    });

    const result = await containerRpcRequest(
      "send",
      { account: "+14259798283", recipient: ["+15550001111"], message: "Hello world" },
      { baseUrl: "http://localhost:8080" },
    );

    expect(result).toEqual({ timestamp: 1700000000000 });
    const init = expectFirstFetchCall("http://localhost:8080/v2/send", "POST");
    expect(init.body).toBe(
      JSON.stringify({
        message: "Hello world",
        number: "+14259798283",
        recipients: ["+15550001111"],
      }),
    );
  });

  it("normalizes invalid send timestamps before returning", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      ...bodyStream(JSON.stringify({ timestamp: "not-a-number" })),
    });

    await expect(
      containerRpcRequest(
        "send",
        { account: "+14259798283", recipient: ["+15550001111"], message: "Hello world" },
        { baseUrl: "http://localhost:8080" },
      ),
    ).rejects.toThrow("Signal REST send returned invalid timestamp");
  });

  it.each(["0x18bcfe56800", "1700000000000.5"])(
    "rejects non-decimal integer send timestamp %s",
    async (timestamp) => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        ...bodyStream(JSON.stringify({ timestamp })),
      });

      await expect(
        containerRpcRequest(
          "send",
          { account: "+14259798283", recipient: ["+15550001111"], message: "Hello world" },
          { baseUrl: "http://localhost:8080" },
        ),
      ).rejects.toThrow("Signal REST send returned invalid timestamp");
    },
  );

  it("uses container styled text mode when styles are provided", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      ...bodyStream(JSON.stringify({})),
    });

    await containerRpcRequest(
      "send",
      {
        account: "+14259798283",
        recipient: ["+15550001111"],
        message: "Bold text",
        "text-style": ["0:4:BOLD"],
      },
      { baseUrl: "http://localhost:8080" },
    );

    const body = parseFetchBody();
    expect(body.message).toBe("**Bold** text");
    expect(body.text_mode).toBe("styled");
    expect(body).not.toHaveProperty("text_style");
  });

  it("escapes unstyled formatting markers in styled container messages", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      ...bodyStream(JSON.stringify({})),
    });

    await containerRpcRequest(
      "send",
      {
        account: "+14259798283",
        recipient: ["+15550001111"],
        message: "Bold * not italic",
        "text-style": ["0:4:BOLD"],
      },
      { baseUrl: "http://localhost:8080" },
    );

    const body = parseFetchBody();
    expect(body.message).toBe("**Bold** \\* not italic");
  });

  it("preserves literal backslashes in styled container messages", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      ...bodyStream(JSON.stringify({})),
    });

    await containerRpcRequest(
      "send",
      {
        account: "+14259798283",
        recipient: ["+15550001111"],
        message: "Bold C:\\Temp\\file and /foo\\bar/",
        "text-style": ["0:4:BOLD"],
      },
      { baseUrl: "http://localhost:8080" },
    );

    const body = parseFetchBody();
    expect(body.message).toBe("**Bold** C:\\Temp\\file and /foo\\bar/");
  });

  it("includes attachments as base64 data URIs", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");

    // Create a temp file with known content
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "signal-test-"));
    const tmpFile = path.join(tmpDir, "test-image.jpg");
    const content = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic bytes
    await fs.writeFile(tmpFile, content);

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      ...bodyStream(JSON.stringify({})),
    });

    await containerRpcRequest(
      "send",
      {
        account: "+14259798283",
        recipient: ["+15550001111"],
        message: "Photo",
        attachments: [tmpFile],
      },
      { baseUrl: "http://localhost:8080" },
    );

    const body = parseFetchBody();
    expect(body.attachments).toBeUndefined();
    if (!Array.isArray(body.base64_attachments)) {
      throw new Error("expected base64 attachments array");
    }
    expect(body.base64_attachments).toHaveLength(1);
    expect(body.base64_attachments[0]).toMatch(
      /^data:image\/jpeg;filename=test-image\.jpg;base64,/,
    );

    // Cleanup
    await fs.rm(tmpDir, { recursive: true });
  });

  it("rejects outbound attachments that exceed the size cap", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "signal-test-"));
    const tmpFile = path.join(tmpDir, "huge.bin");
    await fs.writeFile(tmpFile, Buffer.alloc(8 * 1024 * 1024 + 1));

    await expect(
      containerRpcRequest(
        "send",
        {
          account: "+14259798283",
          recipient: ["+15550001111"],
          message: "Photo",
          attachments: [tmpFile],
        },
        { baseUrl: "http://localhost:8080" },
      ),
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
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        ...bodyStream(JSON.stringify({})),
      });

      await containerRpcRequest(
        "send",
        {
          account: "+14259798283",
          recipient: ["+15550001111"],
          message: "Configured large attachment",
          attachments: [tmpFile],
        },
        { baseUrl: "http://localhost:8080", maxAttachmentBytes: fileBytes },
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
        containerRpcRequest(
          "send",
          {
            account: "+14259798283",
            recipient: ["+15550001111"],
            message: "Two attachments",
            attachments: [firstFile, secondFile],
          },
          { baseUrl: "http://localhost:8080", maxAttachmentBytes: 10 },
        ),
      ).rejects.toThrow("exceeds 4 bytes");
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

describe("containerRpcRequest typing indicators", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends typing indicator with PUT", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
    });

    const result = await containerRpcRequest(
      "sendTyping",
      { account: "+14259798283", recipient: ["+15550001111"] },
      { baseUrl: "http://localhost:8080" },
    );

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

    await containerRpcRequest(
      "sendTyping",
      { account: "+14259798283", recipient: ["+15550001111"], stop: true },
      { baseUrl: "http://localhost:8080" },
    );

    expect(requireFetchCall()[1].method).toBe("DELETE");
  });
});

describe("containerRpcRequest typing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("formats group ids for typing indicators", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
    });

    await containerRpcRequest(
      "sendTyping",
      {
        account: "+14259798283",
        groupId: "group-123",
      },
      { baseUrl: "http://localhost:8080" },
    );

    const body = parseFetchBody();
    expect(body.recipient).toBe("group.Z3JvdXAtMTIz");
  });
});

describe("containerRpcRequest send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("translates native quote params to container send fields", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      ...bodyStream(JSON.stringify({ timestamp: "1700000000000" })),
    });

    await containerRpcRequest(
      "send",
      {
        account: "+14259798283",
        recipient: ["+15550001111"],
        message: "Hello world",
        quoteTimestamp: 1699999999999,
        quoteAuthor: "+15550002222",
        quoteMessage: "original",
      },
      { baseUrl: "http://localhost:8080" },
    );

    const body = parseFetchBody();
    expect(body.quote_timestamp).toBe(1699999999999);
    expect(body.quote_author).toBe("+15550002222");
    expect(body.quote_message).toBe("original");
  });

  it("strips uuid prefixes from native quote authors", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      ...bodyStream(JSON.stringify({ timestamp: "1700000000000" })),
    });

    await containerRpcRequest(
      "send",
      {
        account: "+14259798283",
        recipient: ["+15550001111"],
        message: "Hello world",
        quoteTimestamp: 1699999999999,
        quoteAuthor: "uuid:author-uuid",
        quoteMessage: "original",
      },
      { baseUrl: "http://localhost:8080" },
    );

    const body = parseFetchBody();
    expect(body.quote_author).toBe("author-uuid");
  });

  it("ignores malformed native quote params at the container boundary", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      ...bodyStream(JSON.stringify({ timestamp: "1700000000000" })),
    });

    await containerRpcRequest(
      "send",
      {
        account: "+14259798283",
        recipient: ["+15550001111"],
        message: "Hello world",
        quoteTimestamp: "not-a-timestamp",
        quoteAuthor: ["+15550002222"],
        quoteMessage: { text: "original" },
      },
      { baseUrl: "http://localhost:8080" },
    );

    const body = parseFetchBody();
    expect(body).not.toHaveProperty("quote_timestamp");
    expect(body).not.toHaveProperty("quote_author");
    expect(body).not.toHaveProperty("quote_message");
  });
});

describe("containerRpcRequest receipts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends read receipt", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
    });

    const result = await containerRpcRequest(
      "sendReceipt",
      { account: "+14259798283", recipient: ["+15550001111"], targetTimestamp: 1700000000000 },
      { baseUrl: "http://localhost:8080" },
    );

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

    await containerRpcRequest(
      "sendReceipt",
      {
        account: "+14259798283",
        recipient: ["+15550001111"],
        targetTimestamp: 1700000000000,
        type: "viewed",
      },
      { baseUrl: "http://localhost:8080" },
    );

    const body = parseFetchBody();
    expect(body.receipt_type).toBe("viewed");
  });
});

describe("containerRpcRequest attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches attachment binary", async () => {
    const binaryData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => binaryData.buffer,
    });

    const result = await containerRpcRequest(
      "getAttachment",
      { id: "attachment-123" },
      {
        baseUrl: "http://localhost:8080",
      },
    );

    expect(result).toEqual({ data: "iVBORw==" });
    expectFirstFetchCall("http://localhost:8080/v1/attachments/attachment-123", "GET");
  });

  it("returns no attachment data on non-ok response", async () => {
    const cancel = vi.fn(async () => undefined);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      body: { cancel },
    });

    const result = await containerRpcRequest(
      "getAttachment",
      { id: "attachment-123" },
      {
        baseUrl: "http://localhost:8080",
      },
    );

    expect(result).toEqual({ data: undefined });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("encodes attachment ID in URL", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    await containerRpcRequest(
      "getAttachment",
      { id: "path/with/slashes" },
      {
        baseUrl: "http://localhost:8080",
      },
    );

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
      containerRpcRequest(
        "getAttachment",
        { id: "attachment-123" },
        {
          baseUrl: "http://localhost:8080",
          maxResponseBytes: 4,
        },
      ),
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
      containerRpcRequest(
        "getAttachment",
        { id: "attachment-123" },
        {
          baseUrl: "http://localhost:8080",
          maxResponseBytes: 4,
        },
      ),
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
      containerRpcRequest(
        "getAttachment",
        { id: "attachment-123" },
        {
          baseUrl: "http://localhost:8080",
          maxResponseBytes: 4,
        },
      ),
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

      const request = containerRpcRequest(
        "getAttachment",
        { id: "attachment-123" },
        {
          baseUrl: "http://localhost:8080",
          timeoutMs: 25,
        },
      );

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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws error for empty base URL", async () => {
    await expect(containerCheck("")).rejects.toThrow("Signal base URL is required");
  });

  it("throws error for whitespace-only base URL", async () => {
    await expect(containerCheck("   ")).rejects.toThrow("Signal base URL is required");
  });

  it("handles https URLs", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await containerCheck("https://signal.example.com");
    expectFirstFetchCall("https://signal.example.com/v1/about");
  });

  it("handles URLs with ports", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await containerCheck("http://192.168.1.100:9922");
    expectFirstFetchCall("http://192.168.1.100:9922/v1/about");
  });

  it("rejects base URLs with credentials", async () => {
    await expect(containerCheck("http://user:pass@localhost:8080")).rejects.toThrow(
      "Signal base URL must not include credentials",
    );
  });
});

describe("containerRpcRequest REST edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles DELETE through the canonical typing operation", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
    });

    await containerRpcRequest(
      "sendTyping",
      { account: "+1234567890", recipient: ["+15550001111"], stop: true },
      { baseUrl: "http://localhost:8080" },
    );

    expectFirstFetchCall("http://localhost:8080/v1/typing-indicator/%2B1234567890", "DELETE");
  });

  it("handles error response with empty body", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      ...bodyStream(""),
    });

    await expect(
      containerRpcRequest(
        "send",
        { message: "", account: "", recipient: [] },
        { baseUrl: "http://localhost:8080" },
      ),
    ).rejects.toThrow("Signal REST 500: Internal Server Error");
  });

  it("handles JSON parse errors gracefully", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      ...bodyStream("not-valid-json"),
    });

    await expect(
      containerRpcRequest("version", undefined, { baseUrl: "http://localhost:8080" }),
    ).rejects.toThrow("Signal REST returned malformed JSON");
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

    await expect(
      containerRpcRequest("version", undefined, { baseUrl: "http://localhost:8080" }),
    ).rejects.toThrow(/exceeds \d+ bytes/);
    // The stream must have been cancelled at the cap, not drained to completion.
    expect(emitted).toBeLessThan(20);
  });

  it("bounds the error body so a huge failure response cannot be buffered whole", async () => {
    const HUGE = "x".repeat(1024 * 1024); // 1 MiB of error text
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      ...bodyStream(HUGE),
    });

    await containerRpcRequest(
      "send",
      { message: "", account: "", recipient: [] },
      { baseUrl: "http://localhost:8080" },
    ).then(
      () => {
        throw new Error("expected containerRpcRequest to reject");
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        expect(message.startsWith("Signal REST 500:")).toBe(true);
        // readResponseTextLimited truncates the diagnostic body well below the 1 MiB payload.
        expect(message.length).toBeLessThan(64 * 1024);
      },
    );
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

    const result = await containerRpcRequest<{ items: Array<{ id: number }> }>(
      "version",
      undefined,
      {
        baseUrl: "http://localhost:8080",
      },
    );
    // Full body round-trips: first and last entries survive, count is exact.
    expect(result.items).toHaveLength(50_000);
    expect(result.items[0]?.id).toBe(0);
    expect(result.items[49_999]?.id).toBe(49_999);
  });
});

describe("streamContainerEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redacts the account and bounds the opening handshake wait", async () => {
    const log = vi.fn();
    const onStreamOpen = vi.fn();
    wsMockState.behavior = "open";

    await streamContainerEvents({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      onEvent: vi.fn(),
      onStreamOpen,
      logger: { log },
    });

    expect(onStreamOpen).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      "[signal-ws] connecting to ws://localhost:8080/v1/receive/<redacted>",
    );
    expect(wsMockState.options).toEqual([{ maxPayload: 1024 * 1024, handshakeTimeout: 30_000 }]);
    expectMockLogNotContains(log, "+14259798283");
    expectMockLogNotContains(log, "%2B14259798283");
  });

  it.each([
    { timeoutMs: 1_000, expected: 1_000 },
    { timeoutMs: 60_000, expected: 60_000 },
    { timeoutMs: 0, expected: 30_000 },
    { timeoutMs: undefined, expected: 30_000 },
  ])(
    "preserves the stream opening budget for timeoutMs=$timeoutMs",
    async ({ timeoutMs, expected }) => {
      wsMockState.behavior = "open";
      await streamContainerEvents({
        baseUrl: "http://localhost:8080",
        account: "+15550001111",
        timeoutMs,
        onEvent: vi.fn(),
      });
      expect(wsMockState.options).toEqual([
        { maxPayload: 1024 * 1024, handshakeTimeout: expected },
      ]);
    },
  );

  it("removes the abort listener when the stream closes", async () => {
    const abortController = new AbortController();
    const addEventListener = vi.spyOn(abortController.signal, "addEventListener");
    const removeEventListener = vi.spyOn(abortController.signal, "removeEventListener");

    await streamContainerEvents({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      abortSignal: abortController.signal,
      onEvent: vi.fn(),
    });

    const abortHandler = addEventListener.mock.calls.find((call) => call[0] === "abort")?.[1];
    expect(abortHandler).toBeTypeOf("function");
    expect(removeEventListener).toHaveBeenCalledWith("abort", abortHandler);
  });

  it("drains accepted and socket-buffered receive events before resolving shutdown", async () => {
    wsMockState.behavior = "buffered-message";
    const abort = new AbortController();
    const removeEventListener = vi.spyOn(abort.signal, "removeEventListener");
    let releaseFirst!: () => void;
    const firstDelivery = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const timestamps: number[] = [];
    const stream = streamContainerEvents({
      baseUrl: "http://localhost:8080",
      abortSignal: abort.signal,
      timeoutMs: 0,
      onEvent: async (event) => {
        timestamps.push(event.envelope?.timestamp ?? 0);
        if (timestamps.length === 1) {
          markFirstStarted();
          await firstDelivery;
        }
      },
    });
    let settled = false;
    void stream.then(() => {
      settled = true;
    });

    await firstStarted;
    abort.abort();
    const settledBeforeDrain = await Promise.race([
      stream.then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 10);
      }),
    ]);
    expect(settledBeforeDrain).toBe(false);
    expect(settled).toBe(false);

    releaseFirst();
    await expect(stream).resolves.toBeUndefined();
    expect(timestamps).toEqual([1, 2]);
    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(wsMockState.terminations).toBe(0);
  });

  it("propagates a receive-handler failure that settles during shutdown", async () => {
    wsMockState.behavior = "buffered-message";
    const abort = new AbortController();
    const appendError = new Error("durable append failed during shutdown");
    let rejectDelivery!: (error: Error) => void;
    const delivery = new Promise<void>((_resolve, reject) => {
      rejectDelivery = reject;
    });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const stream = streamContainerEvents({
      baseUrl: "http://localhost:8080",
      abortSignal: abort.signal,
      onEvent: async () => {
        markFirstStarted();
        await delivery;
      },
    });

    await firstStarted;
    abort.abort();
    rejectDelivery(appendError);
    await expect(stream).rejects.toBe(appendError);
    expect(wsMockState.terminations).toBe(0);
  });

  it("bounds a stalled shutdown drain and records the accepted-message loss risk", async () => {
    vi.useFakeTimers();
    try {
      wsMockState.behavior = "buffered-message";
      const abort = new AbortController();
      const error = vi.fn();
      let settled = false;
      const stream = streamContainerEvents({
        baseUrl: "http://localhost:8080",
        abortSignal: abort.signal,
        timeoutMs: 0,
        onEvent: async () => await new Promise<void>(() => {}),
        logger: { error },
      }).then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      abort.abort();
      await vi.advanceTimersByTimeAsync(1_499);
      expect(settled).toBe(false);
      expect(error).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await expect(stream).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/receive events.*may be lost/i));
      expect(wsMockState.terminations).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes immediately when aborted before the opening handshake completes", async () => {
    wsMockState.behavior = "pending";
    const abort = new AbortController();
    const removeEventListener = vi.spyOn(abort.signal, "removeEventListener");
    const stream = streamContainerEvents({
      baseUrl: "http://localhost:8080",
      abortSignal: abort.signal,
      onEvent: vi.fn(),
    });

    abort.abort();
    await expect(stream).resolves.toBeUndefined();
    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(wsMockState.terminations).toBe(0);
  });

  it("handles an already-aborted signal without leaving its connection pending", async () => {
    wsMockState.behavior = "pending";
    const abort = new AbortController();
    abort.abort();
    const result = await Promise.race([
      streamContainerEvents({
        baseUrl: "http://localhost:8080",
        abortSignal: abort.signal,
        onEvent: vi.fn(),
      }).then(() => "closed"),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("still pending"), 25);
      }),
    ]);

    expect(result).toBe("closed");
    expect(wsMockState.terminations).toBe(0);
  });

  it("propagates receive-handler failures to the stream", async () => {
    wsMockState.behavior = "message";
    const appendError = new Error("durable append failed");

    await expect(
      streamContainerEvents({
        baseUrl: "http://localhost:8080",
        account: "+14259798283",
        onEvent: async () => {
          throw appendError;
        },
      }),
    ).rejects.toBe(appendError);
  });
});

describe("containerRpcRequest direct reactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends reaction to recipient", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      ...bodyStream(JSON.stringify({ timestamp: 1700000000000 })),
    });

    const result = await containerRpcRequest(
      "sendReaction",
      {
        account: "+14259798283",
        recipients: ["+15550001111"],
        emoji: "👍",
        targetAuthor: "+15550001111",
        targetTimestamp: 1699999999999,
        remove: false,
      },
      { baseUrl: "http://localhost:8080" },
    );

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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes group reactions to the formatted group recipient", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      ...bodyStream(JSON.stringify({})),
    });

    await containerRpcRequest(
      "sendReaction",
      {
        account: "+14259798283",
        recipients: ["uuid:author-uuid"],
        groupIds: ["group-123"],
        emoji: "👍",
        targetAuthor: "uuid:author-uuid",
        targetTimestamp: 1699999999999,
      },
      { baseUrl: "http://localhost:8080" },
    );

    const body = parseFetchBody();
    expect(body.recipient).toBe("group.Z3JvdXAtMTIz");
    expect(body.group_id).toBe("group.Z3JvdXAtMTIz");
    expect(body.target_author).toBe("author-uuid");
  });
});

describe("containerRpcRequest reaction removal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes reaction with DELETE", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      ...bodyStream(JSON.stringify({ timestamp: 1700000000000 })),
    });

    const result = await containerRpcRequest(
      "sendReaction",
      {
        account: "+14259798283",
        recipients: ["+15550001111"],
        emoji: "👍",
        targetAuthor: "+15550001111",
        targetTimestamp: 1699999999999,
        remove: true,
      },
      { baseUrl: "http://localhost:8080" },
    );

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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
