import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, expect, it, vi } from "vitest";
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

afterEach(() => vi.unstubAllEnvs());

it.each([
  ["custom-stt", "custom-stt"],
  ["google", "openai"],
])("resolves transcription fallback for %s", (provider, transcriptionProvider) => {
  const { realtime } = resolveConfig({ realtime: { provider } });
  expect(realtime).toMatchObject({ provider, transcriptionProvider });
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
it("keeps sparse audio config compatible", () => {
  expect(resolveConfig({}).chrome).toMatchObject({
    audioBackend: "auto",
    audioInputCommandOverride: undefined,
    audioOutputCommandOverride: undefined,
  });
});

it.each([
  ["chrome", ["joinTimeoutMs", "waitForInCallMs", "bargeInCooldownMs"]],
  ["voiceCall", ["requestTimeoutMs", "dtmfDelayMs", "postDtmfSpeechDelayMs"]],
] as const)("caps %s timers before runtime polling", (section, fields) => {
  const values = (value: number) => Object.fromEntries(fields.map((field) => [field, value]));
  expect(resolveConfig({ [section]: values(Number.MAX_VALUE) })[section]).toMatchObject(
    values(MAX_TIMER_TIMEOUT_MS),
  );
});
it.each([
  [{}, 60_000],
  [{ chrome: { joinTimeoutMs: 120_000 }, voiceCall: { requestTimeoutMs: 30_000 } }, 150_000],
  [{ chrome: { joinTimeoutMs: Number.MAX_VALUE } }, MAX_TIMER_TIMEOUT_MS],
  [{ voiceCall: { requestTimeoutMs: Number.MAX_VALUE } }, MAX_TIMER_TIMEOUT_MS],
])("adds bounded operation grace: %j", (config, expected) => {
  expect(resolveGoogleMeetGatewayOperationTimeoutMs(resolveConfig(config))).toBe(expected);
});
