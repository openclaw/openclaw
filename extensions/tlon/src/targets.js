const SHIP_RE = /^~?[a-z-]+$/i;
const NEST_RE = /^chat\/([^/]+)\/([^/]+)$/i;
function normalizeShip(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return trimmed;
  }
  return trimmed.startsWith("~") ? trimmed : `~${trimmed}`;
}
function parseChannelNest(raw) {
  const match = NEST_RE.exec(raw.trim());
  if (!match) {
    return null;
  }
  const hostShip = normalizeShip(match[1]);
  const channelName = match[2];
  return { hostShip, channelName };
}
function parseTlonTarget(raw) {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  const withoutPrefix = trimmed.replace(/^tlon:/i, "");
  const dmPrefix = withoutPrefix.match(/^dm[/:](.+)$/i);
  if (dmPrefix) {
    return { kind: "dm", ship: normalizeShip(dmPrefix[1]) };
  }
  const groupPrefix = withoutPrefix.match(/^(group|room)[/:](.+)$/i);
  if (groupPrefix) {
    const groupTarget = groupPrefix[2].trim();
    if (groupTarget.startsWith("chat/")) {
      const parsed = parseChannelNest(groupTarget);
      if (!parsed) {
        return null;
      }
      return {
        kind: "group",
        nest: `chat/${parsed.hostShip}/${parsed.channelName}`,
        hostShip: parsed.hostShip,
        channelName: parsed.channelName
      };
    }
    const parts = groupTarget.split("/");
    if (parts.length === 2) {
      const hostShip = normalizeShip(parts[0]);
      const channelName = parts[1];
      return {
        kind: "group",
        nest: `chat/${hostShip}/${channelName}`,
        hostShip,
        channelName
      };
    }
    return null;
  }
  if (withoutPrefix.startsWith("chat/")) {
    const parsed = parseChannelNest(withoutPrefix);
    if (!parsed) {
      return null;
    }
    return {
      kind: "group",
      nest: `chat/${parsed.hostShip}/${parsed.channelName}`,
      hostShip: parsed.hostShip,
      channelName: parsed.channelName
    };
  }
  if (SHIP_RE.test(withoutPrefix)) {
    return { kind: "dm", ship: normalizeShip(withoutPrefix) };
  }
  return null;
}
function formatTargetHint() {
  return "dm/~sampel-palnet | ~sampel-palnet | chat/~host-ship/channel | group:~host-ship/channel";
}
export {
  formatTargetHint,
  normalizeShip,
  parseChannelNest,
  parseTlonTarget
};
