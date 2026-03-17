import { describe, expect, it, vi } from "vitest";
import { registerSlackReactionEvents } from "./reactions.js";
import {
  createSlackSystemEventTestHarness
} from "./system-event-test-harness.js";
const reactionQueueMock = vi.fn();
const reactionAllowMock = vi.fn();
vi.mock("../../../../../src/infra/system-events.js", () => {
  return {
    enqueueSystemEvent: (...args) => reactionQueueMock(...args)
  };
});
vi.mock("../../../../../src/pairing/pairing-store.js", () => {
  return {
    readChannelAllowFromStore: (...args) => reactionAllowMock(...args)
  };
});
function buildReactionEvent(overrides) {
  return {
    type: "reaction_added",
    user: overrides?.user ?? "U1",
    reaction: "thumbsup",
    item: {
      type: "message",
      channel: overrides?.channel ?? "D1",
      ts: "123.456"
    },
    item_user: "UBOT"
  };
}
function createReactionHandlers(params) {
  const harness = createSlackSystemEventTestHarness(params.overrides);
  if (params.shouldDropMismatchedSlackEvent) {
    harness.ctx.shouldDropMismatchedSlackEvent = params.shouldDropMismatchedSlackEvent;
  }
  registerSlackReactionEvents({ ctx: harness.ctx, trackEvent: params.trackEvent });
  return {
    added: harness.getHandler("reaction_added"),
    removed: harness.getHandler("reaction_removed")
  };
}
async function executeReactionCase(input = {}) {
  reactionQueueMock.mockClear();
  reactionAllowMock.mockReset().mockResolvedValue([]);
  const handlers = createReactionHandlers({
    overrides: input.overrides,
    trackEvent: input.trackEvent,
    shouldDropMismatchedSlackEvent: input.shouldDropMismatchedSlackEvent
  });
  const handler = handlers[input.handler ?? "added"];
  expect(handler).toBeTruthy();
  await handler({
    event: input.event ?? buildReactionEvent(),
    body: input.body ?? {}
  });
}
describe("registerSlackReactionEvents", () => {
  const cases = [
    {
      name: "enqueues DM reaction system events when dmPolicy is open",
      input: { overrides: { dmPolicy: "open" } },
      expectedCalls: 1
    },
    {
      name: "blocks DM reaction system events when dmPolicy is disabled",
      input: { overrides: { dmPolicy: "disabled" } },
      expectedCalls: 0
    },
    {
      name: "blocks DM reaction system events for unauthorized senders in allowlist mode",
      input: {
        overrides: { dmPolicy: "allowlist", allowFrom: ["U2"] },
        event: buildReactionEvent({ user: "U1" })
      },
      expectedCalls: 0
    },
    {
      name: "allows DM reaction system events for authorized senders in allowlist mode",
      input: {
        overrides: { dmPolicy: "allowlist", allowFrom: ["U1"] },
        event: buildReactionEvent({ user: "U1" })
      },
      expectedCalls: 1
    },
    {
      name: "enqueues channel reaction events regardless of dmPolicy",
      input: {
        handler: "removed",
        overrides: { dmPolicy: "disabled", channelType: "channel" },
        event: {
          ...buildReactionEvent({ channel: "C1" }),
          type: "reaction_removed"
        }
      },
      expectedCalls: 1
    },
    {
      name: "blocks channel reaction events for users outside channel users allowlist",
      input: {
        overrides: {
          dmPolicy: "open",
          channelType: "channel",
          channelUsers: ["U_OWNER"]
        },
        event: buildReactionEvent({ channel: "C1", user: "U_ATTACKER" })
      },
      expectedCalls: 0
    }
  ];
  it.each(cases)("$name", async ({ input, expectedCalls }) => {
    await executeReactionCase(input);
    expect(reactionQueueMock).toHaveBeenCalledTimes(expectedCalls);
  });
  it("does not track mismatched events", async () => {
    const trackEvent = vi.fn();
    await executeReactionCase({
      trackEvent,
      shouldDropMismatchedSlackEvent: () => true,
      body: { api_app_id: "A_OTHER" }
    });
    expect(trackEvent).not.toHaveBeenCalled();
  });
  it("tracks accepted message reactions", async () => {
    const trackEvent = vi.fn();
    await executeReactionCase({ trackEvent });
    expect(trackEvent).toHaveBeenCalledTimes(1);
  });
  it("passes sender context when resolving reaction session keys", async () => {
    reactionQueueMock.mockClear();
    reactionAllowMock.mockReset().mockResolvedValue([]);
    const harness = createSlackSystemEventTestHarness();
    const resolveSessionKey = vi.fn().mockReturnValue("agent:ops:main");
    harness.ctx.resolveSlackSystemEventSessionKey = resolveSessionKey;
    registerSlackReactionEvents({ ctx: harness.ctx });
    const handler = harness.getHandler("reaction_added");
    expect(handler).toBeTruthy();
    await handler({
      event: buildReactionEvent({ user: "U777", channel: "D123" }),
      body: {}
    });
    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: "D123",
      channelType: "im",
      senderId: "U777"
    });
  });
});
