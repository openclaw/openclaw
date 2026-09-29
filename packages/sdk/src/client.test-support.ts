import { OpenClaw } from "./client.js";
import { EventHub } from "./event-hub.js";
import type {
  GatewayEvent,
  GatewayRequestOptions,
  OpenClawEvent,
  OpenClawTransport,
} from "./types.js";

export type RequestCall = {
  method: string;
  params?: unknown;
  options?: GatewayRequestOptions;
};

type FakeResponseValue = null | boolean | number | string | Record<string, unknown> | unknown[];
type FakeResponseHandler = (
  params: unknown,
  options: GatewayRequestOptions | undefined,
  transport: FakeTransport,
) => Promise<FakeResponseValue> | FakeResponseValue;
type FakeResponse = FakeResponseValue | FakeResponseHandler;

export class FakeTransport implements OpenClawTransport {
  readonly calls: RequestCall[] = [];
  private readonly eventHub = new EventHub<GatewayEvent>({ replayLimit: 100 });

  constructor(private readonly responses: Record<string, FakeResponse>) {}

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    this.calls.push({ method, params, options });
    const response = this.responses[method];
    if (typeof response === "function") {
      return (await response(params, options, this)) as T;
    }
    return response as T;
  }

  events(filter?: (event: GatewayEvent) => boolean): AsyncIterable<GatewayEvent> {
    return this.eventHub.stream(filter, { replay: true });
  }

  emit(event: GatewayEvent): void {
    this.eventHub.publish(event);
  }

  close(): void {
    this.eventHub.close();
  }
}

export function createClientFixture(responses: Record<string, FakeResponse> = {}) {
  const transport = new FakeTransport(responses);
  return { transport, oc: new OpenClaw({ transport }) };
}

export async function observeGatewaySequence(oc: OpenClaw, seq: number): Promise<OpenClawEvent> {
  for await (const event of oc.events((eventLocal) => eventLocal.raw?.seq === seq)) {
    return event;
  }
  throw new Error(`event stream ended before sequence ${seq}`);
}

export function createAgentEvent(
  runId: string,
  seq: number,
  ts: number,
  stream: string,
  data: Record<string, unknown>,
): GatewayEvent {
  return { event: "agent", seq, payload: { runId, stream, ts, data } };
}

export function createChatEvent(
  runId: string,
  sessionKey: string,
  seq: number,
  state: "delta" | "final",
  text: string | undefined,
  timestamp: number,
  options: { deltaText?: string; replace?: true } = {},
): GatewayEvent {
  return {
    event: "chat",
    seq,
    payload: {
      runId,
      sessionKey,
      state,
      ...options,
      ...(text === undefined
        ? {}
        : { message: { role: "assistant", content: [{ type: "text", text }], timestamp } }),
    },
  };
}

export function createRunEventFixture(
  runId: string,
  sessionKey: string,
  events: readonly GatewayEvent[],
) {
  return createClientFixture({
    agent: (_params, _options, transport) => {
      for (const event of events) {
        transport.emit(event);
      }
      return { status: "accepted", runId, sessionKey };
    },
  });
}
