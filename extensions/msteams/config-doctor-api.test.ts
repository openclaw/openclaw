import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./config-doctor-api.js";
import { MSTeamsConfigSchema } from "./src/config-schema.js";
import { msteamsDoctor } from "./src/doctor.js";
import { resolveMSTeamsLegacyWebhook } from "./src/webhook-route.js";

describe("Microsoft Teams Gateway webhook migration", () => {
  it("migrates an explicit port and streaming aliases into accepted channel config", () => {
    const old = {
      enabled: true,
      webhook: { port: 3978, path: "/teams/events" },
      streamMode: "block",
    };
    expect(MSTeamsConfigSchema.safeParse(old).success).toBe(false);
    expect(legacyConfigRules.some((rule) => rule.match?.(old, {}))).toBe(true);
    const migrated = normalizeCompatibilityConfig({
      cfg: { channels: { msteams: old } },
    });
    const channel = MSTeamsConfigSchema.parse(migrated.config.channels?.msteams);
    expect(channel.webhook).toEqual({ path: "/teams/events" });
    expect(channel.legacyWebhook).toEqual({ port: 3978 });
    expect(channel.streaming?.mode).toBe("block");
    expect(
      msteamsDoctor.runConfigSequence({ cfg: migrated.config, env: {} }).infoNotes?.join(" "),
    ).toContain("18789/teams/events");
  });

  it.each([
    { setting: undefined, endpoint: { port: 3978 }, note: "compatibility port 3978" },
    {
      setting: { port: 44978, host: "127.0.0.1" },
      endpoint: { port: 44978, host: "127.0.0.1" },
      note: "compatibility port 44978",
    },
    { setting: false as const, endpoint: undefined, note: "compatibility listener is disabled" },
  ])("keeps runtime and Doctor aligned for $setting", ({ setting, endpoint, note }) => {
    const cfg: OpenClawConfig = {
      gateway: { port: 19001 },
      channels: { msteams: { webhook: { path: "/teams/events" }, legacyWebhook: setting } },
    };
    const migrated = normalizeCompatibilityConfig({ cfg });
    expect(migrated.changes).toEqual([]);
    const channel = MSTeamsConfigSchema.parse(migrated.config.channels?.msteams);
    expect(resolveMSTeamsLegacyWebhook(channel)).toEqual(endpoint);
    const notes = msteamsDoctor.runConfigSequence({
      cfg,
      env: { OPENCLAW_GATEWAY_PORT: "19002" },
    });
    expect(notes.warningNotes).toEqual([]);
    const message = notes.infoNotes?.join(" ");
    expect(message).toContain("19002/teams/events");
    expect(message).toContain(note);
    expect(message).toContain("channels.msteams.legacyWebhook=false");
  });

  it("keeps the canonical endpoint and removes an empty legacy webhook object", () => {
    const cfg: OpenClawConfig = {
      channels: {
        msteams: {
          legacyWebhook: { port: 44978, host: "127.0.0.1" },
          webhook: { port: 3978 },
        },
      },
    };
    const migrated = normalizeCompatibilityConfig({ cfg });
    expect(migrated.config.channels?.msteams).toEqual({
      legacyWebhook: { port: 44978, host: "127.0.0.1" },
    });
    expect(migrated.changes).toEqual([expect.stringContaining("already configured")]);
    expect(normalizeCompatibilityConfig({ cfg: migrated.config }).changes).toEqual([]);
  });

  it("keeps an explicit opt-out while removing the old port key", () => {
    const old = { legacyWebhook: false as const, webhook: { port: 3978, path: "/teams/events" } };
    const migrated = normalizeCompatibilityConfig({ cfg: { channels: { msteams: old } } });
    const channel = MSTeamsConfigSchema.parse(migrated.config.channels?.msteams);
    expect(channel.legacyWebhook).toBe(false);
    expect(channel.webhook).toEqual({ path: "/teams/events" });
    expect(resolveMSTeamsLegacyWebhook(channel)).toBeUndefined();
  });

  it.each([
    ["/api/:tenant/messages", "uses Express pattern syntax"],
    ["/api{/messages}", "uses Express pattern syntax"],
    ["/health", "is reserved for Gateway probes"],
    ["/healthz", "is reserved for Gateway probes"],
    ["/ready", "is reserved for Gateway probes"],
    ["/readyz", "is reserved for Gateway probes"],
    ["/startup", "is reserved for Gateway probes"],
    ["/startupz", "is reserved for Gateway probes"],
    ["/api/channels/teams", "requires Gateway authentication"],
    ["/%61pi/channels/teams", "requires Gateway authentication"],
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
        legacyWebhook === false
          ? "cannot receive Teams callbacks"
          : "Compatibility port 3978 continues",
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
