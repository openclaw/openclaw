import { readFileSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import setup from "../setup-api.js";
import { migrateVoiceCallLegacyConfigInput } from "./config-migration.js";
import { normalizeVoiceCallConfig } from "./config.js";

function migrate(value: unknown, configPathPrefix?: string) {
  return migrateVoiceCallLegacyConfigInput({ value, configPathPrefix });
}

describe("voice-call config migration", () => {
  it("declares the setup entry needed to migrate installed packages", () => {
    const packageJson: unknown = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(packageJson).toMatchObject({ openclaw: { setupEntry: "./setup-api.ts" } });
  });

  it("maps deprecated provider and twilio.from fields into canonical config", () => {
    const migration = migrate({ provider: "log", twilio: { from: "+15550001234" } });
    expect(migration.config).toMatchObject({ provider: "mock", fromNumber: "+15550001234" });
  });

  it("migrates through the setup hook without changing its input or sibling plugins", () => {
    const registerConfigMigration = vi.fn<OpenClawPluginApi["registerConfigMigration"]>();
    setup.register(createTestPluginApi({ registerConfigMigration }));
    const other = { config: { nested: { keep: true } } };
    const pluginConfig = (provider: string) => ({
      plugins: { entries: { "voice-call": { enabled: true, config: { provider } }, other } },
    });
    const config = pluginConfig("log");
    const before = structuredClone(config);
    const migration = registerConfigMigration.mock.calls[0]?.[0](config);

    expect(config).toEqual(before);
    expect(migration?.config).toEqual(pluginConfig("mock"));
  });

  it("fills only missing streaming provider fields while preserving canonical values", () => {
    const current = {
      apiKey: { source: "env", provider: "default", id: "SYNTHETIC_VOICE_KEY" },
      model: "",
      vadThreshold: 0,
      keep: "current",
    };
    const value = {
      streaming: {
        enabled: true,
        sttProvider: "openai",
        openaiApiKey: "synthetic-legacy-key",
        sttModel: "synthetic-legacy-model",
        silenceDurationMs: 700,
        vadThreshold: 0.4,
        providers: { openai: current, other: { keep: "other-provider" } },
      },
    };
    const before = structuredClone(value);
    const migration = migrate(value);

    expect(migration.config.streaming).toEqual({
      enabled: true,
      provider: "openai",
      providers: {
        other: { keep: "other-provider" },
        openai: { ...before.streaming.providers.openai, silenceDurationMs: 700 },
      },
    });
    const prefix = "plugins.entries.voice-call.config.streaming";
    expect(migration.changes).toEqual([
      `Moved ${prefix}.sttProvider → ${prefix}.provider.`,
      `Removed ${prefix}.openaiApiKey (kept ${prefix}.providers.openai.apiKey).`,
      `Removed ${prefix}.sttModel (kept ${prefix}.providers.openai.model).`,
      `Moved ${prefix}.silenceDurationMs → ${prefix}.providers.openai.silenceDurationMs.`,
      `Removed ${prefix}.vadThreshold (kept ${prefix}.providers.openai.vadThreshold).`,
    ]);
    expect(value).toEqual(before);
    expect(() => normalizeVoiceCallConfig(migration.config)).not.toThrow();
    expect(migrate(migration.config)).toEqual({ config: migration.config, changes: [] });
  });

  it("reports removal of legacy selectors while retaining canonical settings", () => {
    const migration = migrate(
      {
        fromNumber: "+15550005678",
        twilio: { from: "+15550001234", accountSid: "synthetic-account" },
        streaming: { provider: "other", sttProvider: "openai" },
      },
      "voice-config",
    );

    expect(migration.config.fromNumber).toBe("+15550005678");
    expect(migration.config.twilio).toEqual({ accountSid: "synthetic-account" });
    expect(migration.config.streaming).toEqual({ provider: "other" });
    expect(migration.changes).toEqual([
      "Removed voice-config.twilio.from (kept voice-config.fromNumber).",
      "Removed voice-config.streaming.sttProvider (kept voice-config.streaming.provider).",
    ]);
  });

  it("does not migrate non-finite legacy streaming numbers", () => {
    const migration = migrate({
      streaming: { silenceDurationMs: Number.NaN, vadThreshold: Number.POSITIVE_INFINITY },
    });
    expect(migration.config.streaming).not.toHaveProperty("providers.openai");
    expect(migration.changes).toEqual([
      "Removed invalid plugins.entries.voice-call.config.streaming.silenceDurationMs.",
      "Removed invalid plugins.entries.voice-call.config.streaming.vadThreshold.",
    ]);
  });

  it("returns doctor migration change lines", () => {
    const migration = migrate({
      provider: "log",
      streaming: { sttProvider: "openai" },
      realtime: { agentContext: { includeSystemPrompt: true } },
    });

    expect(migration.changes).toEqual([
      'Moved plugins.entries.voice-call.config.provider "log" → "mock".',
      "Moved plugins.entries.voice-call.config.streaming.sttProvider → plugins.entries.voice-call.config.streaming.provider.",
      "Removed plugins.entries.voice-call.config.realtime.agentContext.includeSystemPrompt.",
    ]);
  });
});
