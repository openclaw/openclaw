import { afterEach, describe, expect, it, vi } from "vitest";
import { assertLoopbackBridgeUrl, requestComfyGenerateSync } from "./client.js";
import type { ComfyGenerateRequest } from "./types.js";

describe("assertLoopbackBridgeUrl", () => {
  it("accepts localhost and loopback IPv4", () => {
    expect(assertLoopbackBridgeUrl("http://localhost:8787").hostname).toBe("localhost");
    expect(assertLoopbackBridgeUrl("http://127.0.0.1:8787").hostname).toBe("127.0.0.1");
  });

  it("rejects non-loopback hosts", () => {
    expect(() => assertLoopbackBridgeUrl("http://example.com:8787")).toThrow(/loopback/i);
  });
});

describe("requestComfyGenerateSync", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns parsed success payload", async () => {
    const payload = {
      ok: true,
      job_id: "job-1",
      image_path: "/tmp/out.png",
      width: 512,
      height: 512,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch,
    );
    const req: ComfyGenerateRequest = {
      mode: "txt2img",
      prompt: "test",
      width: 512,
      height: 512,
      steps: 20,
      guidance: 5,
      timeout_ms: 60_000,
    };
    const result = await requestComfyGenerateSync({
      bridgeUrl: "http://127.0.0.1:8787",
      timeoutMs: 60_000,
      request: req,
    });
    expect(result.image_path).toBe("/tmp/out.png");
  });

  it("throws bridge errors with code", async () => {
    const payload = {
      ok: false,
      code: "missing_model",
      message: "Model not found",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(payload), { status: 400 })) as typeof fetch,
    );
    const req: ComfyGenerateRequest = {
      mode: "txt2img",
      prompt: "test",
      width: 512,
      height: 512,
      steps: 20,
      guidance: 5,
      timeout_ms: 60_000,
    };
    await expect(
      requestComfyGenerateSync({
        bridgeUrl: "http://127.0.0.1:8787",
        timeoutMs: 60_000,
        request: req,
      }),
    ).rejects.toThrow(/missing_model/i);
  });
});
