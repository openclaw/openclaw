import type { MeetingBrowserCandidateTab } from "openclaw/plugin-sdk/meeting-runtime";
import { slackHuddlesInvalidRequest } from "../errors.js";

type SlackHuddleIdentity = { channel: string; team?: string };

function parseSlackHuddleIdentity(input: string | undefined): SlackHuddleIdentity | undefined {
  if (!input) {
    return undefined;
  }
  const value = input.trim();
  const channel = value.replace(/^(?:slack:)?channel:/i, "");
  if (/^[CGD][A-Z0-9]{8,}$/.test(channel)) {
    return { channel };
  }
  const qualified = value.match(/^(?:slack:)?team:([^:]+):channel:([^:]+)$/i);
  const team = qualified?.[1];
  const qualifiedChannel = qualified?.[2];
  if (
    team &&
    qualifiedChannel &&
    /^[TE][A-Z0-9]{8,}$/.test(team) &&
    /^[CGD][A-Z0-9]{8,}$/.test(qualifiedChannel)
  ) {
    return { team, channel: qualifiedChannel };
  }
  const url = URL.parse(value);
  if (
    !url ||
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    !/^[a-z0-9-]+\.slack\.com$/i.test(url.hostname)
  ) {
    return undefined;
  }
  const match = url.pathname.match(/^\/huddle\/(?:([TE][A-Z0-9]{8,})\/)?([CGD][A-Z0-9]{8,})\/?$/);
  const matchedChannel = match?.[2];
  return matchedChannel ? { team: match?.[1], channel: matchedChannel } : undefined;
}

export function normalizeSlackHuddleUrl(input: unknown): string {
  const identity = typeof input === "string" ? parseSlackHuddleIdentity(input) : undefined;
  if (!identity) {
    throw slackHuddlesInvalidRequest(
      "Use a Slack Copy huddle link (https://app.slack.com/huddle/TEAM/CHANNEL), an uppercase channel id such as C0123ABCD or channel:C0123ABCD, or team:T0123ABCD:channel:C0123ABCD. Message permalinks, user ids, and slack:// links are not huddle links.",
    );
  }
  return `https://app.slack.com/huddle/${identity.team ? `${identity.team}/` : ""}${identity.channel}`;
}

// Channel ids are only workspace-scoped, so team-qualified links keep their team; a bare channel
// reference stays channel-only and never matches a team-qualified session.
export function normalizeSlackHuddleUrlForReuse(url: string | undefined): string | undefined {
  const identity = parseSlackHuddleIdentity(url);
  if (!identity) {
    return undefined;
  }
  return identity.team
    ? `slack-huddle:${identity.team}:${identity.channel}`
    : `slack-huddle:${identity.channel}`;
}

export function isSameSlackHuddleUrl(left: string | undefined, right: string | undefined): boolean {
  const identity = normalizeSlackHuddleUrlForReuse(left);
  return Boolean(identity && identity === normalizeSlackHuddleUrlForReuse(right));
}

export function isRecoverableSlackHuddleTab(
  tab: MeetingBrowserCandidateTab,
  url?: string,
): boolean {
  // Recovery only discovers huddle links; client routes are interpreted inside the tracked page.
  return url
    ? isSameSlackHuddleUrl(tab.url, url)
    : Boolean(normalizeSlackHuddleUrlForReuse(tab.url));
}
