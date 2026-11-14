import type { MeetingBrowserCandidateTab } from "openclaw/plugin-sdk/meeting-runtime";
import { readMeetMeetingCode } from "../meet-url.js";

// Meet automation scripts match English UI labels. Pin the page language while
// preserving authuser and every other caller-supplied query parameter.
export function forceMeetEnglishUi(url: string): string {
  const parsed = URL.parse(url);
  if (!parsed) {
    return url;
  }
  parsed.searchParams.set("hl", "en");
  return parsed.toString();
}

export function normalizeMeetUrlForReuse(url: string | undefined): string | undefined {
  const parsed = URL.parse(url ?? "");
  if (parsed?.protocol !== "https:" || parsed.hostname.toLowerCase() !== "meet.google.com") {
    return undefined;
  }
  // A joined tab lands on Meet's own `/meet/<code>` form; it is the same call as `/<code>`.
  const segments = parsed.pathname.split("/").filter(Boolean);
  const codeOnly = segments.length === (segments[0]?.toLowerCase() === "meet" ? 2 : 1);
  const code = codeOnly ? readMeetMeetingCode(parsed.pathname) : undefined;
  if (!code) {
    return undefined;
  }
  return `https://meet.google.com/${code}`;
}

export function isSameMeetUrlForReuse(a: string | undefined, b: string | undefined): boolean {
  const normalizedA = normalizeMeetUrlForReuse(a);
  const normalizedB = normalizeMeetUrlForReuse(b);
  return Boolean(normalizedA && normalizedB && normalizedA === normalizedB);
}

export function isEnglishMeetTab(url: string | undefined): boolean {
  const parsed = URL.parse(url ?? "");
  return (
    parsed?.protocol === "https:" &&
    parsed.hostname.toLowerCase() === "meet.google.com" &&
    parsed.searchParams.get("hl")?.toLowerCase() === "en"
  );
}

export function readMeetAuthUser(url: string | undefined): string | undefined {
  return URL.parse(url ?? "")?.searchParams.get("authuser") ?? undefined;
}

export function isRecoverableMeetTab(tab: MeetingBrowserCandidateTab, url?: string): boolean {
  if (url) {
    return isSameMeetUrlForReuse(tab.url, url);
  }
  if (normalizeMeetUrlForReuse(tab.url)) {
    return true;
  }
  const tabUrl = tab.url ?? "";
  return (
    tabUrl.startsWith("https://accounts.google.com/") &&
    /sign in|google accounts|meet/i.test(tab.title ?? "")
  );
}
