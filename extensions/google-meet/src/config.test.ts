import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveGoogleMeetConfig as resolveConfig,
  resolveGoogleMeetGatewayOperationTimeoutMs,
} from "./config.js";

function resolveGoogleMeetConfigFromTestEnv(env: Record<string, string>) {
  for (const suffix of [
    "CLIENT_ID",
    "CLIENT_SECRET",
    "REFRESH_TOKEN",
    "ACCESS_TOKEN",
    "ACCESS_TOKEN_EXPIRES_AT",
    "DEFAULT_MEETING",
    "PREVIEW_ACK",
  ]) {
    vi.stubEnv(`OPENCLAW_GOOGLE_MEET_${suffix}`, undefined);
    vi.stubEnv(`GOOGLE_MEET_${suffix}`, undefined);
  }
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  return resolveConfig({});
}

describe("google meet config", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps realtime.provider as the transcription compatibility fallback", () => {
    expect(resolveConfig({ realtime: { provider: "custom-stt" } }).realtime).toMatchObject({
      provider: "custom-stt",
      transcriptionProvider: "custom-stt",
    });
    expect(resolveConfig({ realtime: { provider: "google" } }).realtime).toMatchObject({
      provider: "google",
      transcriptionProvider: "openai",
    });
  });

  it("preserves an empty realtime intro message for silent joins", () => {
    expect(resolveConfig({ realtime: { introMessage: "" } }).realtime.introMessage).toBe("");
  });

  it.each([
    [{}, "pcm16-24khz"],
    [{ audioInputCommand: ["capture"] }, "g711-ulaw-8khz"],
    [{ audioInputCommand: [] }, "pcm16-24khz"],
    [{ audioInputCommand: ["capture"], audioFormat: "pcm" }, "pcm16-24khz"],
    [{ audioFormat: "mu-law" }, "g711-ulaw-8khz"],
  ])("preserves Google audio format defaults and aliases: %j", (chrome, expected) => {
    expect(resolveConfig({ chrome }).chrome.audioFormat).toBe(expected);
  });

  it("uses env fallbacks for OAuth, preview, and default meeting values", () => {
    const config = resolveGoogleMeetConfigFromTestEnv({
      OPENCLAW_GOOGLE_MEET_CLIENT_ID: "client-id",
      GOOGLE_MEET_CLIENT_SECRET: "client-secret",
      OPENCLAW_GOOGLE_MEET_REFRESH_TOKEN: "refresh-token",
      GOOGLE_MEET_ACCESS_TOKEN: "access-token",
      OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT: "123456",
      GOOGLE_MEET_DEFAULT_MEETING: "https://meet.google.com/abc-defg-hij",
      OPENCLAW_GOOGLE_MEET_PREVIEW_ACK: "true",
    });
    expect(config.defaults).toEqual({ meeting: "https://meet.google.com/abc-defg-hij" });
    expect(config.preview).toEqual({ enrollmentAcknowledged: true });
    expect(config.oauth).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
      accessToken: "access-token",
      expiresAt: 123456,
    });
  });

  it("ignores non-decimal env numeric fallbacks", () => {
    const config = resolveGoogleMeetConfigFromTestEnv({
      OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN: "access-token",
      OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT: "0x10",
    });

    expect(config.oauth).toEqual({ accessToken: "access-token" });
  });
});

describe("google meet gateway operation timeout", () => {
  it("keeps sparse and legacy audio config compatible", () => {
    expect(resolveConfig({}).chrome).toMatchObject({
      audioBackend: "auto",
      audioInputCommandOverride: undefined,
      audioOutputCommandOverride: undefined,
    });
    const legacy = resolveConfig({ chrome: { audioBackend: "blackhole-2ch" } });
    expect(legacy.chrome.audioBackend).toBe("blackhole-2ch");
    expect(legacy.chrome.audioInputCommand).toContain("BlackHole 2ch");
    expect(legacy.chrome.audioOutputCommand).toContain("BlackHole 2ch");
  });

  it("builds PipeWire-Pulse commands and retains explicit overrides", () => {
    const linux = resolveConfig({ chrome: { audioBackend: "pipewire-pulse" } });
    expect(linux.chrome.audioInputCommand).toContain("parec");
    expect(linux.chrome.audioOutputCommand).toContain("pacat");

    const custom = resolveConfig({
      chrome: { audioInputCommand: ["capture"], audioOutputCommand: ["play"] },
    });
    expect(custom.chrome).toMatchObject({
      audioInputCommand: ["capture"],
      audioOutputCommand: ["play"],
      audioInputCommandOverride: ["capture"],
      audioOutputCommandOverride: ["play"],
    });
  });

  it("caps timer config fields before runtime polling uses them", () => {
    const config = resolveConfig({
      chrome: {
        joinTimeoutMs: Number.MAX_VALUE,
        waitForInCallMs: Number.MAX_VALUE,
        bargeInCooldownMs: Number.MAX_VALUE,
      },
      voiceCall: {
        requestTimeoutMs: Number.MAX_VALUE,
        dtmfDelayMs: Number.MAX_VALUE,
        postDtmfSpeechDelayMs: Number.MAX_VALUE,
      },
    });

    expect(config.chrome.joinTimeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(config.chrome.waitForInCallMs).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(config.chrome.bargeInCooldownMs).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(config.voiceCall.requestTimeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(config.voiceCall.dtmfDelayMs).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(config.voiceCall.postDtmfSpeechDelayMs).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("adds operation grace to normal transport timeouts", () => {
    expect(operationTimeout({})).toBe(60_000);
    expect(
      operationTimeout({
        chrome: { joinTimeoutMs: 120_000 },
        voiceCall: { requestTimeoutMs: 30_000 },
      }),
    ).toBe(150_000);
  });

  it("caps overflowed transport timeout grace", () => {
    expect(operationTimeout({ chrome: { joinTimeoutMs: Number.MAX_VALUE } })).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
    expect(operationTimeout({ voiceCall: { requestTimeoutMs: Number.MAX_VALUE } })).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
  });
});

function operationTimeout(config: unknown) {
  return resolveGoogleMeetGatewayOperationTimeoutMs(resolveConfig(config));
}
