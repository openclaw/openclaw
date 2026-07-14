// Line tests cover in-flight tracking and steering-ack feedback behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { replyMessageLineMock } = vi.hoisted(() => ({
  replyMessageLineMock: vi.fn(async (..._args: unknown[]): Promise<void> => {}),
}));

vi.mock("./send.js", () => ({
  replyMessageLine: replyMessageLineMock,
  showLoadingAnimation: vi.fn(async () => {}),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  logVerbose: () => {},
}));

import {
  buildLineInFlightKey,
  createLineUserInFlightTracker,
  maybeSendLineSteeringAck,
} from "./in-flight-feedback.js";

const cfg = {} as OpenClawConfig;

describe("createLineUserInFlightTracker", () => {
  it("tracks overlapping turns per key with ref-counting", () => {
    const tracker = createLineUserInFlightTracker();
    expect(tracker.isInFlight("k")).toBe(false);

    tracker.begin("k");
    expect(tracker.isInFlight("k")).toBe(true);

    // Steered follow-ups legitimately overlap the same key.
    tracker.begin("k");
    tracker.end("k");
    expect(tracker.isInFlight("k")).toBe(true);

    tracker.end("k");
    expect(tracker.isInFlight("k")).toBe(false);
  });

  it("isolates keys from each other", () => {
    const tracker = createLineUserInFlightTracker();
    tracker.begin("a");
    expect(tracker.isInFlight("b")).toBe(false);
  });
});

describe("buildLineInFlightKey", () => {
  it("keys direct chats per account and user", () => {
    expect(buildLineInFlightKey("acct", { userId: "U1", isGroup: false })).toBe("acct|U1");
  });

  it("keys group chats per conversation and user", () => {
    expect(buildLineInFlightKey("acct", { userId: "U1", groupId: "G1", isGroup: true })).toBe(
      "acct|G1|U1",
    );
    expect(buildLineInFlightKey("acct", { userId: "U1", roomId: "R1", isGroup: true })).toBe(
      "acct|R1|U1",
    );
  });

  it("returns null for senderless events so distinct users never share a key", () => {
    expect(buildLineInFlightKey("acct", { groupId: "G1", isGroup: true })).toBeNull();
    expect(buildLineInFlightKey("acct", { isGroup: false })).toBeNull();
    expect(buildLineInFlightKey("acct", { userId: "U1", isGroup: true })).toBeNull();
  });
});

describe("maybeSendLineSteeringAck", () => {
  beforeEach(() => {
    replyMessageLineMock.mockReset();
    replyMessageLineMock.mockResolvedValue(undefined);
  });

  it("acks a reply-less turn admitted while the sender was in flight", async () => {
    await maybeSendLineSteeringAck({
      inFlightAtAdmission: true,
      replyToken: "token-1",
      replyTokenUsed: false,
      cfg,
      accountId: "acct",
      from: "line:U1",
      messageSid: "m-1",
    });

    expect(replyMessageLineMock).toHaveBeenCalledTimes(1);
    const [token, messages] = replyMessageLineMock.mock.calls[0] as [
      string,
      Array<{ text?: string }>,
    ];
    expect(token).toBe("token-1");
    expect(messages[0]?.text).toContain("folding this into the reply");
  });

  it("stays silent when the sender was not in flight at admission", async () => {
    await maybeSendLineSteeringAck({
      inFlightAtAdmission: false,
      replyToken: "token-1",
      replyTokenUsed: false,
      cfg,
      from: "line:U1",
    });

    expect(replyMessageLineMock).not.toHaveBeenCalled();
  });

  it("stays silent without a usable reply token and never pushes", async () => {
    await maybeSendLineSteeringAck({
      inFlightAtAdmission: true,
      replyToken: undefined,
      replyTokenUsed: false,
      cfg,
      from: "line:U1",
    });
    await maybeSendLineSteeringAck({
      inFlightAtAdmission: true,
      replyToken: "token-used",
      replyTokenUsed: true,
      cfg,
      from: "line:U1",
    });

    expect(replyMessageLineMock).not.toHaveBeenCalled();
  });

  it("swallows ack delivery failures", async () => {
    replyMessageLineMock.mockRejectedValueOnce(new Error("token expired"));

    await expect(
      maybeSendLineSteeringAck({
        inFlightAtAdmission: true,
        replyToken: "token-1",
        replyTokenUsed: false,
        cfg,
        from: "line:U1",
      }),
    ).resolves.toBeUndefined();
  });
});
