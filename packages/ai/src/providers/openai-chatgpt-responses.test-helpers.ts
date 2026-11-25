import type { AddressInfo } from "node:net";
import { vi, type Mock } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context } from "../types.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
  streamOpenAICodexResponses,
} from "./openai-chatgpt-responses.js";
import { makeProviderModel } from "./provider-model.test-support.js";

export const chatgptModel = makeProviderModel("openai-chatgpt-responses", "openai", "gpt-5.5", {
  name: "GPT-5.5",
  baseUrl: "https://chatgpt.test/backend-api",
  maxTokens: 16_000,
});
export const chatgptContext: Context = {
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
};

export function completedResponse(id = "resp_test") {
  return {
    type: "response.completed",
    response: {
      id,
      status: "completed",
      output: [],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  };
}

export function createJwt(
  payload: object = {
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
  },
): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

export function resetChatgptTransport() {
  closeOpenAICodexWebSocketSessions();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetOpenAICodexWebSocketStateForTest();
  configureAiTransportHost({});
}

export function sseResponse(...events: object[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

export function completedSseResponse(id = "resp_test"): Response {
  return sseResponse(completedResponse(id));
}

export function createLoopbackModel(server: { address(): AddressInfo | string | null }) {
  return {
    ...chatgptModel,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/backend-api`,
  };
}

export async function closeServer(
  server: {
    close(callback: (error?: Error) => void): unknown;
  },
  clients: Iterable<{ terminate(): void }> = [],
) {
  for (const socket of clients) {
    socket.terminate();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export type ChatgptOptions = NonNullable<Parameters<typeof streamOpenAICodexResponses>[2]>;
export function runChatgpt(
  options: ChatgptOptions = {},
  context = chatgptContext,
  model = chatgptModel,
) {
  return streamOpenAICodexResponses(model, context, { apiKey: createJwt(), ...options }).result();
}

export function emitWebSocket(socket: EventTarget, event: object) {
  socket.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) }));
}

type FixtureSocket = EventTarget & {
  connectionId: number;
  readyState?: number;
  closed: boolean;
  sendCount: number;
  send(payload: string): void;
  close(): void;
};

export function installWebSocket(
  reply: (socket: FixtureSocket, payload: string) => void,
  open = true,
  options: { deferReply?: boolean; trackReadyState?: boolean } = {},
): {
  sockets: FixtureSocket[];
  close: Mock<(connectionId: number) => void>;
  send: Mock<typeof reply>;
} {
  const sockets: FixtureWebSocket[] = [];
  const close = vi.fn<(connectionId: number) => void>();
  const send = vi.fn(reply);
  class FixtureWebSocket extends EventTarget {
    readonly connectionId = sockets.length + 1;
    declare readyState?: number;
    closed = false;
    sendCount = 0;
    constructor() {
      super();
      sockets.push(this);
      if (options.trackReadyState !== false) {
        this.readyState = 1;
      }
      if (open) {
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
    }
    send(payload: string) {
      this.sendCount++;
      if (options.deferReply !== false) {
        queueMicrotask(() => send(this, payload));
      } else {
        send(this, payload);
      }
    }
    close() {
      if (options.trackReadyState !== false) {
        this.readyState = 3;
      }
      this.closed = true;
      close(this.connectionId);
    }
  }
  vi.stubGlobal("WebSocket", FixtureWebSocket);
  return { sockets, close, send };
}
