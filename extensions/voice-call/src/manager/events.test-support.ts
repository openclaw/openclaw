import { createEventManagerHarness } from "../manager.test-harness.js";
import type { CallRecord, NormalizedEvent } from "../types.js";
import type { CallManagerContext } from "./context.js";
import { processEvent } from "./events.js";

export const {
  cleanup,
  createContext,
  createInboundInitiatedEvent,
  createProvider,
  createRejectingInboundContext,
  installStateRuntime,
  requireFirstActiveCall,
  setup,
} = createEventManagerHarness();

export function createCall(
  overrides: Partial<CallRecord> & Pick<CallRecord, "callId">,
): CallRecord {
  return {
    provider: "plivo",
    direction: "outbound",
    state: "active",
    from: "+15550000000",
    to: "+15550000001",
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
    ...overrides,
  };
}

export function registerCall(
  ctx: CallManagerContext,
  overrides: Partial<CallRecord> & Pick<CallRecord, "callId">,
) {
  const call = createCall(overrides);
  ctx.activeCalls.set(call.callId, call);
  return call;
}

export function eventBase(callId: string, id = callId, timestamp = Date.now()) {
  return { id, callId, timestamp };
}

type EventInput<T = NormalizedEvent> = T extends NormalizedEvent
  ? Omit<T, "id" | "callId" | "timestamp"> & Partial<Pick<T, "id" | "callId" | "timestamp">>
  : never;

export function fixture(
  record: Partial<CallRecord> = {},
  options: Partial<CallManagerContext> = {},
) {
  const ctx = createContext(options);
  const call = registerCall(ctx, { callId: "call-1", providerCallId: "provider-1", ...record });
  if (call.providerCallId) {
    ctx.providerCallIdMap.set(call.providerCallId, call.callId);
  }
  let sequence = 0;
  const event = (input: EventInput): NormalizedEvent => ({
    ...eventBase(call.callId, `event-${sequence++}`),
    ...input,
  });
  const send = (input: EventInput) => processEvent(ctx, event(input));
  return { ctx, call, event, send };
}
