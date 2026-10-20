import { describe, expect, it } from "vitest";
import { nextcloudTalkPlugin } from "./channel.js";
import { NextcloudTalkChannelConfigSchema } from "./config-schema.js";
import type { CoreConfig } from "./types.js";

const secretRef = (id: string) => ({ source: "env", provider: "default", id });

function safeParseNextcloudTalkConfig(value: unknown) {
  const runtime = NextcloudTalkChannelConfigSchema.runtime;
  if (!runtime) {
    throw new Error("Nextcloud Talk runtime config schema is unavailable");
  }
  return runtime.safeParse(value);
}

describe("nextcloud talk channel core", () => {
  it("marks ambiguous room-token session routes as best-effort", () => {
    const resolveSessionRoute = nextcloudTalkPlugin.messaging?.resolveOutboundSessionRoute;
    if (!resolveSessionRoute) {
      throw new Error("Nextcloud Talk outbound session routing unavailable");
    }
    const route = resolveSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "acct-1",
      target: "nextcloud-talk:room-123",
    });

    expect(route).toEqual({
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
    const resolveSessionRoute = nextcloudTalkPlugin.messaging?.resolveOutboundSessionRoute;
    if (!resolveSessionRoute) {
      throw new Error("Nextcloud Talk outbound session routing unavailable");
    }
    expect(
      resolveSessionRoute({ cfg: {}, agentId: "main", accountId: "acct-1", target: "" }),
    ).toBeNull();
  });

  it.each([
    ["omitted media allowlist", {}, true],
    ["explicit sender", { mediaAllowFrom: ["users/alice"] }, false],
    ["wildcard", { mediaAllowFrom: ["*"] }, false],
    [
      "named account with size override",
      {
        mediaAllowFrom: ["users/alice"],
        mediaMaxMb: 20,
        accounts: { work: { mediaAllowFrom: ["*"], mediaMaxMb: 5 } },
      },
      false,
    ],
  ] as const)("accepts representative inbound media config: %s", (_label, input, expectOmitted) => {
    const result = safeParseNextcloudTalkConfig(input);
    if (!result.success) {
      throw new Error(JSON.stringify(result.issues));
    }
    expect(result.data).toMatchObject(input);
    if (expectOmitted) {
      expect(result.data).not.toHaveProperty("mediaAllowFrom");
      expect(result.data).not.toHaveProperty("mediaMaxMb");
    }
  });

  it("accepts SecretRef botSecret and apiPassword at top-level", () => {
    const result = safeParseNextcloudTalkConfig({
      baseUrl: "https://cloud.example.com",
      botSecret: secretRef("NEXTCLOUD_TALK_BOT_SECRET"),
      apiUser: "bot",
      apiPassword: secretRef("NEXTCLOUD_TALK_API_PASSWORD"),
    });
    expect(result.success).toBe(true);
  });

  it("accepts SecretRef botSecret and apiPassword on account", () => {
    const result = safeParseNextcloudTalkConfig({
      accounts: {
        main: {
          baseUrl: "https://cloud.example.com",
          botSecret: secretRef("NEXTCLOUD_TALK_MAIN_BOT_SECRET"),
          apiUser: "bot",
          apiPassword: secretRef("NEXTCLOUD_TALK_MAIN_API_PASSWORD"),
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("normalizes trimmed DM allowlist prefixes to lowercase ids", () => {
    const resolveDmPolicy = nextcloudTalkPlugin.security?.resolveDmPolicy;
    if (!resolveDmPolicy) {
      throw new Error("resolveDmPolicy unavailable");
    }

    const cfg = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
          botSecret: "secret",
          dmPolicy: "allowlist",
          allowFrom: ["  nc:User-Id  "],
        },
      },
    } as CoreConfig;

    const result = resolveDmPolicy({
      cfg,
      account: nextcloudTalkPlugin.config.resolveAccount(cfg, "default"),
    });
    if (!result) {
      throw new Error("nextcloud-talk resolveDmPolicy returned null");
    }

    expect(result.policy).toBe("allowlist");
    expect(result.allowFrom).toEqual(["  nc:User-Id  "]);
    expect(result.normalizeEntry?.("  nc:User-Id  ")).toBe("user-id");
    expect(nextcloudTalkPlugin.pairing?.normalizeAllowEntry?.("  nextcloud-talk:User-Id  ")).toBe(
      "user-id",
    );
  });
});
