import { describe, expect, it } from "vitest";
import { mergeDeliveryContext, normalizeDeliveryContext } from "../utils/delivery-context.js";
import { deliveryContextFromSession } from "../utils/delivery-context.shared.js";
import { isInternalMessageChannel, INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { resolveAnnounceOrigin } from "./subagent-announce-origin.js";

describe("resolveAnnounceOrigin telegram forum topics", () => {
  it("preserves stored forum topic thread ids when requester origin omits one for the same chat", () => {
    expect(
      resolveAnnounceOrigin(
        {
          lastChannel: "telegram",
          lastTo: "telegram:-1001234567890:topic:99",
          lastThreadId: 99,
        },
        {
          channel: "telegram",
          to: "telegram:-1001234567890",
        },
      ),
    ).toEqual({
      channel: "telegram",
      to: "telegram:-1001234567890",
      threadId: 99,
    });
  });

  it("preserves stored forum topic thread ids for legacy group-prefixed requester targets", () => {
    expect(
      resolveAnnounceOrigin(
        {
          lastChannel: "telegram",
          lastTo: "telegram:-1001234567890:topic:99",
          lastThreadId: 99,
        },
        {
          channel: "telegram",
          to: "group:-1001234567890",
        },
      ),
    ).toEqual({
      channel: "telegram",
      to: "group:-1001234567890",
      threadId: 99,
    });
  });

  it("still strips stale thread ids when the stored telegram route points at a different chat", () => {
    expect(
      resolveAnnounceOrigin(
        {
          lastChannel: "telegram",
          lastTo: "telegram:-1009999999999:topic:99",
          lastThreadId: 99,
        },
        {
          channel: "telegram",
          to: "telegram:-1001234567890",
        },
      ),
    ).toEqual({
      channel: "telegram",
      to: "telegram:-1001234567890",
    });
  });
});

describe("thread-bound announce delivery suppression policy", () => {
  // These test the isThreadBoundAnnounce gate conditions inline.
  // The actual delivery suppression is in sendSubagentAnnounceDirectly.

  function isThreadBoundAnnounce(params: {
    requesterIsSubagent: boolean;
    threadId?: string | number | null;
    originChannel?: string;
    sourceTool?: string;
  }): boolean {
    return (
      !params.requesterIsSubagent &&
      params.threadId != null &&
      params.originChannel === INTERNAL_MESSAGE_CHANNEL &&
      params.sourceTool === "subagent_announce"
    );
  }

  it("suppresses external delivery for inter-session announce with threadId", () => {
    expect(
      isThreadBoundAnnounce({
        requesterIsSubagent: false,
        threadId: "1493151001098584226",
        originChannel: INTERNAL_MESSAGE_CHANNEL,
        sourceTool: "subagent_announce",
      }),
    ).toBe(true);
  });

  it("does not suppress for non-announce source tools", () => {
    expect(
      isThreadBoundAnnounce({
        requesterIsSubagent: false,
        threadId: "1493151001098584226",
        originChannel: INTERNAL_MESSAGE_CHANNEL,
        sourceTool: "user_message",
      }),
    ).toBe(false);
  });

  it("does not suppress when no threadId is present", () => {
    expect(
      isThreadBoundAnnounce({
        requesterIsSubagent: false,
        threadId: undefined,
        originChannel: INTERNAL_MESSAGE_CHANNEL,
        sourceTool: "subagent_announce",
      }),
    ).toBe(false);
  });

  it("does not suppress for subagent requesters", () => {
    expect(
      isThreadBoundAnnounce({
        requesterIsSubagent: true,
        threadId: "1493151001098584226",
        originChannel: INTERNAL_MESSAGE_CHANNEL,
        sourceTool: "subagent_announce",
      }),
    ).toBe(false);
  });

  it("does not suppress for non-internal origin channels", () => {
    expect(
      isThreadBoundAnnounce({
        requesterIsSubagent: false,
        threadId: "1493151001098584226",
        originChannel: "discord",
        sourceTool: "subagent_announce",
      }),
    ).toBe(false);
  });
});

describe("completion origin webchat fallback with child session context", () => {
  // Tests the Slice 2 logic: when requesterOrigin is webchat and no binding
  // exists, use the child session's delivery context instead of falling back
  // to the main session's stale lastChannel/lastTo.

  function resolveChildSessionFallback(params: {
    requesterOrigin: { channel?: string; to?: string; threadId?: string };
    childDeliveryContext?: {
      channel?: string;
      to?: string;
      threadId?: string | number;
      lastChannel?: string;
      lastTo?: string;
    };
  }) {
    const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
    if (
      requesterOrigin?.channel &&
      isInternalMessageChannel(requesterOrigin.channel) &&
      params.childDeliveryContext
    ) {
      const childDelivery = deliveryContextFromSession(params.childDeliveryContext);
      if (childDelivery?.channel && !isInternalMessageChannel(childDelivery.channel)) {
        return mergeDeliveryContext(childDelivery, requesterOrigin);
      }
    }
    return requesterOrigin;
  }

  it("uses child session delivery context when requester is webchat", () => {
    const result = resolveChildSessionFallback({
      requesterOrigin: { channel: "webchat" },
      childDeliveryContext: {
        lastChannel: "discord",
        lastTo: "channel:1493256223175348355",
      },
    });
    expect(result?.channel).toBe("discord");
    expect(result?.to).toBe("channel:1493256223175348355");
  });

  it("preserves webchat origin when child has no external context", () => {
    const result = resolveChildSessionFallback({
      requesterOrigin: { channel: "webchat" },
      childDeliveryContext: { lastChannel: "webchat" },
    });
    expect(result?.channel).toBe("webchat");
  });

  it("preserves webchat origin when no child context available", () => {
    const result = resolveChildSessionFallback({
      requesterOrigin: { channel: "webchat" },
      childDeliveryContext: undefined,
    });
    expect(result?.channel).toBe("webchat");
  });

  it("does not override when requester already has external channel", () => {
    const result = resolveChildSessionFallback({
      requesterOrigin: { channel: "discord", to: "channel:correct-target" },
      childDeliveryContext: {
        lastChannel: "telegram",
        lastTo: "telegram:6098642967",
      },
    });
    // Non-webchat requester should pass through unchanged
    expect(result?.channel).toBe("discord");
    expect(result?.to).toBe("channel:correct-target");
  });
});
