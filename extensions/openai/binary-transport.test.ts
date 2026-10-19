import {
  createDebugProxyCaptureReaderAsync,
  finalizeDebugProxyCaptureAsync,
  initializeDebugProxyCaptureAsync,
} from "openclaw/plugin-sdk/proxy-capture";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import { installDebugProxyTestResetHooks } from "../test-support/debug-proxy-env-test-helpers.js";
import { buildOpenAISpeechProvider } from "./speech-provider.js";

const proxyReset = installDebugProxyTestResetHooks();

async function requestAudio(
  baseUrl: string,
  options: { timeoutMs?: number; mediaMaxMb?: number } = {},
) {
  const budget =
    options.mediaMaxMb === undefined
      ? {}
      : { agents: { defaults: { mediaMaxMb: options.mediaMaxMb } } };
  const result = await buildOpenAISpeechProvider().synthesize({
    text: "local binary acceptance",
    cfg: budget,
    providerConfig: {
      apiKey: "local-test-key",
      baseUrl: `${baseUrl}/v1`,
      model: "tts-1",
      voice: "alloy",
    },
    target: "audio-file",
    timeoutMs: options.timeoutMs ?? 5_000,
  });
  return result.audioBuffer;
}

describe("production OpenAI binary transport", () => {
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
      let closed = false;
      await withServer(
        (request, response) => {
          request.resume();
          request.socket.once("close", () => {
            closed = true;
          });
          response.writeHead(200, { "Content-Type": "audio/mpeg" });
          response.write(stalled ? Buffer.from([1]) : Buffer.alloc(4096));
        },
        async (baseUrl) => {
          const result = requestAudio(baseUrl, {
            mediaMaxMb: 0.001,
            timeoutMs: stalled ? 300 : 5_000,
          });
          if (stalled) {
            await expect(result).rejects.toThrow(/timed out|aborted/i);
          } else {
            await expect(result).rejects.toThrow("OpenAI TTS audio response exceeds");
          }
          await vi.waitFor(() => expect(closed).toBe(true));
        },
      );
    }
  });

  it("persists audio capture through finalization and closes the rejected upstream socket", async () => {
    proxyReset.captureProxyEnv();
    const state = await createOpenClawTestState({ layout: "state-only", prefix: "binary-tcp-" });
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "1");
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_SESSION_ID", "binary-audio");
    let closed = false;
    let mediaResponses = 0;
    try {
      await initializeDebugProxyCaptureAsync("test");
      await withServer(
        (request, response) => {
          request.resume();
          if (mediaResponses++ === 0) {
            response.writeHead(200, { "Content-Type": "audio/ogg" });
            response.end("captured valid media");
          } else {
            request.socket.once("close", () => {
              closed = true;
            });
            response.writeHead(200, { "Content-Type": "image/png" });
            response.write("not the requested media");
            // Leave the body open: capture must not own the caller's completion.
          }
        },
        async (baseUrl) => {
          await expect(requestAudio(baseUrl)).resolves.toEqual(Buffer.from("captured valid media"));
          await expect(requestAudio(baseUrl)).rejects.toThrow("malformed audio response");
          await vi.waitFor(() => expect(closed).toBe(true));
          await finalizeDebugProxyCaptureAsync();
          await closeOpenClawStateDatabaseAsync();
          const reopened = createDebugProxyCaptureReaderAsync({ env: process.env });
          const persisted = await reopened.getSessionEvents("binary-audio", 20);
          expect(persisted.some((event) => event.kind === "request")).toBe(true);
          expect(persisted.some((event) => event.kind === "response")).toBe(true);
          expect(persisted).toHaveLength(4);
        },
      );
    } finally {
      await finalizeDebugProxyCaptureAsync();
      vi.unstubAllEnvs();
      await state.cleanup();
    }
  });
});
