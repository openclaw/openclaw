import { describe, expect, it } from "vitest";
import { handleSlackSubagentDeliveryTarget } from "./subagent-hooks.js";

describe("handleSlackSubagentDeliveryTarget", () => {
  const baseEvent = {
    childSessionKey: "agent:worker:slack:channel:C123:thread:1234567890.123456",
    requesterSessionKey: "agent:router:slack:channel:C123:thread:1234567890.123456",
    expectsCompletionMessage: true,
    requesterOrigin: {
      channel: "slack",
      accountId: "default",
      to: "channel:C123",
      threadId: "1234567890.123456",
    },
  };

  it("returns origin with threadId when requester is Slack with thread", () => {
    const result = handleSlackSubagentDeliveryTarget(baseEvent);
    expect(result).toEqual({
      origin: {
        channel: "slack",
        accountId: "default",
        to: "channel:C123",
        threadId: "1234567890.123456",
      },
    });
  });

  it("returns undefined when expectsCompletionMessage is false", () => {
    const result = handleSlackSubagentDeliveryTarget({
      ...baseEvent,
      expectsCompletionMessage: false,
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when channel is not slack", () => {
    const result = handleSlackSubagentDeliveryTarget({
      ...baseEvent,
      requesterOrigin: {
        ...baseEvent.requesterOrigin,
        channel: "discord",
      },
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when threadId is missing", () => {
    const result = handleSlackSubagentDeliveryTarget({
      ...baseEvent,
      requesterOrigin: {
        ...baseEvent.requesterOrigin,
        threadId: undefined,
      },
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when threadId is empty string", () => {
    const result = handleSlackSubagentDeliveryTarget({
      ...baseEvent,
      requesterOrigin: {
        ...baseEvent.requesterOrigin,
        threadId: "",
      },
    });
    expect(result).toBeUndefined();
  });

  it("handles numeric threadId", () => {
    const result = handleSlackSubagentDeliveryTarget({
      ...baseEvent,
      requesterOrigin: {
        ...baseEvent.requesterOrigin,
        threadId: 1234567890,
      },
    });
    expect(result).toEqual({
      origin: {
        channel: "slack",
        accountId: "default",
        to: "channel:C123",
        threadId: 1234567890,
      },
    });
  });

  it("returns undefined when requesterOrigin is missing", () => {
    const result = handleSlackSubagentDeliveryTarget({
      ...baseEvent,
      requesterOrigin: undefined,
    });
    expect(result).toBeUndefined();
  });
});
