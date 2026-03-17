import { buildChannelKeyCandidates, resolveChannelEntryMatch } from "openclaw/plugin-sdk/matrix";
function resolveMatrixRoomConfig(params) {
  const rooms = params.rooms ?? {};
  const keys = Object.keys(rooms);
  const allowlistConfigured = keys.length > 0;
  const candidates = buildChannelKeyCandidates(
    params.roomId,
    `room:${params.roomId}`,
    ...params.aliases
  );
  const {
    entry: matched,
    key: matchedKey,
    wildcardEntry,
    wildcardKey
  } = resolveChannelEntryMatch({
    entries: rooms,
    keys: candidates,
    wildcardKey: "*"
  });
  const resolved = matched ?? wildcardEntry;
  const allowed = resolved ? resolved.enabled !== false && resolved.allow !== false : false;
  const matchKey = matchedKey ?? wildcardKey;
  const matchSource = matched ? "direct" : wildcardEntry ? "wildcard" : void 0;
  return {
    allowed,
    allowlistConfigured,
    config: resolved,
    matchKey,
    matchSource
  };
}
export {
  resolveMatrixRoomConfig
};
