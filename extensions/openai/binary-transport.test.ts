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
      },
      target: "audio-file",
      timeoutMs: budget === "time" ? 300 : 5_000,
    })
    .then(({ audioBuffer }) => audioBuffer);
}

it.each<[string | string[] | undefined, boolean, string?]>([
  ["image/png", false],
  ["", false],
  ["audio/ogg; charset=utf-8, text/html", false],
  [["audio/ogg", "application/json"], false],
  ["audio/ogg", false, ""],
  ["application/ogg", true],
  ["application/octet-stream", true],
  ["binary/octet-stream", true],
  [undefined, true],
  ['audio/ogg; codecs="one, two"', true],
  ['audio/ogg;; codecs="one, two";', true],
])("validates TCP audio header %j (accepted=%s)", (header, valid, body = "audio") =>
  withServer(
    (request, response) => {
      request.resume();
      if (header !== undefined) {
        response.setHeader("Content-Type", header);
      }
      response.end(body);
    },
    async (baseUrl) => {
      const result = requestAudio(baseUrl);
      await (valid
        ? expect(result).resolves.toEqual(Buffer.from(body))
        : expect(result).rejects.toThrow("malformed audio response"));
    },
  ),
);

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
