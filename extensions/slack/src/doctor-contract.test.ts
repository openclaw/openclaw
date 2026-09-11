import { asRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it } from "vitest";
import { normalizeCompatibilityConfig } from "./doctor-contract.js";

describe("slack doctor contract", () => {
  it.each([true, false, "auto"] as const)(
    "removes command enablement flags (%s) without changing other settings",
    (native) => {
      const cfg = {
        commands: { native: false },
        channels: {
          slack: {
            commands: { native, nativeSkills: false },
            slashCommand: {
              enabled: native !== false,
              name: "acme",
              sessionPrefix: "custom",
              ephemeral: false,
            },
            accounts: {
              work: {
                commands: { native, nativeSkills: true },
                slashCommand: { enabled: false, name: "work" },
              },
            },
          },
          telegram: { commands: { native: false } },
        },
      };
      // Raw file input may contain accounts with only retired settings.
      asRecord(cfg.channels.slack.accounts).empty = {
        commands: { native },
        slashCommand: { enabled: true },
      };
      const original = structuredClone(cfg);
      const result = normalizeCompatibilityConfig({ cfg });
      expect(result.config).toEqual({
        commands: { native: false },
        channels: {
          slack: {
            commands: { nativeSkills: false },
            slashCommand: { name: "acme", sessionPrefix: "custom", ephemeral: false },
            accounts: {
              work: { commands: { nativeSkills: true }, slashCommand: { name: "work" } },
              empty: {},
            },
          },
          telegram: { commands: { native: false } },
        },
      });
      expect(cfg).toEqual(original);
      expect(result.changes).toHaveLength(6);
      expect(result.changes.every((change) => change.includes("always"))).toBe(true);
      expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
        config: result.config,
        changes: [],
      });
    },
  );

  it("removes the retired Enterprise Grid setting from root and account config", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        channels: {
          slack: {
            enterpriseOrgInstall: true,
            accounts: { work: { enterpriseOrgInstall: false } },
          },
        },
      } as never,
    });

    expect(result.config.channels?.slack).toEqual({ accounts: { work: {} } });
    expect(result.changes).toEqual([
      "Removed retired channels.slack.enterpriseOrgInstall; Slack detects org-wide installations automatically.",
      "Removed retired channels.slack.accounts.work.enterpriseOrgInstall; Slack detects org-wide installations automatically.",
    ]);
  });

  it("removes retired interactive reply capabilities from root and account config", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        channels: {
          slack: {
            capabilities: { interactiveReplies: true },
            accounts: {
              work: { capabilities: ["threads", " interactiveReplies "] },
            },
          },
        },
      } as never,
    });

    expect(result.config.channels?.slack).toEqual({
      accounts: { work: { capabilities: ["threads"] } },
    });
    expect(result.changes).toEqual([
      "Removed retired channels.slack.capabilities.interactiveReplies; use typed presentation actions instead.",
      "Removed retired channels.slack.accounts.work.capabilities.interactiveReplies; use typed presentation actions instead.",
    ]);
  });

  it("removes empty object-form capabilities accepted by the retired schema", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        channels: {
          slack: {
            capabilities: {},
            accounts: { work: { capabilities: {} } },
          },
        },
      } as never,
    });

    expect(result.config.channels?.slack).toEqual({ accounts: { work: {} } });
    expect(result.changes).toEqual([
      "Removed retired empty channels.slack.capabilities object; use typed presentation actions instead.",
      "Removed retired empty channels.slack.accounts.work.capabilities object; use typed presentation actions instead.",
    ]);
  });

  it("moves direct DM reply mode to the chat-type map", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        channels: {
          slack: {
            dm: { replyToMode: "all" },
            accounts: { work: { dm: { replyToMode: "first" } } },
          },
        },
      } as never,
    });
    expect(result.config.channels?.slack).toEqual({
      dm: {},
      replyToModeByChatType: { direct: "all" },
      accounts: {
        work: { dm: {}, replyToModeByChatType: { direct: "first" } },
      },
    });
  });
});
