import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
type TlonTarget =
  | { kind: "dm"; ship: string }
  | { kind: "club"; clubId: string }
  | { kind: "group"; nest: string; hostShip: string; channelName: string };

const SHIP_RE = /^~?[a-z-]+$/i;
const NEST_RE = /^chat\/([^/]+)\/([^/]+)$/i;

export const TLON_CLUB_ID_RE = /^0v(?:0|[1-9a-v][0-9a-v]{0,4}(?:\.[0-9a-v]{5})*)$/;

export function normalizeShip(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return trimmed;
  }
  return trimmed.startsWith("~") ? trimmed : `~${trimmed}`;
}

export function parseChannelNest(raw: string): { hostShip: string; channelName: string } | null {
  const match = NEST_RE.exec(raw.trim());
  if (!match) {
    return null;
  }
  const hostShip = normalizeShip(expectDefined(match[1], "channel host capture"));
  const channelName = expectDefined(match[2], "channel name capture");
  return { hostShip, channelName };
}

function makeGroupTarget(parsed: { hostShip: string; channelName: string }): TlonTarget {
  return {
    kind: "group",
    nest: `chat/${parsed.hostShip}/${parsed.channelName}`,
    hostShip: parsed.hostShip,
    channelName: parsed.channelName,
  };
}

export function parseTlonTarget(raw?: string | null): TlonTarget | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  const withoutPrefix = trimmed.replace(/^tlon:/i, "");

  if (withoutPrefix.startsWith("club:")) {
    const clubId = withoutPrefix.slice(5);
    return TLON_CLUB_ID_RE.test(clubId) ? { kind: "club", clubId } : null;
  }

  const dmPrefix = withoutPrefix.match(/^dm[/:](.+)$/i);
  if (dmPrefix) {
    return { kind: "dm", ship: normalizeShip(expectDefined(dmPrefix[1], "DM ship capture")) };
  }

  const groupPrefix = withoutPrefix.match(/^(group|room)[/:](.+)$/i);
  if (groupPrefix) {
    const groupTarget = expectDefined(groupPrefix[2], "group target capture").trim();
    if (groupTarget.startsWith("chat/")) {
      const parsed = parseChannelNest(groupTarget);
      if (!parsed) {
        return null;
      }
      return makeGroupTarget(parsed);
    }
    const parts = groupTarget.split("/");
    if (parts.length === 2) {
      const hostShip = normalizeShip(expectDefined(parts[0], "two-part group host"));
      const channelName = expectDefined(parts[1], "two-part group channel");
      return makeGroupTarget({ hostShip, channelName });
    }
    return null;
  }

  if (withoutPrefix.startsWith("chat/")) {
    const parsed = parseChannelNest(withoutPrefix);
    if (!parsed) {
      return null;
    }
    return makeGroupTarget(parsed);
  }

  if (SHIP_RE.test(withoutPrefix)) {
    return { kind: "dm", ship: normalizeShip(withoutPrefix) };
  }

  return null;
}

export function resolveTlonOutboundTarget(to?: string | null) {
  const parsed = parseTlonTarget(to ?? "");
  if (!parsed) {
    return {
      ok: false as const,
      error: new Error(`Invalid Tlon target. Use ${formatTargetHint()}`),
    };
  }
  if (parsed.kind === "dm") {
    return { ok: true as const, to: parsed.ship };
  }
  if (parsed.kind === "club") {
    return { ok: true as const, to: `club:${parsed.clubId}` };
  }
  return { ok: true as const, to: parsed.nest };
}

export function formatTargetHint(): string {
  return "dm/~sampel-palnet | ~sampel-palnet | club:0v1.abcde | chat/~host-ship/channel | group:~host-ship/channel";
}
