// Googlechat tests cover doctor contract plugin behavior.
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract.js";
import { collectGoogleChatMutableAllowlistWarnings } from "./doctor.js";

describe("googlechat doctor contract", () => {
  it.each([
    {
      label: "space sender",
      config: { groups: { "spaces/team": { users: ["carol@example.com"] } } },
      expectedPath: "channels.googlechat.groups.spaces/team.users: carol@example.com",
    },
  ])("warns for mutable $label allowlist entries", ({ config, expectedPath }) => {
    const warnings = collectGoogleChatMutableAllowlistWarnings({
      cfg: { channels: { googlechat: config } },
    });

    expect(warnings).toContain(`- ${expectedPath}`);
  });

  it("removes retired reaction flags", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        channels: {
          googlechat: {
            actions: { reactions: true },
            accounts: { work: { actions: { reactions: false } } },
          },
        },
      } as never,
    });
    expect(result.config.channels?.googlechat).toEqual({ accounts: { work: {} } });
    expect(result.changes).toEqual([
      "Removed channels.googlechat.actions.reactions (Google Chat does not support reactions).",
      "Removed channels.googlechat.accounts.work.actions.reactions (Google Chat does not support reactions).",
    ]);
  });
  it("detects and promotes legacy nested DM access at root and account scope", () => {
    const dmRules = legacyConfigRules.filter((rule) => rule.message.includes("dm.policy"));
    expect(dmRules[0]?.match?.({ dm: { policy: "allowlist" } }, {})).toBe(true);
    expect(dmRules[1]?.match?.({ work: { dm: { allowFrom: ["users/work"] } } }, {})).toBe(true);

    const result = normalizeCompatibilityConfig({
      cfg: {
        channels: {
          googlechat: {
            dm: { enabled: false, policy: "allowlist", allowFrom: ["users/root"] },
            accounts: { work: { dm: { policy: "open", allowFrom: ["*"] } } },
          },
        },
      } as never,
    });

    expect(result.config.channels?.googlechat).toEqual({
      dm: { enabled: false },
      dmPolicy: "allowlist",
      allowFrom: ["users/root"],
      accounts: { work: { dmPolicy: "open", allowFrom: ["*"] } },
    });
  });

  it("moves flat delivery aliases at root and account level with root seeding", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        channels: {
          googlechat: {
            streamMode: "append",
            chunkMode: "newline",
            accounts: {
              work: { blockStreaming: true },
            },
          },
        },
      } as never,
    });

    const googlechat = result.config.channels?.googlechat as unknown as Record<string, unknown>;
    expect(googlechat.streamMode).toBeUndefined();
    expect(googlechat.streaming).toEqual({ chunkMode: "newline" });
    expect(googlechat.chunkMode).toBeUndefined();
    const work = (googlechat.accounts as Record<string, Record<string, unknown>>).work;
    // Google Chat's account merge replaces root streaming wholesale, so the
    // migrated account object carries the inherited root chunk mode.
    expect(work?.streaming).toEqual({ chunkMode: "newline", block: { enabled: true } });
    expect(work?.blockStreaming).toBeUndefined();

    const second = normalizeCompatibilityConfig({ cfg: result.config });
    expect(second.changes).toEqual([]);
  });
});
