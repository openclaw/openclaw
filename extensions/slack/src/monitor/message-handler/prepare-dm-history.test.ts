import { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { resolveSlackDmHistoryContext, resolveSlackDmHistoryLimit } from "./prepare-dm-history.js";
import { createInboundSlackTestContext, createSlackTestAccount } from "./prepare.test-helpers.js";

describe("Slack observed DM history limits", () => {
  it("formats the bounded DM window chronologically without another reversal copy", async () => {
    const client = new WebClient();
    const messages = [
      { text: "current", ts: "4.000", bot_id: "B1" },
      { text: "latest", ts: "3.000", bot_id: "B1" },
      { text: "earlier", ts: "2.000", bot_id: "B1" },
      { text: "oldest", ts: "1.000", bot_id: "B1" },
    ];
    const history = vi
      .spyOn(client.conversations, "history")
      .mockResolvedValue({ ok: true, messages });
    const ctx = createInboundSlackTestContext({ cfg: {}, appClient: client });
    const copies = vi.spyOn(Array.prototype, "toReversed");
    try {
      const result = await resolveSlackDmHistoryContext({
        ctx,
        channelId: "D1",
        currentMessageTs: "4.000",
        limit: 2,
        envelopeOptions: { includeTimestamp: false, includeElapsed: false },
      });
      expect(result.inboundHistory).toEqual([
        { sender: "Assistant (assistant)", body: "earlier", timestamp: 2000 },
        { sender: "Assistant (assistant)", body: "latest", timestamp: 3000 },
      ]);
      expect(result.body).toBe(
        "[Slack Assistant (assistant)] Assistant (assistant): earlier\n[slack message id: 2.000 channel: D1]\n\n" +
          "[Slack Assistant (assistant)] Assistant (assistant): latest\n[slack message id: 3.000 channel: D1]",
      );
      expect(messages.map(({ ts }) => ts)).toEqual(["4.000", "3.000", "2.000", "1.000"]);
      expect(copies).not.toHaveBeenCalled();
    } finally {
      copies.mockRestore();
      history.mockRestore();
    }
  });

  it("bounds distinct sender lookups and retains chronological history", async () => {
    const client = new WebClient();
    const messages = Array.from({ length: 6 }, (_, index) => ({
      text: `message ${index}`,
      ts: `${index + 1}.000`,
      user: `U${index}`,
    }));
    messages.push({ text: "repeated author", ts: "7.000", user: "U0" });
    const history = vi.spyOn(client.conversations, "history").mockResolvedValue({
      ok: true,
      messages: messages.toReversed(),
    });
    const ctx = createInboundSlackTestContext({ cfg: {}, appClient: client });
    const gates = Array.from({ length: 6 }, () => Promise.withResolvers<{ name: string }>());
    const lookup = vi.fn((id: string) => gates[Number(id.slice(1))]!.promise);
    ctx.resolveUserName = lookup;
    const reading = resolveSlackDmHistoryContext({
      ctx,
      channelId: "D1",
      limit: 7,
      envelopeOptions: { includeTimestamp: false },
    });
    try {
      await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(4));
      gates[3]!.resolve({ name: "name 3" });
      gates[2]!.resolve({ name: "name 2" });
      await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(6));
      gates.forEach((gate, index) => gate.resolve({ name: `name ${index}` }));
      const result = await reading;
      expect(result.inboundHistory?.map(({ body }) => body)).toEqual(
        messages.map(({ text }) => text),
      );
      expect(result.inboundHistory?.map(({ sender }) => sender)).toEqual([
        ...Array.from({ length: 6 }, (_, index) => `name ${index} (user)`),
        "name 0 (user)",
      ]);
      expect(lookup).toHaveBeenCalledTimes(6);
    } finally {
      gates.forEach((gate, index) => gate.resolve({ name: `name ${index}` }));
      await reading;
      history.mockRestore();
    }
  });

  it.each([
    { override: Number.MAX_SAFE_INTEGER, defaultLimit: 7, expected: 0 },
    { override: 5000, defaultLimit: 7, expected: 200 },
    { override: 0, defaultLimit: 7, expected: 0 },
    { override: undefined, defaultLimit: 7, expected: 7 },
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
