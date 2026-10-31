import { describe, expect, it } from "vitest";
import { nextcloudTalkPlugin } from "./channel.js";
import { NextcloudTalkChannelConfigSchema } from "./config-schema.js";
import type { CoreConfig } from "./types.js";

const secretRef = (id: string) => ({ source: "env", provider: "default", id });

const safeParseNextcloudTalkConfig = (value: unknown) =>
  NextcloudTalkChannelConfigSchema.runtime!.safeParse(value);
const resolveSessionRoute = (target: string) =>
  nextcloudTalkPlugin.messaging!.resolveOutboundSessionRoute!({
    cfg: {},
    agentId: "main",
    accountId: "acct-1",
    target,
  });

describe("nextcloud talk channel core", () => {
  it("marks ambiguous room-token session routes as best-effort", () => {
    expect(resolveSessionRoute("nextcloud-talk:room-123")).toEqual({
      sessionKey: "agent:main:nextcloud-talk:group:room-123",
      baseSessionKey: "agent:main:nextcloud-talk:group:room-123",
      recipientSessionExact: false,
      peer: { kind: "group", id: "room-123" },
      chatType: "group",
      from: "nextcloud-talk:room:room-123",
      to: "nextcloud-talk:room-123",
    });
  });

  it("returns null when the target cannot be normalized to a room id", () => {
    expect(resolveSessionRoute("")).toBeNull();
  });

  it.each([
    {},
    {
      mediaAllowFrom: ["users/alice", "*"],
      mediaMaxMb: 20,
      accounts: { work: { mediaAllowFrom: ["*"], mediaMaxMb: 5 } },
    },
  ])("accepts inbound media config %j", (input) => {
    const result = safeParseNextcloudTalkConfig(input);
    if (!result.success) {
      throw new Error(JSON.stringify(result.issues));
    }
    expect(result.data).toMatchObject(input);
    if (!("mediaAllowFrom" in input)) {
      expect(result.data).not.toHaveProperty("mediaAllowFrom");
      expect(result.data).not.toHaveProperty("mediaMaxMb");
    }
  });

  it.each(["root", "account"])("accepts SecretRef credentials at %s", (scope) => {
    const credentials = {
      baseUrl: "https://cloud.example.com",
      botSecret: secretRef("NEXTCLOUD_TALK_BOT_SECRET"),
      apiUser: "bot",
      apiPassword: secretRef("NEXTCLOUD_TALK_API_PASSWORD"),
    };
    expect(
      safeParseNextcloudTalkConfig(
        scope === "root" ? credentials : { accounts: { main: credentials } },
      ).success,
    ).toBe(true);
  });

  it("normalizes comparisons without rewriting pairing mutation keys", () => {
    const cfg = {
      channels: {
        "nextcloud-talk": {
          dmPolicy: "allowlist",
          allowFrom: ["  nc:User-Id  "],
        },
      },
    } as CoreConfig;

    const result = nextcloudTalkPlugin.security!.resolveDmPolicy!({
      cfg,
      account: nextcloudTalkPlugin.config.resolveAccount(cfg, "default"),
    })!;

    expect(result).toMatchObject({ policy: "allowlist", allowFrom: ["  nc:User-Id  "] });
    expect(result.normalizeEntry?.("  nc:User-Id  ")).toBe("users/user-id");
    expect(result.normalizeEntry?.("  nc:Users/User-Id  ")).toBe("users/user-id");
    expect(
      nextcloudTalkPlugin.config.formatAllowFrom?.({
        cfg,
        accountId: "default",
        allowFrom: ["  nc:User-Id  ", "guests/user-id"],
      }),
    ).toEqual(["users/user-id", "guests/user-id"]);
    expect(nextcloudTalkPlugin.pairing?.normalizeAllowEntry?.("  nextcloud-talk:User-Id  ")).toBe(
      "user-id",
    );
    expect(
      nextcloudTalkPlugin.pairing?.normalizeAllowEntry?.("  nextcloud-talk:users/User-Id  "),
    ).toBe("users/user-id");
  });
});
