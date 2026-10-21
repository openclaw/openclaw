import { OpenClaw } from "./client.js";
import { EventHub } from "./event-hub.js";
import type * as SDK from "./types.js";

export type RequestCall = {
  method: string;
  params?: unknown;
  options?: SDK.GatewayRequestOptions;
};

type FakeResponseValue = null | boolean | number | string | Record<string, unknown> | unknown[];
type FakeResponse =
  | FakeResponseValue
  | ((params: unknown, transport: FakeTransport) => Promise<FakeResponseValue> | FakeResponseValue);

export class FakeTransport implements SDK.OpenClawTransport {
  readonly calls: RequestCall[] = [];
  private readonly eventHub = new EventHub<SDK.GatewayEvent>({ replayLimit: 100 });
  emit = (event: SDK.GatewayEvent): void => this.eventHub.publish(event);
  close = (): void => this.eventHub.close();

  constructor(private readonly responses: Record<string, FakeResponse>) {}

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: SDK.GatewayRequestOptions,
  ): Promise<T> {
    this.calls.push({ method, params, options });
    const response = this.responses[method];
    return (typeof response === "function" ? await response(params, this) : response) as T;
  }

  events(filter?: (event: SDK.GatewayEvent) => boolean): AsyncIterable<SDK.GatewayEvent> {
    return this.eventHub.stream(filter, { replay: true });
  }
}

export function createClientFixture(responses: Record<string, FakeResponse> = {}) {
  const transport = new FakeTransport(responses);
  return { transport, oc: new OpenClaw({ transport }) };
}

export async function observeGatewaySequence(oc: OpenClaw, seq: number) {
  for await (const event of oc.events((eventLocal) => eventLocal.raw?.seq === seq)) {
    return event;
  }
  throw new Error(`event stream ended before sequence ${seq}`);
}

export const createAgentEvent = (
  runId: string,
  seq: number,
  ts: number,
  stream: string,
  data: Record<string, unknown>,
): SDK.GatewayEvent => ({ event: "agent", seq, payload: { runId, stream, ts, data } });

export function createChatEvent(
  runId: string,
  sessionKey: string,
  seq: number,
  state: "delta" | "final",
  text: string | undefined,
  timestamp: number,
  options: { deltaText?: string; replace?: true } = {},
): SDK.GatewayEvent {
  const message =
    text === undefined
      ? {}
      : { message: { role: "assistant", content: [{ type: "text", text }], timestamp } };
  return { event: "chat", seq, payload: { runId, sessionKey, state, ...options, ...message } };
}

export const createRunEventFixture = (
  runId: string,
  sessionKey: string,
  events: readonly SDK.GatewayEvent[],
) =>
  createClientFixture({
    agent: (_params, transport) => {
      events.forEach(transport.emit);
      return { status: "accepted", runId, sessionKey };
    },
  });
