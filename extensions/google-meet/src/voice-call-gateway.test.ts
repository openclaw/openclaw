import { createServer } from "node:http";
import { setImmediate } from "node:timers/promises";
import { getMeetingVoiceCallGatewayCall } from "openclaw/plugin-sdk/meeting-runtime";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { resolveGoogleMeetConfig } from "./config.js";
import { createVoiceCallGateway, joinMeetViaVoiceCallGateway } from "./voice-call-gateway.js";

type GatewayRuntime = typeof import("openclaw/plugin-sdk/gateway-runtime");
type GatewayClientOptions = ConstructorParameters<GatewayRuntime["GatewayClient"]>[0];
type GatewayClientInstance = InstanceType<GatewayRuntime["GatewayClient"]>;
const ready = { ready: true, aborted: false, elapsedMs: 0, maxDriftMs: 0, checks: 1 };

const mocks = vi.hoisted(() => ({
  runtimeRequest: vi.fn(),
  request: vi.fn(),
  stopAndWait: vi.fn(async () => {}),
  startClient: vi.fn<GatewayRuntime["startGatewayClientWhenEventLoopReady"]>(),
  autoHello: true,
  clientOptions: undefined as GatewayClientOptions | undefined,
  actualGatewayClient: undefined as GatewayRuntime["GatewayClient"] | undefined,
  actualClients: [] as GatewayClientInstance[],
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", async (importOriginal) => ({
  ...(await importOriginal<GatewayRuntime>()),
  GatewayClient: vi.fn(function MockGatewayClient(params: GatewayClientOptions) {
    mocks.clientOptions = params;
    if (mocks.actualGatewayClient) {
      const client = new mocks.actualGatewayClient({ ...params, deviceIdentity: null });
      mocks.actualClients.push(client);
      return client;
    }
    if (mocks.autoHello) {
      queueMicrotask(() => params.onHelloOk?.({} as never));
    }
    return {
      request: mocks.request,
      stopAndWait: mocks.stopAndWait,
    };
  }),
  startGatewayClientWhenEventLoopReady: mocks.startClient,
}));

function voiceConfig(
  voiceCall: Partial<ReturnType<typeof resolveGoogleMeetConfig>["voiceCall"]> = {},
) {
  return resolveGoogleMeetConfig({
    voiceCall: { gatewayUrl: "wss://voice.example.test", ...voiceCall },
  });
}
function createGateway(config = voiceConfig()) {
  return createVoiceCallGateway({
    config,
    runtime: { gateway: { request: mocks.runtimeRequest } } as never,
  });
}
function getCall(config = voiceConfig()) {
  return getMeetingVoiceCallGatewayCall({ gateway: createGateway(config), callId: "call-1" });
}
function join(
  config = voiceConfig(),
  options: Partial<Parameters<typeof joinMeetViaVoiceCallGateway>[0]> = {},
) {
  return joinMeetViaVoiceCallGateway({
    config,
    gateway: createGateway(config),
    dialInNumber: "+15551234567",
    ...options,
  });
}
beforeEach(() => {
  vi.useRealTimers();
  mocks.request.mockReset().mockResolvedValue({ success: true });
  mocks.runtimeRequest.mockReset().mockResolvedValue({ callId: "call-1" });
  mocks.stopAndWait.mockReset().mockResolvedValue(undefined);
  mocks.startClient.mockReset().mockResolvedValue(ready);
  mocks.autoHello = true;
  mocks.clientOptions = undefined;
  mocks.actualGatewayClient = undefined;
  mocks.actualClients.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/gateway-runtime");
  vi.resetModules();
});

it("stops the real gateway client's referenced reconnect after a localhost connection fails", async () => {
  const actual = await vi.importActual<GatewayRuntime>("openclaw/plugin-sdk/gateway-runtime");
  mocks.actualGatewayClient = actual.GatewayClient;
  mocks.startClient.mockImplementation((client, options) =>
    actual.startGatewayClientWhenEventLoopReady(
      client as Parameters<GatewayRuntime["startGatewayClientWhenEventLoopReady"]>[0],
      options,
    ),
  );

  const server = createServer();
  let connectionCount = 0;
  server.on("upgrade", (_request, socket) => {
    connectionCount += 1;
    socket.destroy();
  });
  const port = await listenOnLoopback(server);

  // Control readiness and deadlines while socket I/O and setImmediate stay real.
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const stopAndWait = vi.spyOn(actual.GatewayClient.prototype, "stopAndWait");
  const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
  const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
  try {
    const config = voiceConfig({
      gatewayUrl: `ws://127.0.0.1:${port}`,
      requestTimeoutMs: 3_000,
    });
    const rejected = expect(getCall(config)).rejects.toMatchObject({
      code: "ECONNRESET",
      message: "socket hang up",
    });
    await vi.advanceTimersByTimeAsync(2);
    await rejected;
    expect(mocks.actualClients).toHaveLength(1);

    await setImmediate();
    const referencedRetry = setTimeoutSpy.mock.calls.some(([, delay], index) => {
      const timer = setTimeoutSpy.mock.results[index]?.value as NodeJS.Timeout | undefined;
      return (
        delay === 1_000 &&
        timer?.hasRef() === true &&
        !clearTimeoutSpy.mock.calls.some(([cleared]) => cleared === timer)
      );
    });

    expect({
      stopCalls: stopAndWait.mock.calls.length,
      connectionCount,
      referencedRetry,
    }).toEqual({ stopCalls: 1, connectionCount: 1, referencedRetry: false });
    expect(mocks.runtimeRequest).not.toHaveBeenCalled();
  } finally {
    await Promise.all(mocks.actualClients.map((client) => client.stopAndWait()));
    await server[Symbol.asyncDispose]();
  }
});

const connectionError = new Error("external voice gateway refused the connection");
it.each([
  [
    "connection",
    connectionError,
    () => mocks.stopAndWait.mockRejectedValueOnce(new Error("gateway teardown failed")),
    () => mocks.clientOptions?.onConnectError?.(connectionError),
  ],
  [
    "readiness",
    "gateway event loop readiness timeout",
    () => mocks.startClient.mockResolvedValueOnce({ ...ready, ready: false }),
    () => {},
  ],
  [
    "deadline",
    "gateway connect timeout",
    () => vi.useFakeTimers(),
    () => vi.advanceTimersByTimeAsync(25),
  ],
] satisfies Array<[string, Error | string, () => unknown, () => unknown]>)(
  "cleans up a failed %s without losing its error",
  async (failure, expected, prepare, settle) => {
    mocks.autoHello = false;
    prepare();
    const request = getCall(
      failure === "deadline" ? voiceConfig({ requestTimeoutMs: 25 }) : undefined,
    );
    const rejected =
      expected instanceof Error
        ? expect(request).rejects.toBe(expected)
        : expect(request).rejects.toThrow(expected);
    await settle();
    await rejected;
    expect(mocks.stopAndWait).toHaveBeenCalledOnce();
    expect(mocks.startClient.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    if (failure === "connection") {
      expect(mocks.request).not.toHaveBeenCalled();
    }
    if (failure === "deadline") {
      expect(vi.getTimerCount()).toBe(0);
    }
  },
);

it("starts Twilio Meet calls with pre-connect DTMF, then speaks the intro without TwiML fallback", async () => {
  const config = voiceConfig({ postDtmfSpeechDelayMs: 2 });
  const routing = {
    dtmfSequence: "123456#",
    requesterSessionKey: "agent:main:discord:channel:general",
    sessionKey: "voice:google-meet:meet-1",
  };
  const message = "Say exactly: I'm here and listening.";
  const timeout = { timeoutMs: 30_000 };
  mocks.request
    .mockResolvedValueOnce({ callId: "call-1" })
    .mockResolvedValueOnce({ success: true });
  await join(config, { ...routing, message });

  expect(mocks.request.mock.calls).toEqual([
    ["voicecall.start", { to: "+15551234567", mode: "conversation", ...routing }, timeout],
    ["voicecall.speak", { callId: "call-1", allowTwimlFallback: false, message }, timeout],
  ]);
  expect(mocks.runtimeRequest).not.toHaveBeenCalled();
});

it("rejects per-agent routing through an external Voice Call gateway", async () => {
  await expect(join(undefined, { agentId: "support" })).rejects.toThrow(
    "requires the local Gateway runtime",
  );
  expect(mocks.request).not.toHaveBeenCalled();
});

it("preserves a successful mutating RPC result when client teardown fails", async () => {
  mocks.request.mockResolvedValueOnce({ callId: "call-1" });
  mocks.stopAndWait.mockRejectedValueOnce(new Error("gateway teardown failed"));
  await expect(join()).resolves.toMatchObject({ callId: "call-1" });
  expect(mocks.stopAndWait).toHaveBeenCalledOnce();
});
