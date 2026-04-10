import { describe, expect, it } from "vitest";
import { __testing } from "./subagent-announce-delivery.js";
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

describe("resolveDirectAnnounceDeliveryTarget", () => {
  it("keeps non-completion direct announces session-local when no external target is resolved", () => {
    expect(
      __testing.resolveDirectAnnounceDeliveryTarget({
        requesterIsSubagent: false,
        origin: {
          channel: "telegram",
        },
      }),
    ).toEqual({
      shouldDeliverExternally: false,
    });
  });

  it("enables external delivery only when channel and target are both resolved", () => {
    expect(
      __testing.resolveDirectAnnounceDeliveryTarget({
        requesterIsSubagent: false,
        origin: {
          channel: "telegram",
          to: "telegram:-1001234567890",
          accountId: "acct-1",
          threadId: 99,
        },
      }),
    ).toEqual({
      shouldDeliverExternally: true,
      channel: "telegram",
      to: "telegram:-1001234567890",
      accountId: "acct-1",
      threadId: "99",
    });
  });

  it("never enables external delivery for subagent requesters", () => {
    expect(
      __testing.resolveDirectAnnounceDeliveryTarget({
        requesterIsSubagent: true,
        origin: {
          channel: "telegram",
          to: "telegram:-1001234567890",
        },
      }),
    ).toEqual({
      shouldDeliverExternally: false,
    });
  });
});
