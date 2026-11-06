import { resolveEnvelopeFormatOptions } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import type { IMessageRpcClient } from "../client.js";
import { resolveIMessageDmHistoryContext, resolveIMessageDmHistoryLimit } from "./dm-history.js";

const sender = "+15555550123";
const historyRow = (id: number, guid: string, text: string, minute: string, fromMe = false) => ({
  id,
  guid,
  text,
  chat_id: 44,
  sender: fromMe ? null : sender,
  is_from_me: fromMe,
  is_group: false,
  created_at: `2026-05-25T12:${minute}:00.000Z`,
});

describe("resolveIMessageDmHistoryLimit", () => {
  it("uses per-DM history overrides before the provider default", () => {
    expect(
      resolveIMessageDmHistoryLimit({
        config: {
          dmHistoryLimit: 5,
          dms: { [sender]: { historyLimit: 2 } },
        },
        sender: "+1 (555) 555-0123",
        senderNormalized: sender,
      }),
    ).toBe(2);
  });

  it("defaults to disabled when no iMessage DM history limit is configured", () => {
    expect(resolveIMessageDmHistoryLimit({ config: {}, sender })).toBe(0);
  });
});

describe("resolveIMessageDmHistoryContext", () => {
  it("fetches decoded imsg history rows and excludes the current message", async () => {
    const request = vi.fn(async () => ({
      messages: [
        historyRow(8, "previous-in", "earlier inbound", "00"),
        historyRow(9, "previous-out", "earlier outbound", "01", true),
        historyRow(10, "current", "current", "02"),
      ],
    }));

    const context = await resolveIMessageDmHistoryContext({
      client: { request } as unknown as IMessageRpcClient,
      message: { ...historyRow(10, "current", "current", "02"), sender },
      senderNormalized: sender,
      limit: 2,
      envelopeOptions: resolveEnvelopeFormatOptions({} as OpenClawConfig),
    });

    expect(request).toHaveBeenCalledWith(
      "messages.history",
      { chat_id: 44, limit: 3, attachments: false },
      { timeoutMs: 10_000 },
    );
    expect(context.inboundHistory).toEqual([
      {
        sender,
        body: "earlier inbound",
        timestamp: Date.parse("2026-05-25T12:00:00.000Z"),
      },
      {
        sender: "Me",
        body: "earlier outbound",
        timestamp: Date.parse("2026-05-25T12:01:00.000Z"),
      },
    ]);
    expect(context.body).toContain("earlier inbound");
    expect(context.body).toContain("earlier outbound");
    expect(context.body).not.toContain("current");
  });
});
