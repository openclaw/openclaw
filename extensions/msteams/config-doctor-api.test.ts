import type { MSTeamsConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, expect, it, vi } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./config-doctor-api.js";
import { MSTeamsConfigSchema } from "./src/config-schema.js";
import { msteamsDoctor } from "./src/doctor.js";
import { resolveMSTeamsLegacyWebhook } from "./src/webhook-route.js";

const diagnose = (msteams: Pick<MSTeamsConfig, "enabled" | "webhook" | "legacyWebhook">) =>
  msteamsDoctor.runConfigSequence({ cfg: { channels: { msteams } }, env: {} });
const pinnedListener = { port: 44978, host: "127.0.0.1" };
const webhook = { path: "/teams/events" };

afterEach(() => vi.unstubAllEnvs());

it.each([undefined, false] as const)("migrates config with opt-out %j", (legacy) => {
  const old = {
    ...(legacy === false ? { legacyWebhook: false as const } : {}),
    webhook: { ...webhook, port: 3978 },
    streamMode: "block",
  };
  expect(MSTeamsConfigSchema.safeParse(old).success).toBe(false);
  expect(legacyConfigRules.some((rule) => rule.match?.(old, {}))).toBe(true);
  const migrated = normalizeCompatibilityConfig({ cfg: { channels: { msteams: old } } });
  const channel = MSTeamsConfigSchema.parse(migrated.config.channels?.msteams);
  expect(channel.enabled).toBeUndefined();
  expect(channel.webhook).toEqual({ path: "/teams/events" });
  expect(channel.legacyWebhook).toEqual(legacy === false ? false : { port: 3978 });
  const endpoint = resolveMSTeamsLegacyWebhook(channel);
  expect(endpoint).toEqual(legacy === false ? undefined : { port: 3978 });
  expect(channel.streaming?.mode).toBe("block");
  expect(diagnose(channel).infoNotes?.join(" ")).toContain("18789/teams/events");
});

it.each([undefined, pinnedListener, false] as const)("aligns runtime and Doctor: %j", (pin) => {
  const cfg: OpenClawConfig = {
    gateway: { port: 19001 },
    channels: { msteams: { webhook, legacyWebhook: pin } },
  };
  const migrated = normalizeCompatibilityConfig({ cfg: structuredClone(cfg) });
  expect(migrated.changes).toEqual([]);
  const channel = MSTeamsConfigSchema.parse(migrated.config.channels?.msteams);
  expect(channel.enabled).toBeUndefined();
  expect(resolveMSTeamsLegacyWebhook(channel)).toEqual(pin || undefined);
  const notes = msteamsDoctor.runConfigSequence({
    cfg,
    env: { OPENCLAW_GATEWAY_PORT: "19002" },
  });
  expect(notes.warningNotes).toEqual([]);
  const message = notes.infoNotes?.join(" ");
  expect(message).toContain("19002/teams/events");
  expect(message).toContain(
    pin ? "compatibility port 44978" : "no compatibility listener is configured",
  );
  if (pin) {
    expect(message).toContain("remove the channels.msteams.legacyWebhook pin");
  }
});

it("keeps the canonical endpoint and removes an empty legacy webhook object", () => {
  const cfg = { channels: { msteams: { legacyWebhook: pinnedListener, webhook: { port: 3978 } } } };
  const migrated = normalizeCompatibilityConfig({ cfg: structuredClone(cfg) });
  expect(migrated.config.channels?.msteams).toEqual({ legacyWebhook: pinnedListener });
  expect(migrated.changes).toEqual([expect.stringContaining("already configured")]);
  expect(normalizeCompatibilityConfig({ cfg: migrated.config }).changes).toEqual([]);
});

it("defers unseen service credentials without turning environment credentials into config", () => {
  for (const key of ["AUTH_TYPE", "APP_ID", "APP_PASSWORD", "TENANT_ID"]) {
    vi.stubEnv(`MSTEAMS_${key}`, undefined);
  }
  const cfg = {};
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
    const notes = diagnose({ webhook: { path: `${path}?tenant=one` }, legacyWebhook });
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
  expect(diagnose({ webhook: { path: "/health/messages" } }).warningNotes).toEqual([]);
  const disabled = diagnose({ enabled: false });
  expect(disabled).toEqual({ changeNotes: [], warningNotes: [], infoNotes: [] });
});
