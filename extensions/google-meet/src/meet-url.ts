import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const MEET_CODE_PATTERN = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i;

/**
 * Meeting code from a meet.google.com path. Meet links are `/<code>`, and Meet itself
 * redirects joined calls to `/meet/<code>?hl=en`; both name the same meeting.
 */
export function readMeetMeetingCode(pathname: string): string | undefined {
  const segments = pathname.split("/").filter(Boolean);
  const candidate = segments[0]?.toLowerCase() === "meet" ? segments[1] : segments[0];
  return candidate && MEET_CODE_PATTERN.test(candidate) ? candidate.toLowerCase() : undefined;
}

export function normalizeMeetUrl(input: unknown): string {
  const raw = normalizeOptionalString(input);
  if (!raw) {
    throw new Error("url required");
  }
  const url = URL.parse(raw);
  if (!url) {
    throw new Error("url must be a valid Google Meet URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "meet.google.com" ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new Error("url must be an explicit https://meet.google.com/... URL");
  }
  const code = readMeetMeetingCode(url.pathname);
  if (!code) {
    throw new Error("url must include a Google Meet meeting code");
  }
  // Canonical form keeps the code as the first segment so tab reuse and the Meet API agree.
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0]?.toLowerCase() === "meet") {
    url.pathname = `/${segments.slice(1).join("/")}`;
  }
  return url.toString();
}
