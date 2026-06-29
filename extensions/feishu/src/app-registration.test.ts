// Feishu tests cover app registration plugin behavior.
import { createServer } from "node:http";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginAppRegistration, pollAppRegistration, printQrCode } from "./app-registration.js";
import { FEISHU_JSON_MAX_BYTES } from "./json-response.js";

const { fetchWithSsrFGuardMock, renderQrTerminalMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
  renderQrTerminalMock: vi.fn(async () => "terminal-qr"),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("./qr-terminal.js", () => ({
  renderQrTerminal: renderQrTerminalMock,
}));

function mockFeishuJson(payload: unknown) {
  fetchWithSsrFGuardMock.mockResolvedValueOnce({
    response: new Response(JSON.stringify(payload), { status: 200 }),
    release: async () => {},
  });
}

/** Builds a ReadableStream that streams `totalBytes` of zero bytes and tracks cancellation. */
function makeOversizedStream(totalBytes: number): {
  stream: ReadableStream<Uint8Array>;
  state: { bytesPulled: number; canceled: boolean };
} {
  const state = { bytesPulled: 0, canceled: false };
  const CHUNK = 1024 * 1024; // 1 MiB per chunk
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= totalBytes) {
        controller.close();
        return;
      }
      const remaining = totalBytes - pulled;
      const size = Math.min(CHUNK, remaining);
      pulled += size;
      state.bytesPulled += size;
      controller.enqueue(new Uint8Array(size));
    },
    cancel() {
      state.canceled = true;
    },
  });
  return { stream, state };
}

describe("Feishu app registration", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fetchWithSsrFGuardMock.mockReset();
    renderQrTerminalMock.mockClear();
  });

  it("defaults unsafe begin polling lifetimes from provider responses", async () => {
    mockFeishuJson({
      device_code: "device-code",
      verification_uri_complete: "https://accounts.feishu.cn/verify?x=1",
      user_code: "user-code",
      interval: Number.POSITIVE_INFINITY,
      expire_in: Number.POSITIVE_INFINITY,
    });

    await expect(beginAppRegistration()).resolves.toMatchObject({
      deviceCode: "device-code",
      userCode: "user-code",
      interval: 5,
      expireIn: 600,
    });
  });

  it("clamps unsafe poll sleeps from provider intervals", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("transient"));

    const poll = pollAppRegistration({
      deviceCode: "device-code",
      interval: 10_000_000,
      expireIn: 10_000_000,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);

    await vi.runOnlyPendingTimersAsync();
    await expect(poll).resolves.toEqual({ status: "timeout" });
  });

  it("prints scan-to-create QR codes with compact terminal rendering", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await printQrCode("https://accounts.feishu.cn/verify?device_code=long-device-code");

    expect(renderQrTerminalMock).toHaveBeenCalledWith(
      "https://accounts.feishu.cn/verify?device_code=long-device-code",
      { small: true },
    );
    expect(writeSpy).toHaveBeenCalledWith("terminal-qr\n");
  });

  // over-cap: body > 16 MiB, no Content-Length — bounded reader cancels stream and rejects.
  // mutation control: reverting readResponseWithLimit to bare response.json() turns this test red
  // because json() buffers the entire stream instead of cancelling at 16 MiB.
  it("rejects Feishu API responses that exceed the 16 MiB JSON body cap", async () => {
    const { stream, state } = makeOversizedStream(FEISHU_JSON_MAX_BYTES * 2); // 32 MiB
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" },
        // No Content-Length — tests the streaming path
      }),
      release,
    });

    await expect(beginAppRegistration()).rejects.toThrow(
      /feishu\.api: JSON response exceeds \d+ bytes/,
    );
    // Confirm the stream was cancelled — not fully buffered.
    expect(state.canceled).toBe(true);
    expect(state.bytesPulled).toBeLessThan(FEISHU_JSON_MAX_BYTES * 2);
    // release() must be called even when the body overflows.
    expect(release).toHaveBeenCalledOnce();
    console.log(
      `[feishu fetchFeishuJson bound proof] over-cap: bytes_pulled=${state.bytesPulled} cap=${FEISHU_JSON_MAX_BYTES} canceled=${state.canceled}`,
    );
  });

  // under-cap: a normal-sized valid JSON response is parsed and returned correctly.
  it("parses under-cap Feishu API JSON responses and returns the typed payload", async () => {
    const payload = {
      device_code: "dev-code-123",
      verification_uri_complete: "https://accounts.feishu.cn/verify?x=1",
      user_code: "UC-456",
      interval: 5,
      expire_in: 300,
    };
    // Serve via ReadableStream (no Content-Length) to exercise the streaming path.
    const body = JSON.stringify(payload);
    const encoded = new TextEncoder().encode(body);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, Math.floor(encoded.length / 2)));
        controller.enqueue(encoded.slice(Math.floor(encoded.length / 2)));
        controller.close();
      },
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release: async () => {},
    });

    const result = await beginAppRegistration();
    expect(result).toMatchObject({
      deviceCode: "dev-code-123",
      userCode: "UC-456",
      interval: 5,
      expireIn: 300,
    });
    console.log(
      `[feishu fetchFeishuJson bound proof] under-cap: returned=${JSON.stringify(result)}`,
    );
  });

  it("wraps malformed Feishu API JSON with a feishu.api labelled error", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response("not-valid-json{{", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release,
    });

    await expect(beginAppRegistration()).rejects.toThrow(/feishu\.api: malformed JSON response/);
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("feishu bound reads — real HTTP server (no fetch mock)", () => {
  it("rejects oversized response before fully buffering 20 MiB (OOM guard)", async () => {
    const CHUNK = Buffer.alloc(1024 * 1024, 0x61);
    const TOTAL_CHUNKS = 20;
    let chunksWritten = 0;

    const srv = await new Promise<{ port: number; stop: () => Promise<void> }>((resolve, reject) => {
      const server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        let sent = 0;
        const sendChunk = () => {
          if (sent >= TOTAL_CHUNKS) { res.end(); return; }
          sent++; chunksWritten++;
          const ok = res.write(CHUNK);
          if (ok) { setImmediate(sendChunk); }
          else { res.once("drain", sendChunk); }
        };
        sendChunk();
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        resolve({ port: addr.port, stop: () => new Promise<void>((r, e) => { server.close(err => (err ? e(err) : r())); }) });
      });
    });

    try {
      const response = await fetch(`http://127.0.0.1:${srv.port}/`);
      // Mutation-control: bare `response.json()` would buffer all 20 MiB.
      await expect(readProviderJsonResponse(response, "feishu.bound-proof")).rejects.toThrow(/JSON response exceeds/);
      expect(chunksWritten).toBeLessThan(TOTAL_CHUNKS);
      console.log(`[bound-proof] canceled at ${chunksWritten}/${TOTAL_CHUNKS} chunks`);
    } finally {
      await srv.stop();
    }
  });

  it("parses well-formed JSON response under the cap", async () => {
    const payload = { code: 0, data: { app_id: "cli_test" } };
    const srv = await new Promise<{ port: number; stop: () => Promise<void> }>((resolve, reject) => {
      const server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        resolve({ port: addr.port, stop: () => new Promise<void>((r, e) => { server.close(err => (err ? e(err) : r())); }) });
      });
    });
    try {
      const response = await fetch(`http://127.0.0.1:${srv.port}/`);
      const result = await readProviderJsonResponse<typeof payload>(response, "feishu.bound-proof");
      expect(result).toEqual(payload);
    } finally {
      await srv.stop();
    }
  });
});
