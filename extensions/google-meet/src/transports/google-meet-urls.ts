import type { MeetingBrowserCandidateTab } from "openclaw/plugin-sdk/meeting-runtime";

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
  const match = parsed.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/)?$/i);
  if (!match?.[1]) {
    return undefined;
  }
  return `https://meet.google.com/${match[1].toLowerCase()}`;
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
