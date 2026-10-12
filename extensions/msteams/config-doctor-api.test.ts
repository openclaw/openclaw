import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./config-doctor-api.js";
import { MSTeamsConfigSchema } from "./src/config-schema.js";
import { msteamsDoctor } from "./src/doctor.js";

describe("Microsoft Teams Gateway webhook migration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("migrates an explicit port and streaming aliases into accepted channel config", () => {
    const old = {
      webhook: { port: 3978, path: "/teams/events" },
      streamMode: "block",
    };
    expect(MSTeamsConfigSchema.safeParse(old).success).toBe(false);
    expect(legacyConfigRules.some((rule) => rule.match?.(old, {}))).toBe(true);
    const migrated = normalizeCompatibilityConfig({
      cfg: { channels: { msteams: old } },
    });
    const channel = MSTeamsConfigSchema.parse(migrated.config.channels?.msteams);
    expect(channel.enabled).toBeUndefined();
    expect(channel.webhook).toEqual({ path: "/teams/events" });
    expect(channel.legacyWebhook).toEqual({ port: 3978 });
    expect(channel.streaming?.mode).toBe("block");
    expect(
      msteamsDoctor.runConfigSequence({ cfg: migrated.config, env: {} }).infoNotes?.join(" "),
    ).toContain("18789/teams/events");
  });

  it("defers unseen service credentials without turning environment credentials into config", () => {
    vi.stubEnv("MSTEAMS_AUTH_TYPE", undefined);
    vi.stubEnv("MSTEAMS_APP_ID", undefined);
    vi.stubEnv("MSTEAMS_APP_PASSWORD", undefined);
    vi.stubEnv("MSTEAMS_TENANT_ID", undefined);
    const cfg: OpenClawConfig = {};
    expect(normalizeCompatibilityConfig({ cfg }).historicalWebhookAccountIds).toBeNull();

    vi.stubEnv("MSTEAMS_APP_ID", "synthetic-app");
    vi.stubEnv("MSTEAMS_APP_PASSWORD", "synthetic-password");
    vi.stubEnv("MSTEAMS_TENANT_ID", "synthetic-tenant");
    const migrated = normalizeCompatibilityConfig({ cfg });
    expect(migrated.historicalWebhookAccountIds).toEqual([undefined]);
    expect(migrated.config).toEqual({});
    expect(migrated.changes).toEqual([]);
  });

  it.each([
    ["/api/:tenant/messages", "uses Express pattern syntax"],
    ["/startupz", "is reserved for Gateway checks"],
    ["/api/channels/teams", "requires Gateway authentication"],
  ])("diagnoses unavailable %s callbacks under every compatibility setting", (path, reason) => {
    for (const legacyWebhook of [undefined, { port: 3978 }, false] as const) {
      const cfg: OpenClawConfig = {
        channels: { msteams: { webhook: { path: `${path}?tenant=one` }, legacyWebhook } },
      };
      const notes = msteamsDoctor.runConfigSequence({ cfg, env: {} });
      expect(notes.infoNotes ?? []).toEqual([]);
      const warning = notes.warningNotes.join(" ");
      expect(warning).toContain(`${path}?tenant=one ${reason}`);
      expect(warning).toContain("18789/api/messages");
      expect(warning).toContain(
        legacyWebhook ? "Compatibility port 3978 continues" : "cannot receive Teams callbacks",
      );
    }
  });

  it("does not classify nested probe paths as reserved or warn for disabled channels", () => {
    const cfg: OpenClawConfig = {
      channels: { msteams: { webhook: { path: "/health/messages" } } },
    };
    expect(msteamsDoctor.runConfigSequence({ cfg, env: {} }).warningNotes).toEqual([]);
    expect(
      msteamsDoctor.runConfigSequence({ cfg: { channels: { msteams: { enabled: false } } } }),
    ).toEqual({ changeNotes: [], warningNotes: [], infoNotes: [] });
  });
});
