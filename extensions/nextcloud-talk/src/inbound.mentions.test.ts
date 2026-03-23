import { describe, expect, it } from "vitest";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import {
  parseStructuredNextcloudTalkBody,
  resolveExplicitNextcloudTalkMention,
} from "./inbound.js";

// ---------------------------------------------------------------------------
// parseStructuredNextcloudTalkBody
// ---------------------------------------------------------------------------

describe("parseStructuredNextcloudTalkBody", () => {
  it("returns plain text unchanged with empty mentionEntries and structured=false", () => {
    const result = parseStructuredNextcloudTalkBody("hello world");
    expect(result.text).toBe("hello world");
    expect(result.structured).toBe(false);
    expect(result.mentionEntries).toEqual([]);
  });

  it("returns raw body unchanged when not JSON (leading whitespace preserved)", () => {
    const raw = "  not json  ";
    const result = parseStructuredNextcloudTalkBody(raw);
    expect(result.text).toBe(raw);
    expect(result.structured).toBe(false);
    expect(result.mentionEntries).toEqual([]);
  });

  it("strips placeholder tokens and sets structured=true for a valid structured body", () => {
    const raw = JSON.stringify({
      message: "Hey {mention0}, how are you?",
      parameters: {
        mention0: { type: "user", id: "agent", name: "iClaw" },
      },
    });
    const result = parseStructuredNextcloudTalkBody(raw);
    expect(result.text).toBe("Hey , how are you?");
    expect(result.structured).toBe(true);
    expect(result.mentionEntries).toHaveLength(1);
    expect(result.mentionEntries[0]).toMatchObject({
      key: "mention0",
      type: "user",
      id: "agent",
      name: "iClaw",
    });
  });

  it("produces empty text for a mention-only structured body", () => {
    const raw = JSON.stringify({
      message: "{mention-user1}",
      parameters: {
        "mention-user1": { type: "user", id: "agent", name: "iClaw" },
      },
    });
    const result = parseStructuredNextcloudTalkBody(raw);
    expect(result.text).toBe("");
    expect(result.structured).toBe(true);
  });

  it("strips placeholder before a command so command parsing can see it", () => {
    const raw = JSON.stringify({
      message: "{mention0} /reset",
      parameters: {
        mention0: { type: "user", id: "agent" },
      },
    });
    const result = parseStructuredNextcloudTalkBody(raw);
    expect(result.text).toBe("/reset");
    expect(result.structured).toBe(true);
  });

  it("falls back to raw body text when JSON has no message field", () => {
    const raw = JSON.stringify({ parameters: {} });
    const result = parseStructuredNextcloudTalkBody(raw);
    expect(result.text).toBe(raw.trim());
    expect(result.structured).toBe(true);
    expect(result.mentionEntries).toEqual([]);
  });

  it("falls back to raw body when JSON is malformed", () => {
    const raw = "{broken json";
    const result = parseStructuredNextcloudTalkBody(raw);
    expect(result.text).toBe(raw);
    expect(result.structured).toBe(false);
    expect(result.mentionEntries).toEqual([]);
  });

  it("handles missing parameters key gracefully", () => {
    const raw = JSON.stringify({ message: "hello" });
    const result = parseStructuredNextcloudTalkBody(raw);
    expect(result.text).toBe("hello");
    expect(result.structured).toBe(true);
    expect(result.mentionEntries).toEqual([]);
  });

  it("extracts mention-id (hyphenated) field into mentionId", () => {
    const raw = JSON.stringify({
      message: "ping {m}",
      parameters: {
        m: { type: "user", "mention-id": "agent@cloud.example.com" },
      },
    });
    const result = parseStructuredNextcloudTalkBody(raw);
    expect(result.mentionEntries[0]?.mentionId).toBe("agent@cloud.example.com");
    // placeholder stripped
    expect(result.text).toBe("ping");
  });

  it("multiple mention entries are all captured and placeholders stripped", () => {
    const raw = JSON.stringify({
      message: "{a} and {b}",
      parameters: {
        a: { type: "user", id: "alice" },
        b: { type: "user", id: "bob" },
      },
    });
    const result = parseStructuredNextcloudTalkBody(raw);
    expect(result.mentionEntries).toHaveLength(2);
    expect(result.mentionEntries.map((e) => e.id)).toEqual(
      expect.arrayContaining(["alice", "bob"]),
    );
    expect(result.text).toBe("and");
  });
});

// ---------------------------------------------------------------------------
// resolveExplicitNextcloudTalkMention
// ---------------------------------------------------------------------------

function makeAccount(
  overrides: Partial<ResolvedNextcloudTalkAccount> = {},
): ResolvedNextcloudTalkAccount {
  return {
    accountId: "default",
    enabled: true,
    baseUrl: "https://cloud.example.com",
    secret: "secret",
    secretSource: "config",
    config: {
      dmPolicy: "pairing",
      allowFrom: [],
      groupPolicy: "allowlist",
      groupAllowFrom: [],
    },
    ...overrides,
  };
}

describe("resolveExplicitNextcloudTalkMention", () => {
  it("returns true when a user-type entry matches the account id", () => {
    const result = resolveExplicitNextcloudTalkMention({
      mentionEntries: [{ key: "m0", type: "user", id: "default" }],
      account: makeAccount({ accountId: "default" }),
    });
    expect(result).toBe(true);
  });

  it("is case-insensitive on both sides", () => {
    const result = resolveExplicitNextcloudTalkMention({
      mentionEntries: [{ key: "m0", type: "user", id: "AGENT" }],
      account: makeAccount({ accountId: "agent" }),
    });
    expect(result).toBe(true);
  });

  it("returns false when type is not 'user'", () => {
    const result = resolveExplicitNextcloudTalkMention({
      mentionEntries: [{ key: "m0", type: "guest", id: "agent" }],
      account: makeAccount({ accountId: "agent" }),
    });
    expect(result).toBe(false);
  });

  it("returns false when no mention entries match", () => {
    const result = resolveExplicitNextcloudTalkMention({
      mentionEntries: [{ key: "m0", type: "user", id: "alice" }],
      account: makeAccount({ accountId: "agent" }),
    });
    expect(result).toBe(false);
  });

  it("returns false when mentionEntries is empty", () => {
    const result = resolveExplicitNextcloudTalkMention({
      mentionEntries: [],
      account: makeAccount({ accountId: "agent" }),
    });
    expect(result).toBe(false);
  });

  it("matches via mentionId (email local part) when apiUser is set", () => {
    const result = resolveExplicitNextcloudTalkMention({
      mentionEntries: [{ key: "m0", type: "user", mentionId: "bot@cloud.example.com" }],
      account: makeAccount({
        config: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
          apiUser: "bot@cloud.example.com",
        },
      }),
    });
    expect(result).toBe(true);
  });

  it("matches via local part of apiUser email", () => {
    const result = resolveExplicitNextcloudTalkMention({
      mentionEntries: [{ key: "m0", type: "user", id: "bot" }],
      account: makeAccount({
        config: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
          apiUser: "bot@cloud.example.com",
        },
      }),
    });
    expect(result).toBe(true);
  });

  it("matches via configured account name", () => {
    const result = resolveExplicitNextcloudTalkMention({
      mentionEntries: [{ key: "m0", type: "user", name: "iClaw" }],
      account: makeAccount({ name: "iClaw" }),
    });
    expect(result).toBe(true);
  });
});
