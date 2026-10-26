import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceGatewayControl,
} from "openclaw/plugin-sdk/realtime-voice";
import { createMockIncomingRequest } from "openclaw/plugin-sdk/test-env";
import { vi } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import { OpenAIQuicksilverDelegationController } from "./realtime-quicksilver-delegation-controller.js";
import { createOpenAIQuicksilverBrowserSessionBroker } from "./realtime-quicksilver-session.js";

const createLogger = () => ({
  debug: vi.fn<NonNullable<PluginLogger["debug"]>>(),
  warn: vi.fn<PluginLogger["warn"]>(),
});

export class FakeSocket extends EventEmitter {
  readyState: 0 | 1 | 2 | 3 = 0;
  sent: string[] = [];
  closed = false;
  closeCode?: number;
  closeReason?: string;

  constructor(autoEvent: "open" | "error" | "close" | "manual" = "open") {
    super();
    queueMicrotask(() => {
      if (autoEvent === "open") {
        this.readyState = 1;
        this.emit("open");
      } else if (autoEvent === "error") {
        this.emit("error", new Error("transient sideband failure"));
      } else if (autoEvent === "close") {
        this.emit("close");
      }
    });
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code?: number, reason?: string): void {
    if (!this.closed) {
      this.closed = true;
      this.closeCode = code;
      this.closeReason = reason;
      this.readyState = 3;
      this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
    }
  }
}

export function createRequest(
  params: Partial<Record<"method" | "token" | "origin" | "host" | "contentType" | "body", string>>,
): IncomingMessage {
  const contentType = params.contentType ?? "application/sdp";
  return Object.assign(createMockIncomingRequest([params.body ?? "v=offer\r\n"]), {
    method: params.method ?? "POST",
    headers: {
      ...(params.token ? { authorization: `Bearer ${params.token}` } : {}),
      ...(contentType ? { "content-type": contentType } : {}),
      ...(params.origin ? { origin: params.origin } : {}),
      ...(params.host ? { host: params.host } : {}),
    },
  });
}

export function createPreflightRequest(origin: string, host?: string): IncomingMessage {
  return Object.assign(createMockIncomingRequest([]), {
    method: "OPTIONS",
    headers: {
      origin,
      ...(host ? { host } : {}),
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
      "access-control-request-private-network": "true",
    },
  });
}

export function createResponseHarness() {
  let body = "";
  const setHeader = vi.fn();
  const end = vi.fn((value?: string) => {
    body = value ?? "";
    queueMicrotask(() => res.emit("finish"));
  });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader,
    end,
  }) as unknown as ServerResponse;
  return { res, end, setHeader, readBody: () => body };
}

export function createCallResponse(answer = "v=answer\r\n", callId = "rtc_test"): Response {
  return new Response(answer, {
    status: 201,
    headers: { Location: `/v1/live/${callId}?source=test` },
  });
}

export function parseSent(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent.map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

export function emitSideband(socket: FakeSocket, payload: unknown, isBinary = false): void {
  socket.emit("message", Buffer.from(JSON.stringify(payload)), isBinary);
}

export function publicTranscript(
  role: "user" | "assistant",
  delta: string,
  start_ms = 0,
  end_ms = 100,
) {
  return {
    type: `session.${role === "user" ? "input" : "output"}_transcript.delta`,
    delta,
    start_ms,
    end_ms,
  };
}

export function createBroker(params?: {
  fetchImpl?: typeof fetch;
  runAgentConsult?: (params: { prompt: string; signal?: AbortSignal }) => Promise<{ text: string }>;
  socketFactory?: (attempt: number) => FakeSocket;
}) {
  const sockets: FakeSocket[] = [];
  const socketRequests: Array<{ url: string; headers?: Record<string, string> }> = [];
  const logger = createLogger();
  const realtime = createOpenAIQuicksilverBrowserSessionBroker(
    {
      getConfig: () => ({
        gateway: { controlUi: { allowedOrigins: ["https://control.example"] } },
      }),
      logger,
      fetchImpl: params?.fetchImpl ?? vi.fn(async () => createCallResponse()),
      webSocketFactory: (url, options) => {
        const socket = params?.socketFactory?.(sockets.length) ?? new FakeSocket();
        sockets.push(socket);
        socketRequests.push({
          url,
          headers: options.headers as Record<string, string> | undefined,
        });
        return socket;
      },
    },
    openAIRealtimeHost,
  );
  const runAgentConsult = Object.assign(
    params?.runAgentConsult ?? vi.fn(async () => ({ text: "Done" })),
    { claimAppend: vi.fn(() => true) },
  );
  return { realtime, sockets, socketRequests, logger, runAgentConsult };
}

export type TestBroker = ReturnType<typeof createBroker>["realtime"];
type SessionRequest = Parameters<TestBroker["broker"]["createBrowserSession"]>[0];
export const AUDIO_ONLY_SDP = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";

export async function reserveSession(
  realtime: TestBroker,
  request: SessionRequest,
  auth: Parameters<TestBroker["broker"]["createBrowserSession"]>[1] = {
    type: "api-key",
    token: "platform-key",
  },
) {
  const reservation = await realtime.broker.createBrowserSession(request, auth);
  if (reservation.transport !== "webrtc") {
    throw new Error("Expected WebRTC reservation");
  }
  return reservation;
}

type LiveSessionOverrides<T = RealtimeVoiceBrowserSessionCreateRequest> = T extends unknown
  ? Omit<T, "providerConfig"> & { ownerConnId?: string }
  : never;
export function reserveLiveSession(realtime: TestBroker, overrides: LiveSessionOverrides = {}) {
  return reserveSession(realtime, {
    providerConfig: {},
    model: "gpt-live-test-canary",
    runAgentConsult: vi.fn(async () => ({ text: "Done" })),
    ...overrides,
  });
}

export function reserveGaSession(
  realtime: TestBroker,
  createBridge: (params: {
    apiKey: string;
    callId: string;
    onTerminal: () => void;
  }) => RealtimeVoiceBridge,
  gatewayControl: RealtimeVoiceGatewayControl = { bindBridge: vi.fn() },
  ownerConnId?: string,
) {
  return reserveSession(realtime, {
    providerConfig: {},
    model: "gpt-realtime-2.1",
    gaSession: { type: "realtime", model: "gpt-realtime-2.1" },
    gaSideband: { createBridge },
    clientControl: { owner: "gateway" },
    gatewayControl,
    ...(ownerConnId ? { ownerConnId } : {}),
  });
}

export async function postOffer(realtime: TestBroker, params: Parameters<typeof createRequest>[0]) {
  const { response, handling } = startOffer(realtime, params);
  await handling;
  return response;
}

export function startOffer(realtime: TestBroker, params: Parameters<typeof createRequest>[0]) {
  const response = createResponseHarness();
  return { response, handling: realtime.handler(createRequest(params), response.res) };
}

export function makeBridge(overrides: Partial<RealtimeVoiceBridge> = {}) {
  return {
    connect: vi.fn(async () => undefined),
    close: vi.fn(),
    sendAudio: vi.fn(),
    setMediaTimestamp: vi.fn(),
    submitToolResult: vi.fn(),
    acknowledgeMark: vi.fn(),
    isConnected: vi.fn(() => true),
    ...overrides,
  } satisfies RealtimeVoiceBridge;
}

export function requestTarget(url: string | URL | Request): string {
  return typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
}

type DelegationOptions = ConstructorParameters<typeof OpenAIQuicksilverDelegationController>[0];
export type ConsultRunner = DelegationOptions["runAgentConsult"];

export function createDelegationHarness(params?: {
  model?: string;
  claimAppend?: (() => boolean) | null;
  claimFailureAppend?: (() => boolean) | null;
  revokeRequesterFinal?: () => void;
  runAgentConsult?: ConsultRunner;
  steerAgentConsult?: ConsultRunner["steer"];
  handleDelegationInput?: DelegationOptions["handleDelegationInput"];
  getSocket?: () => FakeSocket;
  onWireEventType?: (eventType: string) => void;
  onTranscript?: DelegationOptions["onTranscript"];
}) {
  const {
    claimAppend = () => true,
    claimFailureAppend = () => true,
    revokeRequesterFinal,
    runAgentConsult: runner = vi.fn(async () => ({ text: "Done" })),
    steerAgentConsult: steer,
    ...options
  } = params ?? {};
  const socket = new FakeSocket("manual");
  socket.readyState = 1;
  const logger = createLogger();
  const onFatalError = vi.fn<DelegationOptions["onFatalError"]>();
  const sessionController = new AbortController();
  const runAgentConsult: ConsultRunner = Object.assign(runner, {
    ...(claimAppend ? { claimAppend } : {}),
    ...(claimFailureAppend ? { claimFailureAppend } : {}),
    ...(revokeRequesterFinal ? { revokeRequesterFinal } : {}),
    ...(steer ? { steer } : {}),
  });
  const controller = new OpenAIQuicksilverDelegationController(
    {
      ...options,
      getSocket: options.getSocket ?? (() => socket),
      logger,
      model: options.model ?? "gpt-live-test-canary",
      onFatalError,
      runAgentConsult,
      signal: sessionController.signal,
    },
    formatErrorMessage,
  );
  return { controller, logger, onFatalError, runAgentConsult, sessionController, socket };
}
