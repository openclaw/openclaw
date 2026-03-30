import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getTtsMaxLength,
  isSummarizationEnabled,
  isTtsEnabled,
  resolveTtsAutoMode,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  setTtsAutoMode,
  setTtsEnabled,
  setTtsMaxLength,
  setSummarizationEnabled,
  _test,
} from "./tts.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempPrefs(): { prefsPath: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-tts-test-"));
  const prefsPath = path.join(dir, "tts.json");
  return {
    prefsPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// resolveTtsConfig — pure config transformation
// ---------------------------------------------------------------------------

describe("resolveTtsConfig", () => {
  it("returns defaults when config is empty", () => {
    const result = resolveTtsConfig({});
    expect(result.auto).toBe("off");
    expect(result.mode).toBe("final");
    expect(result.providerSource).toBe("default");
    expect(result.provider).toBe("");
    expect(result.maxTextLength).toBe(4096);
    expect(result.timeoutMs).toBe(30_000);
    expect(result.modelOverrides.enabled).toBe(true);
    expect(result.providerConfigs).toEqual({});
  });

  it("sets auto=always when enabled:true", () => {
    const result = resolveTtsConfig({ messages: { tts: { enabled: true } } });
    expect(result.auto).toBe("always");
  });

  it("sets auto=off when enabled:false", () => {
    const result = resolveTtsConfig({ messages: { tts: { enabled: false } } });
    expect(result.auto).toBe("off");
  });

  it("prefers explicit auto field over the enabled flag", () => {
    const result = resolveTtsConfig({
      messages: { tts: { enabled: true, auto: "tagged" } },
    });
    expect(result.auto).toBe("tagged");
  });

  it("supports all documented auto modes", () => {
    for (const mode of ["always", "tagged", "inbound", "off"] as const) {
      const result = resolveTtsConfig({ messages: { tts: { auto: mode } } });
      expect(result.auto).toBe(mode);
    }
  });

  it("marks providerSource as config when provider is explicitly set", () => {
    const result = resolveTtsConfig({
      messages: { tts: { provider: "elevenlabs" } },
    });
    expect(result.providerSource).toBe("config");
    expect(result.provider).toBe("elevenlabs");
  });

  it("marks providerSource as default when no provider is set", () => {
    const result = resolveTtsConfig({ messages: { tts: {} } });
    expect(result.providerSource).toBe("default");
    expect(result.provider).toBe("");
  });

  it("respects custom maxTextLength", () => {
    const result = resolveTtsConfig({
      messages: { tts: { maxTextLength: 2000 } },
    });
    expect(result.maxTextLength).toBe(2000);
  });

  it("respects custom timeoutMs", () => {
    const result = resolveTtsConfig({
      messages: { tts: { timeoutMs: 10_000 } },
    });
    expect(result.timeoutMs).toBe(10_000);
  });

  it("respects custom mode", () => {
    const result = resolveTtsConfig({ messages: { tts: { mode: "all" } } });
    expect(result.mode).toBe("all");
  });

  it("collects provider-specific configs from providers map", () => {
    const result = resolveTtsConfig({
      messages: {
        tts: {
          providers: {
            elevenlabs: { apiKey: "el-key" },
            deepgram: { apiKey: "dg-key" },
          },
        },
      },
    });
    expect(result.providerConfigs["elevenlabs"]).toEqual({ apiKey: "el-key" });
    expect(result.providerConfigs["deepgram"]).toEqual({ apiKey: "dg-key" });
  });

  it("attaches summaryModel when set", () => {
    const result = resolveTtsConfig({
      messages: { tts: { summaryModel: "gpt-5.4" } },
    });
    expect(result.summaryModel).toBe("gpt-5.4");
  });

  it("returns undefined summaryModel when not set", () => {
    const result = resolveTtsConfig({});
    expect(result.summaryModel).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// _test.resolveModelOverridePolicy — pure policy transformation
// ---------------------------------------------------------------------------

describe("resolveModelOverridePolicy", () => {
  const { resolveModelOverridePolicy } = _test;

  it("returns all-false policy when enabled:false", () => {
    const policy = resolveModelOverridePolicy({ enabled: false });
    expect(policy.enabled).toBe(false);
    expect(policy.allowText).toBe(false);
    expect(policy.allowProvider).toBe(false);
    expect(policy.allowVoice).toBe(false);
    expect(policy.allowModelId).toBe(false);
    expect(policy.allowVoiceSettings).toBe(false);
    expect(policy.allowNormalization).toBe(false);
    expect(policy.allowSeed).toBe(false);
  });

  it("returns permissive defaults when overrides is undefined", () => {
    const policy = resolveModelOverridePolicy(undefined);
    expect(policy.enabled).toBe(true);
    expect(policy.allowText).toBe(true);
    // allowProvider defaults to false per implementation
    expect(policy.allowProvider).toBe(false);
    expect(policy.allowVoice).toBe(true);
    expect(policy.allowModelId).toBe(true);
    expect(policy.allowVoiceSettings).toBe(true);
    expect(policy.allowNormalization).toBe(true);
    expect(policy.allowSeed).toBe(true);
  });

  it("returns permissive defaults when enabled is not set", () => {
    const policy = resolveModelOverridePolicy({});
    expect(policy.enabled).toBe(true);
    expect(policy.allowText).toBe(true);
  });

  it("respects partial overrides", () => {
    const policy = resolveModelOverridePolicy({
      enabled: true,
      allowText: false,
      allowProvider: true,
      allowVoice: false,
    });
    expect(policy.allowText).toBe(false);
    expect(policy.allowProvider).toBe(true);
    expect(policy.allowVoice).toBe(false);
    // unset fields keep their defaults
    expect(policy.allowModelId).toBe(true);
  });

  it("enabled:true with explicit all-false overrides sets all to false", () => {
    const policy = resolveModelOverridePolicy({
      enabled: true,
      allowText: false,
      allowProvider: false,
      allowVoice: false,
      allowModelId: false,
      allowVoiceSettings: false,
      allowNormalization: false,
      allowSeed: false,
    });
    expect(policy.enabled).toBe(true);
    expect(policy.allowText).toBe(false);
    expect(policy.allowVoice).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Prefs — auto mode  (file I/O with isolated temp dir)
// ---------------------------------------------------------------------------

describe("TTS prefs — auto mode", () => {
  let prefsPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ prefsPath, cleanup } = makeTempPrefs());
  });

  afterEach(() => {
    cleanup();
  });

  it("isTtsEnabled returns false by default (auto=off)", () => {
    const config = resolveTtsConfig({});
    expect(isTtsEnabled(config, prefsPath)).toBe(false);
  });

  it("isTtsEnabled returns true when config has enabled:true", () => {
    const config = resolveTtsConfig({ messages: { tts: { enabled: true } } });
    expect(isTtsEnabled(config, prefsPath)).toBe(true);
  });

  it("setTtsAutoMode persists and resolveTtsAutoMode reads it back", () => {
    const config = resolveTtsConfig({});
    setTtsAutoMode(prefsPath, "tagged");
    const mode = resolveTtsAutoMode({ config, prefsPath });
    expect(mode).toBe("tagged");
  });

  it("prefs-level auto overrides config-level auto", () => {
    // config says "always", prefs says "tagged"
    const config = resolveTtsConfig({ messages: { tts: { auto: "always" } } });
    setTtsAutoMode(prefsPath, "tagged");
    expect(resolveTtsAutoMode({ config, prefsPath })).toBe("tagged");
  });

  it("sessionAuto takes priority over both config and prefs", () => {
    const config = resolveTtsConfig({});
    setTtsAutoMode(prefsPath, "always");
    const mode = resolveTtsAutoMode({ config, prefsPath, sessionAuto: "off" });
    expect(mode).toBe("off");
  });

  it("setTtsEnabled(true) stores auto=always", () => {
    const config = resolveTtsConfig({});
    setTtsEnabled(prefsPath, true);
    expect(isTtsEnabled(config, prefsPath)).toBe(true);
    expect(resolveTtsAutoMode({ config, prefsPath })).toBe("always");
  });

  it("setTtsEnabled(false) stores auto=off", () => {
    const config = resolveTtsConfig({ messages: { tts: { enabled: true } } });
    setTtsEnabled(prefsPath, false);
    expect(isTtsEnabled(config, prefsPath)).toBe(false);
    expect(resolveTtsAutoMode({ config, prefsPath })).toBe("off");
  });

  it("setTtsAutoMode creates the prefs directory if missing", () => {
    // Use a sub-directory that does not yet exist under the temp dir.
    const nestedDir = path.join(prefsPath, "..", "sub");
    const nested = path.join(nestedDir, "tts.json");
    try {
      setTtsAutoMode(nested, "tagged");
      const config = resolveTtsConfig({});
      expect(resolveTtsAutoMode({ config, prefsPath: nested })).toBe("tagged");
    } finally {
      rmSync(nestedDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Prefs — max length
// ---------------------------------------------------------------------------

describe("TTS prefs — max length", () => {
  let prefsPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ prefsPath, cleanup } = makeTempPrefs());
  });

  afterEach(() => {
    cleanup();
  });

  it("getTtsMaxLength returns 1500 by default", () => {
    expect(getTtsMaxLength(prefsPath)).toBe(1500);
  });

  it("setTtsMaxLength persists and getTtsMaxLength reads it back", () => {
    setTtsMaxLength(prefsPath, 800);
    expect(getTtsMaxLength(prefsPath)).toBe(800);
  });

  it("setTtsMaxLength overwrites a previous value", () => {
    setTtsMaxLength(prefsPath, 800);
    setTtsMaxLength(prefsPath, 1200);
    expect(getTtsMaxLength(prefsPath)).toBe(1200);
  });
});

// ---------------------------------------------------------------------------
// Prefs — summarization
// ---------------------------------------------------------------------------

describe("TTS prefs — summarization", () => {
  let prefsPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ prefsPath, cleanup } = makeTempPrefs());
  });

  afterEach(() => {
    cleanup();
  });

  it("isSummarizationEnabled returns true by default", () => {
    expect(isSummarizationEnabled(prefsPath)).toBe(true);
  });

  it("setSummarizationEnabled(false) persists", () => {
    setSummarizationEnabled(prefsPath, false);
    expect(isSummarizationEnabled(prefsPath)).toBe(false);
  });

  it("setSummarizationEnabled(true) re-enables after disable", () => {
    setSummarizationEnabled(prefsPath, false);
    setSummarizationEnabled(prefsPath, true);
    expect(isSummarizationEnabled(prefsPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveTtsPrefsPath — path resolution
// ---------------------------------------------------------------------------

describe("resolveTtsPrefsPath", () => {
  const ENV_KEY = "OPENCLAW_TTS_PREFS";

  beforeEach(() => {
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("returns a non-empty string for a config with no prefsPath set", () => {
    const config = resolveTtsConfig({});
    const resolved = resolveTtsPrefsPath(config);
    expect(typeof resolved).toBe("string");
    expect(resolved.length).toBeGreaterThan(0);
  });

  it("uses prefsPath from config when explicitly set", () => {
    const config = resolveTtsConfig({
      messages: { tts: { prefsPath: "/custom/dir/tts.json" } },
    });
    const resolved = resolveTtsPrefsPath(config);
    // resolveUserPath may expand ~ but the tail must match
    expect(resolved).toContain("custom/dir/tts.json");
  });
});
