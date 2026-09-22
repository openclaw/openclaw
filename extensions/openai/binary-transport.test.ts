import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
// Reject ambiguous provider media before it becomes a user-visible artifact.
import * as providerHttp from "openclaw/plugin-sdk/provider-http";
import {
  createDebugProxyCaptureReader,
  finalizeDebugProxyCapture,
  getDebugProxyCaptureStore,
  initializeDebugProxyCapture,
} from "openclaw/plugin-sdk/proxy-capture";
import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import { installDebugProxyTestResetHooks } from "../test-support/debug-proxy-env-test-helpers.js";
import { buildOpenAISpeechProvider } from "./speech-provider.js";
import { buildOpenAIVideoGenerationProvider } from "./video-generation-provider.js";

const proxyReset = installDebugProxyTestResetHooks();
const modelAuth = createCapturedPluginRegistration().api.runtime.modelAuth;

async function requestMedia(
  baseUrl: string,
  kind: "audio" | "video",
  options: { timeoutMs?: number; mediaMaxMb?: number } = {},
) {
  const budget =
    options.mediaMaxMb === undefined
      ? {}
      : { agents: { defaults: { mediaMaxMb: options.mediaMaxMb } } };
  if (kind === "audio") {
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
  const result = await buildOpenAIVideoGenerationProvider(modelAuth).generateVideo({
    provider: "openai",
    model: "sora-2",
    prompt: "local binary acceptance",
    cfg: {
      ...budget,
      models: {
        providers: {
          openai: {
            apiKey: "local-test-key",
            baseUrl: `${baseUrl}/v1`,
            models: [],
            request: { allowPrivateNetwork: true },
          },
        },
      },
    },
    timeoutMs: options.timeoutMs ?? 5_000,
  });
  return result.videos[0]?.buffer;
}

describe("production OpenAI binary transport", () => {
  it.each(["audio", "video"] as const)(
    "rejects invalid %s over TCP and preserves valid codec parameters",
    async (kind) => {
      const type = kind === "audio" ? "audio/ogg" : "video/mp4";
      const cases = [
        { header: "image/png", body: "wrong family", valid: false },
        { header: "", body: "empty header", valid: false },
        { header: `${type}; charset=utf-8, text/html`, body: "hidden error", valid: false },
        { header: [type, "application/json"], body: "repeated header", valid: false },
        { header: type, body: "", valid: false },
        { header: "application/ogg", body: "Ogg container bytes", valid: kind === "audio" },
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
            if (request.url === "/v1/videos") {
              response.setHeader("Content-Type", "application/json");
              response.end(JSON.stringify({ id: "local-video", status: "completed" }));
            } else {
              if (fixture.header !== undefined) {
                response.setHeader("Content-Type", fixture.header);
              }
              response.end(fixture.body);
            }
          },
          async (baseUrl) => {
            const result = requestMedia(baseUrl, kind);
            if (fixture.valid) {
              await expect(result).resolves.toEqual(Buffer.from(fixture.body));
            } else {
              await expect(result).rejects.toThrow(`malformed ${kind} response`);
            }
          },
        );
      }
    },
  );

  it.each(["audio", "video"] as const)(
    "preserves %s byte limits and transport timeouts over TCP",
    async (kind) => {
      for (const stalled of [false, true]) {
        let closed = false;
        await withServer(
          (request, response) => {
            request.resume();
            if (request.url === "/v1/videos") {
              response.writeHead(200, { "Content-Type": "application/json" });
              response.end(JSON.stringify({ id: "budget-video", status: "completed" }));
            } else {
              request.socket.once("close", () => {
                closed = true;
              });
              response.writeHead(200, {
                "Content-Type": kind === "audio" ? "audio/mpeg" : "video/mp4",
              });
              response.write(stalled ? Buffer.from([1]) : Buffer.alloc(4096));
            }
          },
          async (baseUrl) => {
            const result = requestMedia(baseUrl, kind, {
              mediaMaxMb: 0.001,
              timeoutMs: stalled ? 300 : 5_000,
            });
            if (stalled) {
              await expect(result).rejects.toThrow(/timed out|aborted/i);
            } else {
              await expect(result).rejects.toThrow(
                kind === "audio"
                  ? "OpenAI TTS audio response exceeds"
                  : "OpenAI generated video download exceeds",
              );
            }
            await vi.waitFor(() => expect(closed).toBe(true));
          },
        );
      }
    },
  );

  it.each([
    { status: "queued", reference: "text" },
    { status: "queued", reference: "image" },
    { status: "queued", reference: "video" },
    { status: "completed", reference: "text" },
    { status: "completed", reference: "video" },
  ])(
    "releases $status $reference submission before real follow-up transport",
    async ({ status, reference }) => {
      const originalPost = providerHttp.postMultipartRequest;
      let releases = 0;
      let released = false;
      let clone: Response | undefined;
      const paths: string[] = [];
      const releasedAtFollowUp: boolean[] = [];
      const post = vi
        .spyOn(providerHttp, "postMultipartRequest")
        .mockImplementation(async (params) => {
          const handle = await originalPost(params);
          clone = handle.response.clone();
          return {
            ...handle,
            release: async () => {
              releases += 1;
              await handle.release();
              released = true;
            },
          };
        });
      try {
        await withServer(
          (request, response) => {
            request.resume();
            paths.push(request.url ?? "");
            if (request.method === "GET") {
              releasedAtFollowUp.push(released);
            }
            if (request.url?.includes("/content")) {
              response.setHeader("Content-Type", "video/mp4");
              response.end("rendered-video");
            } else {
              response.setHeader("Content-Type", "application/json");
              response.end(
                JSON.stringify({
                  id: "release-video",
                  status: request.method === "POST" ? status : "completed",
                }),
              );
            }
          },
          async (baseUrl) => {
            const result = await buildOpenAIVideoGenerationProvider(modelAuth).generateVideo({
              provider: "openai",
              model: "sora-2",
              prompt: "release submission before follow-up",
              cfg: {
                models: {
                  providers: {
                    openai: {
                      apiKey: "local-test-key",
                      baseUrl: `${baseUrl}/v1`,
                      models: [],
                      request: { allowPrivateNetwork: true },
                    },
                  },
                },
              },
              timeoutMs: 5_000,
              ...(reference === "image"
                ? { inputImages: [{ buffer: Buffer.from("image"), mimeType: "image/png" }] }
                : {}),
              ...(reference === "video"
                ? { inputVideos: [{ buffer: Buffer.from("video"), mimeType: "video/mp4" }] }
                : {}),
            });
            expect(result.videos[0]?.buffer).toEqual(Buffer.from("rendered-video"));
            expect(paths[0]).toBe(reference === "video" ? "/v1/videos/edits" : "/v1/videos");
            expect(paths).toHaveLength(status === "queued" ? 3 : 2);
            expect(releases).toBe(1);
            expect(releasedAtFollowUp).toEqual(status === "queued" ? [true, true] : [true]);
          },
        );
      } finally {
        post.mockRestore();
        void clone?.body?.cancel().catch(() => undefined);
      }
    },
  );

  it.each([
    {
      label: "HTTP failure",
      status: 400,
      body: '{"error":{"message":"submission refused"}}',
      error: "submission refused",
    },
    { label: "malformed JSON", status: 200, body: "{", error: "malformed JSON response" },
    { label: "missing id", status: 200, body: '{"status":"queued"}', error: "missing video id" },
    {
      label: "failed job",
      status: 200,
      body: '{"status":"failed","error":{"message":"job refused"}}',
      error: "job refused",
    },
  ])("releases failed submission exactly once: $label", async ({ status, body, error }) => {
    const originalPost = providerHttp.postMultipartRequest;
    let releases = 0;
    let requests = 0;
    const post = vi
      .spyOn(providerHttp, "postMultipartRequest")
      .mockImplementation(async (params) => {
        const handle = await originalPost(params);
        return {
          ...handle,
          release: async () => {
            releases += 1;
            await handle.release();
          },
        };
      });
    try {
      await withServer(
        (request, response) => {
          requests += 1;
          request.resume();
          response.writeHead(status, { "Content-Type": "application/json" });
          response.end(body);
        },
        async (baseUrl) => {
          await expect(requestMedia(baseUrl, "video")).rejects.toThrow(error);
          expect(releases).toBe(1);
          expect(requests).toBe(1);
        },
      );
    } finally {
      post.mockRestore();
    }
  });

  it.each(["audio", "video"] as const)(
    "persists %s capture and closes its SQLite store and rejected upstream socket",
    async (kind) => {
      proxyReset.captureProxyEnv();
      const state = await createOpenClawTestState({ layout: "state-only", prefix: "binary-tcp-" });
      vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "1");
      vi.stubEnv("OPENCLAW_DEBUG_PROXY_SESSION_ID", `binary-${kind}`);
      let closed = false;
      let mediaResponses = 0;
      try {
        initializeDebugProxyCapture("test");
        const store = getDebugProxyCaptureStore();
        await withServer(
          (request, response) => {
            request.resume();
            if (request.url === "/v1/videos") {
              response.setHeader("Content-Type", "application/json");
              response.end(JSON.stringify({ id: "local-video", status: "completed" }));
            } else if (mediaResponses++ === 0) {
              response.writeHead(200, {
                "Content-Type": kind === "audio" ? "audio/ogg" : "video/mp4",
              });
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
            await expect(requestMedia(baseUrl, kind)).resolves.toEqual(
              Buffer.from("captured valid media"),
            );
            await expect(requestMedia(baseUrl, kind)).rejects.toThrow(`malformed ${kind} response`);
            await vi.waitFor(() => expect(closed).toBe(true));
            await vi.waitFor(() => {
              const events = store.getSessionEvents(`binary-${kind}`, 20);
              expect(events.some((event) => event.kind === "request")).toBe(true);
              expect(events.some((event) => event.kind === "response")).toBe(true);
              expect(events).toHaveLength(kind === "audio" ? 4 : 8);
            });
            finalizeDebugProxyCapture();
            expect(store.isClosed).toBe(true);
            closeOpenClawStateDatabaseForTest();
            const reader = createDebugProxyCaptureReader({ env: process.env });
            const persisted = reader.getSessionEvents(`binary-${kind}`, 20);
            expect(persisted.some((event) => event.kind === "request")).toBe(true);
            expect(persisted.some((event) => event.kind === "response")).toBe(true);
            expect(persisted).toHaveLength(kind === "audio" ? 4 : 8);
          },
        );
      } finally {
        finalizeDebugProxyCapture();
        vi.unstubAllEnvs();
        await state.cleanup();
      }
    },
  );
});
