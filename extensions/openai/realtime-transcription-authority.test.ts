import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { createRealtimeTranscriptionWebSocketSession } from "openclaw/plugin-sdk/realtime-transcription-session";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenAIRealtimeHost } from "./realtime-host.js";
import { buildOpenAIRealtimeTranscriptionProvider } from "./realtime-transcription-provider-factory.js";

const { FakeWebSocket } = await vi.hoisted(async () => {
  const { createTranscriptionMockWebSocket } =
    await import("./realtime-transcription-socket.test-support.js");
  return { FakeWebSocket: createTranscriptionMockWebSocket() };
});

// Replace the external socket, retaining the production provider and session owners.
vi.mock("../../packages/gateway-client/src/websocket.js", () => ({
  WebSocket: FakeWebSocket,
}));

// Capture persistence is unrelated I/O; retain the real transport and authority decisions.
vi.mock("../../src/proxy-capture/runtime.js", () => ({
  captureWsEventAsync: vi.fn().mockResolvedValue(undefined),
}));

// Keep unrelated logging I/O outside the real guarded-fetch request path under test.
vi.mock("../../src/logger.js", () => ({ logWarn: vi.fn() }));

afterEach(() => {
  for (const socket of FakeWebSocket.instances) {
    socket.close();
  }
  FakeWebSocket.instances = [];
  FakeWebSocket.onCreated = undefined;
  vi.unstubAllEnvs();
});

it.each([
  { phase: "credentials", revoke: true },
  { phase: "transport", revoke: true },
  { phase: "transport", revoke: false },
] as const)(
  "guards client-secret hints after $phase preparation (revoked: $revoke)",
  async ({ phase, revoke }) => {
    const paused = createDeferred<void>();
    const resume = createDeferred<void>();
    const socketCreated = createDeferred<InstanceType<typeof FakeWebSocket>>();
    FakeWebSocket.onCreated = (socket) => socketCreated.resolve(socket);
    const revokedError = new Error("Transcription authority revoked");
    let revoked = false;
    const onError = vi.fn();
    const fetchImpl = vi.fn<NonNullable<Parameters<typeof fetchWithSsrFGuard>[0]["fetchImpl"]>>();
    fetchImpl.mockResolvedValue(Response.json({ value: "ek-test" }));
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "");
    const unexpected = () => {
      throw new Error("Unexpected unrelated host operation");
    };
    const guardedFetch = vi.fn((params: Parameters<typeof fetchWithSsrFGuard>[0]) =>
      fetchWithSsrFGuard({
        ...params,
        capture: false,
        fetchImpl,
        lookupFn: async () => {
          if (phase === "transport") {
            paused.resolve();
            await resume.promise;
          }
          return [{ address: "93.184.216.34", family: 4 }];
        },
      }),
    );
    const runtime: OpenAIRealtimeHost = {
      resolveAgentDir: unexpected,
      isProviderAuthProfileConfigured: unexpected,
      isProviderAuthProfileConfiguredAsync: unexpected,
      resolveProviderAuthProfileApiKey: async () => {
        if (phase === "credentials") {
          paused.resolve();
          await resume.promise;
        }
        return "sk-profile"; // pragma: allowlist secret
      },
      resolveProviderRequestHeaders: ({ defaultHeaders }) => defaultHeaders,
      createRealtimeTranscriptionWebSocketSession,
      captureWsEventAsync: unexpected,
      createDebugProxyWebSocketAgent: unexpected,
      resolveDebugProxySettings: unexpected,
      fetchWithSsrFGuard: guardedFetch,
      createProviderHttpError: unexpected,
      readProviderJsonResponse: vi.fn().mockResolvedValue({ value: "ek-test" }),
      readProviderTextResponse: unexpected,
      formatErrorMessage: unexpected,
      warn: unexpected,
      redactSensitiveText: unexpected,
    };
    const session = buildOpenAIRealtimeTranscriptionProvider(runtime).createSession({
      providerConfig: { prompt: "PostgreSQL and Ariadna" },
      assertCurrent: () => {
        if (revoked) {
          throw revokedError;
        }
      },
      onError,
    });
    // Attach a rejection observer before releasing either asynchronous I/O boundary.
    const connecting = session.connect().then(
      () => undefined,
      (error: unknown) => error,
    );
    await paused.promise;
    revoked = revoke;
    resume.resolve();
    if (!revoke) {
      const socket = await socketCreated.promise;
      socket.readyState = FakeWebSocket.OPEN;
      socket.emit("open");
      socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
      expect(await connecting).toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledOnce();
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe("https://api.openai.com/v1/realtime/client_secrets");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        session: { audio: { input: { transcription: { prompt: "PostgreSQL and Ariadna" } } } },
      });
      expect(socket.sent.map((value) => JSON.parse(value))).toMatchObject([
        {
          type: "session.update",
          session: {
            audio: {
              input: {
                transcription: { model: "gpt-4o-transcribe", prompt: "PostgreSQL and Ariadna" },
              },
            },
          },
        },
      ]);
      expect(onError).not.toHaveBeenCalled();
      session.close();
      return;
    }
    const error = await connecting;
    if (phase === "credentials") {
      expect(guardedFetch).not.toHaveBeenCalled();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(error).toBe(revokedError);
    expect(onError).toHaveBeenCalledExactlyOnceWith(revokedError);
  },
);
