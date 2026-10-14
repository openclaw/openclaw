// Voice Call tests cover setup-time config migration behavior.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { migrateVoiceCallLegacyConfigInput } from "./config-migration.js";
import { VoiceCallConfigSchema } from "./config.js";

describe("voice-call config migration", () => {
  it("declares the setup entry needed to migrate installed packages", () => {
    const packageJson: unknown = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(packageJson).toMatchObject({ openclaw: { setupEntry: "./setup-api.ts" } });
  });

  it("maps deprecated provider and twilio.from fields into canonical config", () => {
    const migration = migrateVoiceCallLegacyConfigInput({
      value: {
        enabled: true,
        provider: "log",
        twilio: {
          from: "+15550001234",
        },
      },
    });

    expect(migration.config.provider).toBe("mock");
    expect(migration.config.fromNumber).toBe("+15550001234");
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
    const migration = migrateVoiceCallLegacyConfigInput({ value });

    expect(migration.config.streaming).toEqual({
      enabled: true,
      provider: "openai",
      providers: {
        other: { keep: "other-provider" },
        openai: {
          apiKey: { source: "env", provider: "default", id: "SYNTHETIC_VOICE_KEY" },
          model: "",
          silenceDurationMs: 700,
          vadThreshold: 0,
          keep: "current",
        },
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
    expect(VoiceCallConfigSchema.safeParse(migration.config).success).toBe(true);
    expect(migrateVoiceCallLegacyConfigInput({ value: migration.config })).toEqual({
      config: migration.config,
      changes: [],
    });
  });

  it("reports removal of legacy selectors while retaining canonical settings", () => {
    const migration = migrateVoiceCallLegacyConfigInput({
      value: {
        fromNumber: "+15550005678",
        twilio: { from: "+15550001234", accountSid: "synthetic-account" },
        streaming: { provider: "other", sttProvider: "openai" },
      },
      configPathPrefix: "voice-config",
    });

    expect(migration.config).toMatchObject({
      fromNumber: "+15550005678",
      twilio: { accountSid: "synthetic-account" },
      streaming: { provider: "other" },
    });
    expect(migration.config.twilio).not.toHaveProperty("from");
    expect(migration.config.streaming).not.toHaveProperty("sttProvider");
    expect(migration.changes).toEqual([
      "Removed voice-config.twilio.from (kept voice-config.fromNumber).",
      "Removed voice-config.streaming.sttProvider (kept voice-config.streaming.provider).",
    ]);
  });

  it("does not migrate non-finite legacy streaming numbers", () => {
    const migration = migrateVoiceCallLegacyConfigInput({
      value: {
        streaming: {
          silenceDurationMs: Number.NaN,
          vadThreshold: Number.POSITIVE_INFINITY,
        },
      },
      configPathPrefix: "plugins.entries.voice-call.config",
    });
    expect(migration.config.streaming).not.toHaveProperty("providers.openai");
    expect(migration.changes).toEqual([
      "Removed invalid plugins.entries.voice-call.config.streaming.silenceDurationMs.",
      "Removed invalid plugins.entries.voice-call.config.streaming.vadThreshold.",
    ]);
  });

  it("returns doctor migration change lines", () => {
    const migration = migrateVoiceCallLegacyConfigInput({
      value: {
        provider: "log",
        streaming: {
          sttProvider: "openai",
        },
        realtime: {
          agentContext: {
            includeSystemPrompt: true,
          },
        },
      },
      configPathPrefix: "plugins.entries.voice-call.config",
    });

    expect(migration.changes).toEqual([
      'Moved plugins.entries.voice-call.config.provider "log" → "mock".',
      "Moved plugins.entries.voice-call.config.streaming.sttProvider → plugins.entries.voice-call.config.streaming.provider.",
      "Removed plugins.entries.voice-call.config.realtime.agentContext.includeSystemPrompt.",
    ]);
  });
});
