import type { MeetingBrowserCandidateTab } from "openclaw/plugin-sdk/meeting-runtime";

type TeamsMeetingIdentity = { kind: "work"; key: string } | { kind: "consumer"; key: string };

function parseTeamsMeetingIdentity(url: string | undefined): TeamsMeetingIdentity | undefined {
  // Keep this function self-contained: the browser runs its serialized source.
  // URL parsing otherwise silently drops controls; reject rather than repair.
  if (
    !url ||
    Array.from(url).some(
      (character) =>
        character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127 || character === "\\",
    )
  ) {
    return undefined;
  }
  try {
    // Reject authority/path spellings that URL would silently repair.
    const raw = url.match(
      /^https:\/\/(teams\.microsoft\.com|teams\.live\.com)(?::443)?(\/[^?#]*)(?:[?#]|$)/i,
    );
    if (!raw) {
      return undefined;
    }
    const parsed = new URL(url);
    if (raw[2] !== parsed.pathname) {
      return undefined;
    }
    if (parsed.protocol !== "https:" || parsed.port || parsed.username || parsed.password) {
      return undefined;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "teams.microsoft.com") {
      const shortMeeting = parsed.pathname.match(/^\/meet\/([0-9]+)\/?$/);
      if (shortMeeting) {
        // Microsoft calls p HashedPasscode, not the displayed meeting passcode.
        // Treat it as opaque: no decoding beyond URL query encoding, no assumed
        // alphabet/length, and no reconstruction of a legacy thread identifier.
        const passcodes = parsed.searchParams.getAll("p");
        const passcode = passcodes[0];
        const rawPasscode = parsed.search
          .slice(1)
          .split("&")
          .find((entry) => new URLSearchParams(entry).has("p"))
          ?.split("=")
          .slice(1)
          .join("=");
        if (
          passcodes.length !== 1 ||
          !passcode ||
          /[\s\ufffd]/u.test(passcode) ||
          Array.from(passcode).some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ) ||
          /%(?![0-9a-f]{2})/i.test(rawPasscode ?? "")
        ) {
          return undefined;
        }
        return { kind: "work", key: `meet:${shortMeeting[1]}:p:${encodeURIComponent(passcode)}` };
      }
      const match = parsed.pathname.match(/^\/l\/meetup-join\/([^/]+)(?:\/0)?\/?$/i);
      if (!match?.[1]) {
        return undefined;
      }
      const threadId = decodeURIComponent(match[1]);
      if (!/^19:[^/]+@thread\.(?:v2|tacv2)$/i.test(threadId)) {
        return undefined;
      }
      return { kind: "work", key: threadId };
    }
    if (hostname === "teams.live.com") {
      const launcherTarget =
        parsed.pathname.toLowerCase() === "/dl/launcher/launcher.html"
          ? parsed.searchParams.get("url")
          : undefined;
      const launcherMatch = launcherTarget?.match(/^\/_#\/meet\/([^/?#]+)(?:\?(.+))?$/i);
      let lightMeeting: { meetingCode?: unknown; passcode?: unknown } | undefined;
      if (parsed.pathname.toLowerCase() === "/light-meetings/launch") {
        try {
          const coordinates = parsed.searchParams.get("coords");
          const decoded =
            coordinates && coordinates.length <= 16_384
              ? JSON.parse(
                  decodeURIComponent(
                    Array.from(
                      atob(coordinates),
                      (byte) => "%" + byte.charCodeAt(0).toString(16).padStart(2, "0"),
                    ).join(""),
                  ),
                )
              : undefined;
          if (decoded && typeof decoded === "object") {
            lightMeeting = decoded as { meetingCode?: unknown; passcode?: unknown };
          }
        } catch {
          return undefined;
        }
      }
      const match =
        parsed.pathname.match(/^\/meet\/([^/]+)\/?$/i) ??
        launcherMatch ??
        (typeof lightMeeting?.meetingCode === "string"
          ? ([undefined, lightMeeting.meetingCode] as const)
          : undefined);
      if (!match?.[1]) {
        return undefined;
      }
      const meetCode = decodeURIComponent(match[1]);
      if (!/^[a-z0-9_-]+$/i.test(meetCode)) {
        return undefined;
      }
      const passcode = launcherMatch
        ? new URLSearchParams(launcherMatch[2] ?? "").get("p")
        : typeof lightMeeting?.passcode === "string"
          ? lightMeeting.passcode
          : parsed.searchParams.get("p");
      return {
        kind: "consumer",
        key: `${meetCode.toLowerCase()}:p:${encodeURIComponent(passcode ?? "")}`,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function teamsMeetingIdentityFunctionSource(meetingUrl?: string): string {
  const origin = meetingUrl ? new URL(meetingUrl).origin : undefined;
  return `const meetingIdentity = (rawUrl) => {
    const identity = (${parseTeamsMeetingIdentity.toString()})(rawUrl);
    if (identity) return "teams-" + identity.kind + ":" + identity.key;
    if (${JSON.stringify(origin)} !== undefined) {
      // Only the known same-origin SPA route may retain an owned in-call marker.
      // An invalid invitation must not become an anonymous route into that call.
      try {
        const page = new URL(rawUrl);
        if (page.origin === ${JSON.stringify(origin)} && !page.username && !page.password &&
            /^https:\\/\\/(?:teams\\.microsoft\\.com|teams\\.live\\.com)(?::443)?\\/v2\\/?(?:[?#]|$)/i.test(rawUrl) &&
            /^\\/v2\\/?$/.test(page.pathname) && !/[\\u0000-\\u0020\\u007f\\\\]/.test(rawUrl)) return undefined;
      } catch {}
      return "teams-unrecognized";
    }
    return undefined;
  };`;
}

export function normalizeTeamsMeetingUrl(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("Microsoft Teams meeting URL is required");
  }
  const value = input.trim();
  if (!parseTeamsMeetingIdentity(value)) {
    throw new Error(
      "Microsoft Teams meeting URL must use https://teams.microsoft.com/meet/<id>?p=<HashedPasscode>, https://teams.microsoft.com/l/meetup-join/... or https://teams.live.com/meet/<id>",
    );
  }
  const parsed = new URL(value);
  parsed.hash = "";
  return parsed.toString();
}

export function normalizeTeamsMeetingUrlForReuse(url: string | undefined): string | undefined {
  const identity = parseTeamsMeetingIdentity(url);
  return identity ? `teams-${identity.kind}:${identity.key}` : undefined;
}

export function isSameTeamsMeetingUrl(
  left: string | undefined,
  right: string | undefined,
): boolean {
  const normalizedLeft = normalizeTeamsMeetingUrlForReuse(left);
  const normalizedRight = normalizeTeamsMeetingUrlForReuse(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

export function isRecoverableTeamsMeetingTab(
  tab: MeetingBrowserCandidateTab,
  url?: string,
): boolean {
  if (url) {
    return isSameTeamsMeetingUrl(tab.url, url);
  }
  if (normalizeTeamsMeetingUrlForReuse(tab.url)) {
    return true;
  }
  try {
    const hostname = new URL(tab.url ?? "").hostname.toLowerCase();
    return (
      (hostname === "login.microsoftonline.com" || hostname.endsWith(".microsoftonline.com")) &&
      /sign in|microsoft|teams/i.test(tab.title ?? "")
    );
  } catch {
    return false;
  }
}
