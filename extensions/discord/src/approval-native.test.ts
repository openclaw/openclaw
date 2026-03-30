import { describe, expect, it } from "vitest";
import { createDiscordNativeApprovalAdapter } from "./approval-native.js";

describe("createDiscordNativeApprovalAdapter", () => {
  it("normalizes prefixed turn-source channel ids", async () => {
    const adapter = createDiscordNativeApprovalAdapter();

    const target = await adapter.native?.resolveOriginTarget?.({
      cfg: {} as never,
      accountId: "main",
      approvalKind: "plugin",
      request: {
        id: "abc",
        request: {
          title: "Plugin approval",
          description: "Let plugin proceed",
          turnSourceChannel: "discord",
          turnSourceTo: "channel:123456789",
          turnSourceAccountId: "main",
        },
        createdAtMs: 1,
        expiresAtMs: 2,
      },
    });

    expect(target).toEqual({ to: "123456789" });
  });

  it("falls back to extracting the channel id from the session key", async () => {
    const adapter = createDiscordNativeApprovalAdapter();

    const target = await adapter.native?.resolveOriginTarget?.({
      cfg: {} as never,
      accountId: "main",
      approvalKind: "plugin",
      request: {
        id: "abc",
        request: {
          title: "Plugin approval",
          description: "Let plugin proceed",
          sessionKey: "agent:main:discord:channel:987654321",
        },
        createdAtMs: 1,
        expiresAtMs: 2,
      },
    });

    expect(target).toEqual({ to: "987654321" });
  });
});
