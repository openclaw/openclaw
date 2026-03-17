import { describe, expect, it, vi } from "vitest";
import { registerSlackPinEvents } from "./pins.js";
import {
  createSlackSystemEventTestHarness as buildPinHarness
} from "./system-event-test-harness.js";
const pinEnqueueMock = vi.hoisted(() => vi.fn());
const pinAllowMock = vi.hoisted(() => vi.fn());
vi.mock("../../../../../src/infra/system-events.js", () => {
  return { enqueueSystemEvent: pinEnqueueMock };
});
vi.mock("../../../../../src/pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: pinAllowMock
}));
function makePinEvent(overrides) {
  return {
    type: "pin_added",
    user: overrides?.user ?? "U1",
    channel_id: overrides?.channel ?? "D1",
    event_ts: "123.456",
    item: {
      type: "message",
      message: { ts: "123.456" }
    }
  };
}
function installPinHandlers(args) {
  const harness = buildPinHarness(args.overrides);
  if (args.shouldDropMismatchedSlackEvent) {
    harness.ctx.shouldDropMismatchedSlackEvent = args.shouldDropMismatchedSlackEvent;
  }
  registerSlackPinEvents({ ctx: harness.ctx, trackEvent: args.trackEvent });
  return {
    added: harness.getHandler("pin_added"),
    removed: harness.getHandler("pin_removed")
  };
}
async function runPinCase(input = {}) {
  pinEnqueueMock.mockClear();
  pinAllowMock.mockReset().mockResolvedValue([]);
  const { added, removed } = installPinHandlers({
    overrides: input.overrides,
    trackEvent: input.trackEvent,
    shouldDropMismatchedSlackEvent: input.shouldDropMismatchedSlackEvent
  });
  const handlerKey = input.handler ?? "added";
  const handler = handlerKey === "removed" ? removed : added;
  expect(handler).toBeTruthy();
  const event = input.event ?? makePinEvent();
  const body = input.body ?? {};
  await handler({
    body,
    event
  });
}
describe("registerSlackPinEvents", () => {
  const cases = [
    {
      name: "enqueues DM pin system events when dmPolicy is open",
      args: { overrides: { dmPolicy: "open" } },
      expectedCalls: 1
    },
    {
      name: "blocks DM pin system events when dmPolicy is disabled",
      args: { overrides: { dmPolicy: "disabled" } },
      expectedCalls: 0
    },
    {
      name: "blocks DM pin system events for unauthorized senders in allowlist mode",
      args: {
        overrides: { dmPolicy: "allowlist", allowFrom: ["U2"] },
        event: makePinEvent({ user: "U1" })
      },
      expectedCalls: 0
    },
    {
      name: "allows DM pin system events for authorized senders in allowlist mode",
      args: {
        overrides: { dmPolicy: "allowlist", allowFrom: ["U1"] },
        event: makePinEvent({ user: "U1" })
      },
      expectedCalls: 1
    },
    {
      name: "blocks channel pin events for users outside channel users allowlist",
      args: {
        overrides: {
          dmPolicy: "open",
          channelType: "channel",
          channelUsers: ["U_OWNER"]
        },
        event: makePinEvent({ channel: "C1", user: "U_ATTACKER" })
      },
      expectedCalls: 0
    }
  ];
  it.each(cases)("$name", async ({ args, expectedCalls }) => {
    await runPinCase(args);
    expect(pinEnqueueMock).toHaveBeenCalledTimes(expectedCalls);
  });
  it("does not track mismatched events", async () => {
    const trackEvent = vi.fn();
    await runPinCase({
      trackEvent,
      shouldDropMismatchedSlackEvent: () => true,
      body: { api_app_id: "A_OTHER" }
    });
    expect(trackEvent).not.toHaveBeenCalled();
  });
  it("tracks accepted pin events", async () => {
    const trackEvent = vi.fn();
    await runPinCase({ trackEvent });
    expect(trackEvent).toHaveBeenCalledTimes(1);
  });
});
