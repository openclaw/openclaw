// Google Meet tests cover config plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGoogleMeetConfig, resolveGoogleMeetGatewayOperationTimeoutMs } from "./config.js";

const GOOGLE_MEET_ENV_KEYS = [
  "OPENCLAW_GOOGLE_MEET_CLIENT_ID",
  "GOOGLE_MEET_CLIENT_ID",
  "OPENCLAW_GOOGLE_MEET_CLIENT_SECRET",
  "GOOGLE_MEET_CLIENT_SECRET",
  "OPENCLAW_GOOGLE_MEET_REFRESH_TOKEN",
  "GOOGLE_MEET_REFRESH_TOKEN",
  "OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN",
  "GOOGLE_MEET_ACCESS_TOKEN",
  "OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT",
  "GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT",
  "OPENCLAW_GOOGLE_MEET_DEFAULT_MEETING",
  "GOOGLE_MEET_DEFAULT_MEETING",
  "OPENCLAW_GOOGLE_MEET_PREVIEW_ACK",
  "GOOGLE_MEET_PREVIEW_ACK",
] as const;

function resolveGoogleMeetConfigFromTestEnv(env: Record<string, string>) {
  for (const key of GOOGLE_MEET_ENV_KEYS) {
    vi.stubEnv(key, undefined);
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
    const custom = resolveGoogleMeetConfig({
      realtime: {
        provider: "custom-stt",
      },
    });
    expect(custom.realtime.provider).toBe("custom-stt");
    expect(custom.realtime.transcriptionProvider).toBe("custom-stt");

    const google = resolveGoogleMeetConfig({
      realtime: {
        provider: "google",
      },
    });
    expect(google.realtime.provider).toBe("google");
    expect(google.realtime.transcriptionProvider).toBe("openai");
  });

  it("preserves an empty realtime intro message for silent joins", () => {
    expect(
      resolveGoogleMeetConfig({
        realtime: {
          introMessage: "",
        },
      }).realtime.introMessage,
    ).toBe("");
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

  it.each(["0x10"])("ignores non-decimal env numeric fallbacks: %s", (expiresAt) => {
    const config = resolveGoogleMeetConfigFromTestEnv({
      OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN: "access-token",
      OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT: expiresAt,
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
    expect(resolveGoogleMeetGatewayOperationTimeoutMs(resolveGoogleMeetConfig({}))).toBe(60_000);
    expect(
      resolveGoogleMeetGatewayOperationTimeoutMs(
        resolveGoogleMeetConfig({
          chrome: { joinTimeoutMs: 120_000 },
          voiceCall: { requestTimeoutMs: 30_000 },
        }),
      ),
    ).toBe(150_000);
  });

  it("caps overflowed transport timeout grace", () => {
    expect(
      resolveGoogleMeetGatewayOperationTimeoutMs(
        resolveGoogleMeetConfig({
          chrome: { joinTimeoutMs: Number.MAX_VALUE },
        }),
      ),
    ).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(
      resolveGoogleMeetGatewayOperationTimeoutMs(
        resolveGoogleMeetConfig({
          voiceCall: { requestTimeoutMs: Number.MAX_VALUE },
        }),
      ),
    ).toBe(MAX_TIMER_TIMEOUT_MS);
  });
});
