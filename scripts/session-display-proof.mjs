// Standalone proof renderer for openclaw PR #94813
// Replicates the Sessions-table behavior from PR branch's session-display.ts
// Pure, no openclaw runtime dependencies — the truncation logic is copy-exact
// from ui/src/ui/session-display.ts (commit at PR head).

function normalizeLowercaseStringOrEmpty(s) {
  if (typeof s !== "string") return "";
  return s.toLowerCase();
}
function normalizeOptionalString(s) {
  if (typeof s !== "string") return "";
  return s;
}

const CHANNEL_LABELS = {
  imessage: "iMessage",
  telegram: "Telegram",
  discord: "Discord",
  signal: "Signal",
  slack: "Slack",
  whatsapp: "WhatsApp",
  matrix: "Matrix",
  email: "Email",
  sms: "SMS",
};
const KNOWN_CHANNEL_KEYS = Object.keys(CHANNEL_LABELS);

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function shortenSessionKeyForCell(key) {
  const directMatch = key.match(/^agent:[^:]+:([^:]+):direct:(.+)$/);
  if (!directMatch) {
    const { prefix, fallbackName } = parseSessionKey(key);
    return prefix ? `${prefix} ${fallbackName}`.trim() : fallbackName;
  }
  const channel = directMatch[1];
  const identifier = directMatch[2];
  const channelLabel = CHANNEL_LABELS[channel] ?? capitalize(channel);
  const shortId =
    identifier.length <= 20 ? identifier : `${identifier.slice(0, 6)}...${identifier.slice(-4)}`;
  return `${channelLabel} · ${shortId}`;
}

export function parseSessionKey(key) {
  const normalized = normalizeLowercaseStringOrEmpty(key);
  if (key === "main" || key === "agent:main:main") {
    return { prefix: "", fallbackName: "Main Session" };
  }
  if (key.includes(":subagent:")) {
    return { prefix: "Subagent:", fallbackName: "Subagent:" };
  }
  if (normalized.startsWith("cron:") || key.includes(":cron:")) {
    return { prefix: "Cron:", fallbackName: "Cron Job:" };
  }
  const dm = key.match(/^agent:[^:]+:([^:]+):direct:(.+)$/);
  if (dm) {
    const channel = dm[1];
    const identifier = dm[2];
    const channelLabel = CHANNEL_LABELS[channel] ?? capitalize(channel);
    return { prefix: "", fallbackName: `${channelLabel} · ${identifier}` };
  }
  const gm = key.match(/^agent:[^:]+:([^:]+):group:(.+)$/);
  if (gm) {
    const channel = gm[1];
    const channelLabel = CHANNEL_LABELS[channel] ?? capitalize(channel);
    return { prefix: "", fallbackName: `${channelLabel} Group` };
  }
  for (const ch of KNOWN_CHANNEL_KEYS) {
    if (key === ch || key.startsWith(`${ch}:`)) {
      return { prefix: "", fallbackName: `${CHANNEL_LABELS[ch]} Session` };
    }
  }
  return { prefix: "", fallbackName: key };
}

export function buildCellText(row) {
  const trimmedLabel = normalizeOptionalString(row.label) ?? "";
  const displayName = normalizeOptionalString(row.displayName) ?? null;
  const friendlyKeyLabel = null;
  const hoverTitle = friendlyKeyLabel ?? row.key;
  const cellText = friendlyKeyLabel ?? shortenSessionKeyForCell(row.key);
  const showDisplayName = Boolean(
    displayName && displayName !== row.key && displayName !== trimmedLabel,
  );
  return { hoverTitle, cellText, showDisplayName, displayName };
}
