import * as capture from "openclaw/plugin-sdk/proxy-capture";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { installDebugProxyTestResetHooks } from "../test-support/debug-proxy-env-test-helpers.js";
import { buildOpenAISpeechProvider } from "./speech-provider.js";

const proxyReset = installDebugProxyTestResetHooks();
function requestAudio(baseUrl: string, budget?: "bytes" | "time") {
  return buildOpenAISpeechProvider()
    .synthesize({
      text: "local binary acceptance",
      cfg: budget ? { agents: { defaults: { mediaMaxMb: 0.001 } } } : {},
      providerConfig: {
        apiKey: "local-test-key",
        baseUrl: `${baseUrl}/v1`,
        model: "tts-1",
        voice: "alloy",
      },
      target: "audio-file",
      timeoutMs: budget === "time" ? 300 : 5_000,
    })
    .then(({ audioBuffer }) => audioBuffer);
}

it("rejects invalid audio over TCP and preserves valid codec parameters", async () => {
  const type = "audio/ogg";
  const cases = [
    { header: "image/png", body: "wrong family", valid: false },
    { header: "", body: "empty header", valid: false },
    { header: `${type}; charset=utf-8, text/html`, body: "hidden error", valid: false },
    { header: [type, "application/json"], body: "repeated header", valid: false },
    { header: type, body: "", valid: false },
    { header: "application/ogg", body: "Ogg container bytes", valid: true },
    { header: "application/octet-stream", body: "opaque bytes", valid: true },
    { header: "binary/octet-stream", body: "opaque alias bytes", valid: true },
    { header: undefined, body: "missing header bytes", valid: true },
    { header: `${type}; codecs="one, two"`, body: "codec bytes", valid: true },
    { header: `${type};; codecs="one, two";`, body: "empty parameter slots", valid: true },
  ];
  for (const fixture of cases) {
    await withServer(
      (request, response) => {
        request.resume();
        if (fixture.header !== undefined) {
          response.setHeader("Content-Type", fixture.header);
        }
        response.end(fixture.body);
      },
      async (baseUrl) => {
        const result = requestAudio(baseUrl);
        if (fixture.valid) {
          await expect(result).resolves.toEqual(Buffer.from(fixture.body));
        } else {
          await expect(result).rejects.toThrow("malformed audio response");
        }
      },
    );
  }
});

it("preserves audio byte limits and transport timeouts over TCP", async () => {
  for (const stalled of [false, true]) {
    const closed = vi.fn();
    await withServer(
      (request, response) => {
        request.resume();
        request.socket.once("close", closed);
        response.writeHead(200, { "Content-Type": "audio/mpeg" });
        response.write(stalled ? Buffer.from([1]) : Buffer.alloc(4096));
      },
      async (baseUrl) => {
        const result = requestAudio(baseUrl, stalled ? "time" : "bytes");
        await expect(result).rejects.toThrow(
          stalled ? /timed out|aborted/i : "OpenAI TTS audio response exceeds",
        );
        await vi.waitFor(() => expect(closed).toHaveBeenCalled());
      },
    );
  }
});

it("persists audio capture through finalization and closes the rejected upstream socket", async () => {
  proxyReset.captureProxyEnv();
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "binary-tcp-" });
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "1");
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_SESSION_ID", "binary-audio");
  const closed = vi.fn();
  let mediaResponses = 0;
  try {
    await capture.initializeDebugProxyCaptureAsync("test");
    await withServer(
      (request, response) => {
        request.resume();
        if (mediaResponses++ === 0) {
          response.writeHead(200, { "Content-Type": "audio/ogg" }).end("captured valid media");
        } else {
          request.socket.once("close", closed);
          response.writeHead(200, { "Content-Type": "image/png" }).write("not the requested media");
          // Leave the body open: capture must not own the caller's completion.
        }
      },
      async (baseUrl) => {
        await expect(requestAudio(baseUrl)).resolves.toEqual(Buffer.from("captured valid media"));
        await expect(requestAudio(baseUrl)).rejects.toThrow("malformed audio response");
        await vi.waitFor(() => expect(closed).toHaveBeenCalled());
        await capture.finalizeDebugProxyCaptureAsync();
        await closeOpenClawStateDatabaseAsync();
        const reopened = capture.createDebugProxyCaptureReaderAsync({ env: process.env });
        const persisted = await reopened.getSessionEvents("binary-audio", 20);
        expect(persisted.some((event) => event.kind === "request")).toBe(true);
        expect(persisted.some((event) => event.kind === "response")).toBe(true);
        expect(persisted).toHaveLength(4);
      },
    );
  } finally {
    await capture.finalizeDebugProxyCaptureAsync();
    vi.unstubAllEnvs();
    await state.cleanup();
  }
});
