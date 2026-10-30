// Elevenlabs tests cover config compat plugin behavior.
import fs from "node:fs";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  migrateElevenLabsLegacyTalkConfig,
  resolveElevenLabsApiKeyWithProfileFallback,
} from "./config-compat.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("elevenlabs config compat", () => {
  it("moves legacy talk fields into talk.providers.elevenlabs", () => {
    const result = migrateElevenLabsLegacyTalkConfig({
      talk: {
        providers: { elevenlabs: { voiceId: "existing-voice" } },
        voiceId: "voice-123",
        modelId: "eleven_v3",
        outputFormat: "pcm_44100",
        apiKey: "secret-key", // pragma: allowlist secret
      },
    });

    expect(result.changes).toEqual([
      "Moved talk legacy fields (voiceId, modelId, outputFormat, apiKey) → talk.providers.elevenlabs (filled missing provider fields only).",
    ]);
    expect(result.config).toEqual({
      talk: {
        providers: {
          elevenlabs: {
            voiceId: "existing-voice",
            modelId: "eleven_v3",
            outputFormat: "pcm_44100",
            apiKey: "secret-key", // pragma: allowlist secret
          },
        },
      },
    });
    expect(migrateElevenLabsLegacyTalkConfig(result.config)).toEqual({
      config: result.config,
      changes: [],
    });
  });

  it("preserves ambiguous legacy Talk fields for actionable doctor guidance", () => {
    const config = {
      talk: {
        providers: { acme: { modelId: "acme-model" }, other: { modelId: "other-model" } },
        voiceId: "legacy-voice",
      },
    };
    expect(migrateElevenLabsLegacyTalkConfig(config)).toEqual({
      config,
      changes: [expect.stringContaining("multiple providers")],
    });
  });

  it("reads ELEVENLABS_API_KEY from profile when env is missing", () => {
    vi.stubEnv("ELEVENLABS_API_KEY", undefined);
    vi.spyOn(fs, "existsSync").mockImplementation((candidate) =>
      String(candidate).endsWith(".profile"),
    );
    const readFileSync = vi
      .spyOn(fs, "readFileSync")
      .mockReturnValue("export ELEVENLABS_API_KEY=profile-key\n");
    vi.spyOn(os, "homedir").mockReturnValue("/tmp/home");

    const value = resolveElevenLabsApiKeyWithProfileFallback();

    expect(value).toBe("profile-key");
    expect(readFileSync).toHaveBeenCalledOnce();
  });

  it("prefers ELEVENLABS_API_KEY env over profile", () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "env-key");
    const existsSync = vi.spyOn(fs, "existsSync").mockImplementation(() => {
      throw new Error("profile should not be read when env key exists");
    });
    const readFileSync = vi.spyOn(fs, "readFileSync").mockReturnValue("");

    const value = resolveElevenLabsApiKeyWithProfileFallback();

    expect(value).toBe("env-key");
    expect(existsSync).not.toHaveBeenCalled();
    expect(readFileSync).not.toHaveBeenCalled();
  });
});
