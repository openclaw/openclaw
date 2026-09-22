import { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { resolveSlackDmHistoryContext, resolveSlackDmHistoryLimit } from "./prepare-dm-history.js";
import { createInboundSlackTestContext, createSlackTestAccount } from "./prepare.test-helpers.js";

describe("Slack observed DM history limits", () => {
  it.each([
    { override: Number.MAX_SAFE_INTEGER, defaultLimit: 7, expected: 0 },
    { override: 5000, defaultLimit: 7, expected: 200 },
    { override: 0, defaultLimit: 7, expected: 0 },
    { override: 3, defaultLimit: 7, expected: 3 },
    { override: undefined, defaultLimit: 7, expected: 7 },
    { override: undefined, defaultLimit: 5000, expected: 200 },
  ])("bounds the selected window $override / $defaultLimit to $expected", async (testCase) => {
    const account = createSlackTestAccount({
      dms: { U1: { historyLimit: testCase.override } },
    });
    const limit = resolveSlackDmHistoryLimit({
      account,
      userId: "U1",
      defaultLimit: testCase.defaultLimit,
    });
    expect(limit).toBe(testCase.expected);
    const client = new WebClient();
    const history = vi
      .spyOn(client.conversations, "history")
      .mockResolvedValue({ ok: true, messages: [] });
    const ctx = createInboundSlackTestContext({ cfg: {}, appClient: client });
    await resolveSlackDmHistoryContext({
      ctx,
      channelId: "D1",
      currentMessageTs: "42.0",
      limit,
      envelopeOptions: {},
    });
    if (testCase.expected === 0) {
      expect(history).not.toHaveBeenCalled();
    } else {
      expect(history).toHaveBeenCalledOnce();
      expect(history).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "D1", limit: testCase.expected + 1 }),
      );
    }
  });
});
