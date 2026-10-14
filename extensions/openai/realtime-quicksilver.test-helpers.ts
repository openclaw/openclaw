import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type { RealtimeVoiceGatewayControl } from "openclaw/plugin-sdk/realtime-voice";
import { createMockIncomingRequest } from "openclaw/plugin-sdk/test-env";
import { vi, type Mock } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import { OpenAIQuicksilverDelegationController } from "./realtime-quicksilver-delegation-controller.js";
import { createOpenAIQuicksilverBrowserSessionBroker } from "./realtime-quicksilver-session.js";

type MockLogger = {
  debug: Mock<NonNullable<PluginLogger["debug"]>>;
  warn: Mock<PluginLogger["warn"]>;
};

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
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
    this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
  }
}

export function createRequest(params: {
  method?: string;
  token?: string;
  origin?: string;
  host?: string;
  contentType?: string;
  body?: string;
}): IncomingMessage {
  return Object.assign(createMockIncomingRequest([params.body ?? "v=offer\r\n"]), {
    method: params.method ?? "POST",
    headers: {
      ...(params.token ? { authorization: `Bearer ${params.token}` } : {}),
      ...(params.contentType === undefined
        ? { "content-type": "application/sdp" }
        : params.contentType
          ? { "content-type": params.contentType }
          : {}),
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

export function createResponseHarness(): {
  res: ServerResponse;
  end: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  readBody: () => string;
} {
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

export function createBroker(params?: {
  fetchImpl?: typeof fetch;
  runAgentConsult?: (params: { prompt: string; signal?: AbortSignal }) => Promise<{ text: string }>;
  socketFactory?: (attempt: number) => FakeSocket;
}) {
  const sockets: FakeSocket[] = [];
  const socketRequests: Array<{ url: string; headers?: Record<string, string> }> = [];
  const logger: MockLogger = {
    debug: vi.fn<NonNullable<PluginLogger["debug"]>>(),
    warn: vi.fn<PluginLogger["warn"]>(),
  };
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

export type ConsultRunner = ((params: {
  prompt: string;
  signal?: AbortSignal;
  requesterFinal?: { append: (text: string) => boolean };
}) => Promise<{ text: string; yielded?: true }>) & {
  adoptCompletionClaims?: () => void;
  claimAppend?: () => boolean;
  claimFailureAppend?: () => boolean;
  revokeRequesterFinal?: () => void;
  steer?: (params: { prompt: string; signal?: AbortSignal }) => Promise<{ text: string }>;
};

type DelegationHarness = {
  controller: OpenAIQuicksilverDelegationController;
  logger: MockLogger;
  onFatalError: Mock<NonNullable<RealtimeVoiceGatewayControl["onError"]>>;
  runAgentConsult: ConsultRunner;
  sessionController: AbortController;
  socket: FakeSocket;
};

export function createDelegationHarness(params?: {
  model?: string;
  claimAppend?: (() => boolean) | null;
  claimFailureAppend?: (() => boolean) | null;
  revokeRequesterFinal?: () => void;
  runAgentConsult?: ConsultRunner;
  steerAgentConsult?: ConsultRunner["steer"];
  handleDelegationInput?: RealtimeVoiceGatewayControl["handleDelegationInput"];
  getSocket?: () => FakeSocket;
  onWireEventType?: (eventType: string) => void;
  onTranscript?: (role: "user" | "assistant", text: string, done: boolean) => void;
}): DelegationHarness {
  const socket = new FakeSocket("manual");
  socket.readyState = 1;
  const logger: MockLogger = {
    debug: vi.fn<NonNullable<PluginLogger["debug"]>>(),
    warn: vi.fn<PluginLogger["warn"]>(),
  };
  const onFatalError = vi.fn<NonNullable<RealtimeVoiceGatewayControl["onError"]>>();
  const sessionController = new AbortController();
  const claimAppend =
    params?.claimAppend === null ? undefined : (params?.claimAppend ?? (() => true));
  const claimFailureAppend =
    params?.claimFailureAppend === null ? undefined : (params?.claimFailureAppend ?? (() => true));
  const runAgentConsult = Object.assign(
    params?.runAgentConsult ?? vi.fn(async () => ({ text: "Done" })),
    {
      ...(claimAppend ? { claimAppend } : {}),
      ...(claimFailureAppend ? { claimFailureAppend } : {}),
      ...(params?.revokeRequesterFinal
        ? { revokeRequesterFinal: params.revokeRequesterFinal }
        : {}),
      ...(params?.steerAgentConsult ? { steer: params.steerAgentConsult } : {}),
    },
  );
  const controller = new OpenAIQuicksilverDelegationController(
    {
      getSocket: params?.getSocket ?? (() => socket),
      handleDelegationInput: params?.handleDelegationInput,
      logger,
      model: params?.model ?? "gpt-live-test-canary",
      onFatalError,
      onWireEventType: params?.onWireEventType,
      onTranscript: params?.onTranscript,
      runAgentConsult,
      signal: sessionController.signal,
    },
    formatErrorMessage,
  );
  return { controller, logger, onFatalError, runAgentConsult, sessionController, socket };
}
