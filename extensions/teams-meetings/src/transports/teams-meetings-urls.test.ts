import { describe, expect, it } from "vitest";
import {
  isSameTeamsMeetingUrl,
  normalizeTeamsMeetingUrl,
  normalizeTeamsMeetingUrlForReuse,
} from "./teams-meetings-urls.js";

const WORK_URL =
  "https://teams.microsoft.com/l/meetup-join/19%3ameeting_NzQ1ZDBjYzItZDAxNS00N2YxLTg4Y2EtYjQ1N2I4NDg2Njli%40thread.v2/0?context=%7b%22Tid%22%3a%22tenant%22%7d";
const CONSUMER_COORDINATES = Buffer.from(
  JSON.stringify({ meetingCode: "9326458712345", passcode: "abc" }),
).toString("base64");

describe("Microsoft Teams meeting URL normalization", () => {
  it.each([
    [WORK_URL, "teams-work:19:meeting_NzQ1ZDBjYzItZDAxNS00N2YxLTg4Y2EtYjQ1N2I4NDg2Njli@thread.v2"],
    [
      "https://teams.microsoft.com/meet/1234567890123?p=Synthetic-runtime-token",
      "teams-work:meet:1234567890123:p:Synthetic-runtime-token",
    ],
    [
      "https://teams.microsoft.com/dl/launcher/launcher.html?url=%2F_%23%2Fmeet%2F1234567890123%3Fp%3DSynthetic-runtime-token",
      "teams-work:meet:1234567890123:p:Synthetic-runtime-token",
    ],
    ["https://teams.live.com/meet/9326458712345?p=abc", "teams-consumer:9326458712345:p:abc"],
    [
      "https://teams.live.com/dl/launcher/launcher.html?url=%2F_%23%2Fmeet%2F9326458712345%3Fp%3Dabc",
      "teams-consumer:9326458712345:p:abc",
    ],
    [
      `https://teams.live.com/light-meetings/launch?coords=${encodeURIComponent(CONSUMER_COORDINATES)}`,
      "teams-consumer:9326458712345:p:abc",
    ],
  ])("extracts a stable identity from %s", (url, expected) => {
    expect(normalizeTeamsMeetingUrlForReuse(url)).toBe(expected);
  });

  it.each([
    [
      "https://teams.live.com/meet/abc-123?p=one",
      "https://teams.live.com/meet/ABC-123?p=one&invite=x",
      true,
    ],
    [
      "https://teams.live.com/meet/abc-123?p=one",
      "https://teams.live.com/meet/abc-123?p=two",
      false,
    ],
    ["https://teams.live.com/meet/abc-123?p=one", "https://teams.live.com/meet/abc-123", false],
  ])("compares consumer meeting passcode identity: %s / %s", (left, right, expected) => {
    expect(isSameTeamsMeetingUrl(left, right)).toBe(expected);
  });

  it.each([
    "https://teams.microsoft.com/v2/",
    "https://teams.microsoft.com/l/channel/19%3Achannel%40thread.tacv2",
    "https://teams.live.com/dl/launcher/launcher.html?url=https%3A%2F%2Fevil.example%2Fmeet%2Fabc",
    "https://teams.live.com/dl/launcher/launcher.html?url=%2F_%23%2Fmeet%2Fabc%2Fextra",
    "https://teams.live.com/light-meetings/launch?coords=not-json",
    "http://teams.live.com/meet/abc",
    "https://example.com/l/meetup-join/19%3ameeting_x%40thread.v2/0",
  ])("rejects non-meeting Teams input: %s", (url) => {
    expect(normalizeTeamsMeetingUrlForReuse(url)).toBeUndefined();
    expect(() => normalizeTeamsMeetingUrl(url)).toThrow("Microsoft Teams meeting URL must use");
  });

  it("preserves the join query while removing fragments", () => {
    const normalized = normalizeTeamsMeetingUrl(`${WORK_URL}#ignored`);
    expect(normalized).toContain("context=");
    expect(normalized).not.toContain("#ignored");
  });

  it("resolves a work short-link and its server launcher redirect to the same key", () => {
    const direct = "https://teams.microsoft.com/meet/1234567890123?p=Synthetic-runtime-token";
    const redirected =
      "https://teams.microsoft.com/dl/launcher/launcher.html?url=%2F_%23%2Fmeet%2F1234567890123%3Fp%3DSynthetic-runtime-token";
    expect(isSameTeamsMeetingUrl(direct, redirected)).toBe(true);
  });

  it("does not treat a different opaque passcode as the same work short-link meeting", () => {
    const direct = "https://teams.microsoft.com/meet/1234567890123?p=Synthetic-runtime-token";
    const other = "https://teams.microsoft.com/meet/1234567890123?p=Different-runtime-token";
    expect(isSameTeamsMeetingUrl(direct, other)).toBe(false);
  });

  it.each([
    "https://teams.microsoft.com/meet/1234567890123",
    "https://teams.microsoft.com/meet/1234567890123?p=",
    "https://teams.microsoft.com/meet/1234567890123?p=one&p=two",
    "https://teams.microsoft.com/dl/launcher/launcher.html?url=https%3A%2F%2Fevil.example%2F_%23%2Fmeet%2F1234567890123%3Fp%3Dx",
    "https://teams.microsoft.com/dl/launcher/launcher.html?url=%2F_%23%2Fmeet%2Fabc%3Fp%3Dx",
  ])("rejects a malformed or missing-passcode work short-link: %s", (url) => {
    expect(normalizeTeamsMeetingUrlForReuse(url)).toBeUndefined();
  });
});
