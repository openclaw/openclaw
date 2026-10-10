import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./config-doctor-api.js";
import { MSTeamsConfigSchema } from "./src/config-schema.js";
import { msteamsDoctor } from "./src/doctor.js";
import { resolveMSTeamsLegacyWebhook } from "./src/webhook-route.js";

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

  it.each([
    { setting: undefined, endpoint: undefined, note: "no compatibility listener is configured" },
    {
      setting: { port: 44978, host: "127.0.0.1" },
      endpoint: { port: 44978, host: "127.0.0.1" },
      note: "compatibility port 44978",
    },
    {
      setting: false as const,
      endpoint: undefined,
      note: "no compatibility listener is configured",
    },
  ])("keeps runtime and Doctor aligned for $setting", ({ setting, endpoint, note }) => {
    const cfg: OpenClawConfig = {
      gateway: { port: 19001 },
      channels: { msteams: { webhook: { path: "/teams/events" }, legacyWebhook: setting } },
    };
    const migrated = normalizeCompatibilityConfig({ cfg });
    expect(migrated.changes).toEqual([]);
    const channel = MSTeamsConfigSchema.parse(migrated.config.channels?.msteams);
    expect(channel.enabled).toBeUndefined();
    expect(resolveMSTeamsLegacyWebhook(channel)).toEqual(endpoint);
    const notes = msteamsDoctor.runConfigSequence({
      cfg,
      env: { OPENCLAW_GATEWAY_PORT: "19002" },
    });
    expect(notes.warningNotes).toEqual([]);
    const message = notes.infoNotes?.join(" ");
    expect(message).toContain("19002/teams/events");
    expect(message).toContain(note);
    if (endpoint) {
      expect(message).toContain("remove the channels.msteams.legacyWebhook pin");
    }
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
    expect(channel.enabled).toBeUndefined();
    expect(channel.webhook).toEqual({ path: "/teams/events" });
    expect(resolveMSTeamsLegacyWebhook(channel)).toBeUndefined();
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
    ["/api{/messages}", "uses Express pattern syntax"],
    ["/health", "is reserved for Gateway checks"],
    ["/healthz", "is reserved for Gateway checks"],
    ["/ready", "is reserved for Gateway checks"],
    ["/readyz", "is reserved for Gateway checks"],
    ["/startup", "is reserved for Gateway checks"],
    ["/startupz", "is reserved for Gateway checks"],
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
