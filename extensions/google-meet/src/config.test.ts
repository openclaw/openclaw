import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGoogleMeetConfig, resolveGoogleMeetGatewayOperationTimeoutMs } from "./config.js";

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
  return resolveGoogleMeetConfig({});
}

describe("google meet config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps realtime.provider as the transcription compatibility fallback", () => {
    const custom = resolveGoogleMeetConfig({ realtime: { provider: "custom-stt" } });
    expect(custom.realtime.provider).toBe("custom-stt");
    expect(custom.realtime.transcriptionProvider).toBe("custom-stt");

    const google = resolveGoogleMeetConfig({ realtime: { provider: "google" } });
    expect(google.realtime.provider).toBe("google");
    expect(google.realtime.transcriptionProvider).toBe("openai");
  });

  it("preserves an empty realtime intro message for silent joins", () => {
    expect(resolveGoogleMeetConfig({ realtime: { introMessage: "" } }).realtime.introMessage).toBe(
      "",
    );
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
    const sparse = resolveGoogleMeetConfig({});
    expect(sparse.chrome.audioBackend).toBe("auto");
    expect(sparse.chrome.audioInputCommandOverride).toBeUndefined();
    expect(sparse.chrome.audioOutputCommandOverride).toBeUndefined();

    const legacy = resolveGoogleMeetConfig({
      chrome: { audioBackend: "blackhole-2ch" },
    });
    expect(legacy.chrome.audioBackend).toBe("blackhole-2ch");
    expect(legacy.chrome.audioInputCommand).toContain("BlackHole 2ch");
    expect(legacy.chrome.audioOutputCommand).toContain("BlackHole 2ch");
  });

  it("builds PipeWire-Pulse commands and retains explicit overrides", () => {
    const linux = resolveGoogleMeetConfig({
      chrome: { audioBackend: "pipewire-pulse" },
    });
    expect(linux.chrome.audioInputCommand).toContain("parec");
    expect(linux.chrome.audioOutputCommand).toContain("pacat");

    const custom = resolveGoogleMeetConfig({
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
    const config = resolveGoogleMeetConfig({
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
  return resolveGoogleMeetGatewayOperationTimeoutMs(resolveGoogleMeetConfig(config));
}
