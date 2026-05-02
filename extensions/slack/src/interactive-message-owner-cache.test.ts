import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSlackInteractiveMessageOwnerCache,
  readSlackInteractiveMessageOwner,
  recordSlackInteractiveMessageOwner,
} from "./interactive-message-owner-cache.js";

describe("slack interactive-message-owner-cache", () => {
  afterEach(() => {
    clearSlackInteractiveMessageOwnerCache();
    vi.restoreAllMocks();
  });

  it("records and reads interactive message ownership", () => {
    recordSlackInteractiveMessageOwner({
      accountId: "A1",
      channelId: "C1",
      messageTs: "1710000000.000100",
      sessionKey: "agent:main:slack:direct:U1",
      threadTs: "1710000000.000001",
    });

    expect(
      readSlackInteractiveMessageOwner({
        accountId: "A1",
        channelId: "C1",
        messageTs: "1710000000.000100",
      }),
    ).toEqual({
      sessionKey: "agent:main:slack:direct:U1",
      threadTs: "1710000000.000001",
    });
  });

  it("ignores incomplete ownership records", () => {
    recordSlackInteractiveMessageOwner({
      accountId: "A1",
      channelId: "C1",
      messageTs: "1710000000.000100",
      sessionKey: "",
    });

    expect(
      readSlackInteractiveMessageOwner({
        accountId: "A1",
        channelId: "C1",
        messageTs: "1710000000.000100",
      }),
    ).toBeUndefined();
  });

  it("expires stale ownership records on read", () => {
    recordSlackInteractiveMessageOwner({
      accountId: "A1",
      channelId: "C1",
      messageTs: "1710000000.000100",
      sessionKey: "agent:main:slack:direct:U1",
    });

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);

    expect(
      readSlackInteractiveMessageOwner({
        accountId: "A1",
        channelId: "C1",
        messageTs: "1710000000.000100",
      }),
    ).toBeUndefined();
  });
});
