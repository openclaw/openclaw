import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nextcloudTalkPlugin } from "./channel.js";
import { NextcloudTalkConfigSchema } from "./config-schema.js";
import {
  escapeNextcloudTalkMarkdown,
  formatNextcloudTalkCodeBlock,
  formatNextcloudTalkInlineCode,
  formatNextcloudTalkMention,
  markdownToNextcloudTalk,
  stripNextcloudTalkFormatting,
  truncateNextcloudTalkText,
} from "./format.js";
import {
  looksLikeNextcloudTalkTargetId,
  normalizeNextcloudTalkMessagingTarget,
  stripNextcloudTalkTargetPrefix,
} from "./normalize.js";
import { resolveNextcloudTalkAllowlistMatch, resolveNextcloudTalkGroupAllow } from "./policy.js";
import { createNextcloudTalkReplayGuard } from "./replay-guard.js";
import { resolveNextcloudTalkOutboundSessionRoute } from "./session-route.js";
import {
  extractNextcloudTalkHeaders,
  generateNextcloudTalkSignature,
  verifyNextcloudTalkSignature,
} from "./signature.js";
import type { CoreConfig } from "./types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nextcloud-talk-replay-"));
  tempDirs.push(dir);
  return dir;
}

describe("nextcloud talk core", () => {
  it("accepts SecretRef botSecret and apiPassword at top-level", () => {
    const result = NextcloudTalkConfigSchema.safeParse({
      baseUrl: "https://cloud.example.com",
      botSecret: { source: "env", provider: "default", id: "NEXTCLOUD_TALK_BOT_SECRET" },
      apiUser: "bot",
      apiPassword: { source: "env", provider: "default", id: "NEXTCLOUD_TALK_API_PASSWORD" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts SecretRef botSecret and apiPassword on account", () => {
    const result = NextcloudTalkConfigSchema.safeParse({
      accounts: {
        main: {
          baseUrl: "https://cloud.example.com",
          botSecret: {
            source: "env",
            provider: "default",
            id: "NEXTCLOUD_TALK_MAIN_BOT_SECRET",
          },
          apiUser: "bot",
          apiPassword: {
            source: "env",
            provider: "default",
            id: "NEXTCLOUD_TALK_MAIN_API_PASSWORD",
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("keeps markdown mostly intact while trimming outer whitespace", () => {
    expect(markdownToNextcloudTalk("  **hello**  ")).toBe("**hello**");
  });

  it("escapes markdown-sensitive characters", () => {
    expect(escapeNextcloudTalkMarkdown("*hello* [x](y)")).toBe("\\*hello\\* \\[x\\]\\(y\\)");
  });

  it("formats mentions and code consistently", () => {
    expect(formatNextcloudTalkMention("@alice")).toBe("@alice");
    expect(formatNextcloudTalkMention("bob")).toBe("@bob");
    expect(formatNextcloudTalkCodeBlock("const x = 1;", "ts")).toBe("```ts\nconst x = 1;\n```");
    expect(formatNextcloudTalkInlineCode("x")).toBe("`x`");
    expect(formatNextcloudTalkInlineCode("x ` y")).toBe("`` x ` y ``");
  });

  it("strips markdown formatting and truncates on word boundaries", () => {
    expect(stripNextcloudTalkFormatting("**bold** [link](https://example.com) `code`")).toBe(
      "bold link",
    );
    expect(truncateNextcloudTalkText("alpha beta gamma delta", 14)).toBe("alpha beta...");
    expect(truncateNextcloudTalkText("short", 14)).toBe("short");
  });

  it("builds an outbound session route for normalized room targets", () => {
    const route = resolveNextcloudTalkOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "acct-1",
      target: "nextcloud-talk:room-123",
    });

    expect(route).toMatchObject({
      peer: {
        kind: "group",
        id: "room-123",
      },
      from: "nextcloud-talk:room:room-123",
      to: "nextcloud-talk:room-123",
    });
  });

  it("returns null when the target cannot be normalized to a room id", () => {
    expect(
      resolveNextcloudTalkOutboundSessionRoute({
        cfg: {},
        agentId: "main",
        accountId: "acct-1",
        target: "",
      }),
    ).toBeNull();
  });

  it("normalizes and recognizes supported room target formats", () => {
    expect(stripNextcloudTalkTargetPrefix(" room:abc123 ")).toBe("abc123");
    expect(stripNextcloudTalkTargetPrefix("nextcloud-talk:room:AbC123")).toBe("AbC123");
    expect(stripNextcloudTalkTargetPrefix("nc-talk:room:ops")).toBe("ops");
    expect(stripNextcloudTalkTargetPrefix("nc:room:ops")).toBe("ops");
    expect(stripNextcloudTalkTargetPrefix("room:   ")).toBeUndefined();

    expect(normalizeNextcloudTalkMessagingTarget("room:AbC123")).toBe("nextcloud-talk:abc123");
    expect(normalizeNextcloudTalkMessagingTarget("nc-talk:room:Ops")).toBe("nextcloud-talk:ops");

    expect(looksLikeNextcloudTalkTargetId("nextcloud-talk:room:abc12345")).toBe(true);
    expect(looksLikeNextcloudTalkTargetId("nc:opsroom1")).toBe(true);
    expect(looksLikeNextcloudTalkTargetId("abc12345")).toBe(true);
    expect(looksLikeNextcloudTalkTargetId("")).toBe(false);
  });

  it("verifies generated signatures and extracts normalized headers", () => {
    const body = JSON.stringify({ hello: "world" });
    const generated = generateNextcloudTalkSignature({
      body,
      secret: "secret-123",
    });

    expect(generated.random).toMatch(/^[0-9a-f]{64}$/);
    expect(generated.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(
      verifyNextcloudTalkSignature({
        signature: generated.signature,
        random: generated.random,
        body,
        secret: "secret-123",
      }),
    ).toBe(true);
    expect(
      verifyNextcloudTalkSignature({
        signature: "",
        random: "abc",
        body: "body",
        secret: "secret",
      }),
    ).toBe(false);
    expect(
      verifyNextcloudTalkSignature({
        signature: "deadbeef",
        random: "abc",
        body: "body",
        secret: "secret",
      }),
    ).toBe(false);

    expect(
      extractNextcloudTalkHeaders({
        "x-nextcloud-talk-signature": "sig",
        "x-nextcloud-talk-random": "rand",
        "x-nextcloud-talk-backend": "backend",
      }),
    ).toEqual({
      signature: "sig",
      random: "rand",
      backend: "backend",
    });
    expect(
      extractNextcloudTalkHeaders({
        "X-Nextcloud-Talk-Signature": "sig",
      }),
    ).toBeNull();
  });

  it("persists replay decisions across guard instances", async () => {
    const stateDir = await makeTempDir();

    const firstGuard = createNextcloudTalkReplayGuard({ stateDir });
    const firstAttempt = await firstGuard.shouldProcessMessage({
      accountId: "account-a",
      roomToken: "room-1",
      messageId: "msg-1",
    });
    const replayAttempt = await firstGuard.shouldProcessMessage({
      accountId: "account-a",
      roomToken: "room-1",
      messageId: "msg-1",
    });

    const secondGuard = createNextcloudTalkReplayGuard({ stateDir });
    const restartReplayAttempt = await secondGuard.shouldProcessMessage({
      accountId: "account-a",
      roomToken: "room-1",
      messageId: "msg-1",
    });

    expect(firstAttempt).toBe(true);
    expect(replayAttempt).toBe(false);
    expect(restartReplayAttempt).toBe(false);
  });

  it("scopes replay state by account namespace", async () => {
    const stateDir = await makeTempDir();
    const guard = createNextcloudTalkReplayGuard({ stateDir });

    const accountAFirst = await guard.shouldProcessMessage({
      accountId: "account-a",
      roomToken: "room-1",
      messageId: "msg-9",
    });
    const accountBFirst = await guard.shouldProcessMessage({
      accountId: "account-b",
      roomToken: "room-1",
      messageId: "msg-9",
    });

    expect(accountAFirst).toBe(true);
    expect(accountBFirst).toBe(true);
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

  it("resolves allowlist matches and group policy decisions", () => {
    expect(
      resolveNextcloudTalkAllowlistMatch({
        allowFrom: ["*"],
        senderId: "user-id",
      }).allowed,
    ).toBe(true);
    expect(
      resolveNextcloudTalkAllowlistMatch({
        allowFrom: ["nc:User-Id"],
        senderId: "user-id",
      }),
    ).toEqual({ allowed: true, matchKey: "user-id", matchSource: "id" });
    expect(
      resolveNextcloudTalkAllowlistMatch({
        allowFrom: ["allowed"],
        senderId: "other",
      }).allowed,
    ).toBe(false);

    expect(
      resolveNextcloudTalkGroupAllow({
        groupPolicy: "disabled",
        outerAllowFrom: ["owner"],
        innerAllowFrom: ["room-user"],
        senderId: "owner",
      }),
    ).toEqual({
      allowed: false,
      outerMatch: { allowed: false },
      innerMatch: { allowed: false },
    });
    expect(
      resolveNextcloudTalkGroupAllow({
        groupPolicy: "open",
        outerAllowFrom: [],
        innerAllowFrom: [],
        senderId: "owner",
      }),
    ).toEqual({
      allowed: true,
      outerMatch: { allowed: true },
      innerMatch: { allowed: true },
    });
    expect(
      resolveNextcloudTalkGroupAllow({
        groupPolicy: "allowlist",
        outerAllowFrom: [],
        innerAllowFrom: [],
        senderId: "owner",
      }),
    ).toEqual({
      allowed: false,
      outerMatch: { allowed: false },
      innerMatch: { allowed: false },
    });
    expect(
      resolveNextcloudTalkGroupAllow({
        groupPolicy: "allowlist",
        outerAllowFrom: [],
        innerAllowFrom: ["room-user"],
        senderId: "room-user",
      }),
    ).toEqual({
      allowed: true,
      outerMatch: { allowed: false },
      innerMatch: { allowed: true, matchKey: "room-user", matchSource: "id" },
    });
    expect(
      resolveNextcloudTalkGroupAllow({
        groupPolicy: "allowlist",
        outerAllowFrom: ["team-owner"],
        innerAllowFrom: ["room-user"],
        senderId: "room-user",
      }),
    ).toEqual({
      allowed: false,
      outerMatch: { allowed: false },
      innerMatch: { allowed: true, matchKey: "room-user", matchSource: "id" },
    });
    expect(
      resolveNextcloudTalkGroupAllow({
        groupPolicy: "allowlist",
        outerAllowFrom: ["team-owner"],
        innerAllowFrom: ["room-user"],
        senderId: "team-owner",
      }),
    ).toEqual({
      allowed: false,
      outerMatch: { allowed: true, matchKey: "team-owner", matchSource: "id" },
      innerMatch: { allowed: false },
    });
    expect(
      resolveNextcloudTalkGroupAllow({
        groupPolicy: "allowlist",
        outerAllowFrom: ["shared-user"],
        innerAllowFrom: ["shared-user"],
        senderId: "shared-user",
      }),
    ).toEqual({
      allowed: true,
      outerMatch: { allowed: true, matchKey: "shared-user", matchSource: "id" },
      innerMatch: { allowed: true, matchKey: "shared-user", matchSource: "id" },
    });
  });
});
