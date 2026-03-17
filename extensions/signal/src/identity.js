import { evaluateSenderGroupAccessForPolicy } from "../../../src/plugin-sdk/group-access.js";
import { normalizeE164 } from "../../../src/utils.js";
const UUID_HYPHENATED_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_COMPACT_RE = /^[0-9a-f]{32}$/i;
function looksLikeUuid(value) {
  if (UUID_HYPHENATED_RE.test(value) || UUID_COMPACT_RE.test(value)) {
    return true;
  }
  const compact = value.replace(/-/g, "");
  if (!/^[0-9a-f]+$/i.test(compact)) {
    return false;
  }
  return /[a-f]/i.test(compact);
}
function stripSignalPrefix(value) {
  return value.replace(/^signal:/i, "").trim();
}
function resolveSignalSender(params) {
  const sourceNumber = params.sourceNumber?.trim();
  if (sourceNumber) {
    return {
      kind: "phone",
      raw: sourceNumber,
      e164: normalizeE164(sourceNumber)
    };
  }
  const sourceUuid = params.sourceUuid?.trim();
  if (sourceUuid) {
    return { kind: "uuid", raw: sourceUuid };
  }
  return null;
}
function formatSignalSenderId(sender) {
  return sender.kind === "phone" ? sender.e164 : `uuid:${sender.raw}`;
}
function formatSignalSenderDisplay(sender) {
  return sender.kind === "phone" ? sender.e164 : `uuid:${sender.raw}`;
}
function formatSignalPairingIdLine(sender) {
  if (sender.kind === "phone") {
    return `Your Signal number: ${sender.e164}`;
  }
  return `Your Signal sender id: ${formatSignalSenderId(sender)}`;
}
function resolveSignalRecipient(sender) {
  return sender.kind === "phone" ? sender.e164 : sender.raw;
}
function resolveSignalPeerId(sender) {
  return sender.kind === "phone" ? sender.e164 : `uuid:${sender.raw}`;
}
function parseSignalAllowEntry(entry) {
  const trimmed = entry.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return { kind: "any" };
  }
  const stripped = stripSignalPrefix(trimmed);
  const lower = stripped.toLowerCase();
  if (lower.startsWith("uuid:")) {
    const raw = stripped.slice("uuid:".length).trim();
    if (!raw) {
      return null;
    }
    return { kind: "uuid", raw };
  }
  if (looksLikeUuid(stripped)) {
    return { kind: "uuid", raw: stripped };
  }
  return { kind: "phone", e164: normalizeE164(stripped) };
}
function normalizeSignalAllowRecipient(entry) {
  const parsed = parseSignalAllowEntry(entry);
  if (!parsed || parsed.kind === "any") {
    return void 0;
  }
  return parsed.kind === "phone" ? parsed.e164 : parsed.raw;
}
function isSignalSenderAllowed(sender, allowFrom) {
  if (allowFrom.length === 0) {
    return false;
  }
  const parsed = allowFrom.map(parseSignalAllowEntry).filter((entry) => entry !== null);
  if (parsed.some((entry) => entry.kind === "any")) {
    return true;
  }
  return parsed.some((entry) => {
    if (entry.kind === "phone" && sender.kind === "phone") {
      return entry.e164 === sender.e164;
    }
    if (entry.kind === "uuid" && sender.kind === "uuid") {
      return entry.raw === sender.raw;
    }
    return false;
  });
}
function isSignalGroupAllowed(params) {
  return evaluateSenderGroupAccessForPolicy({
    groupPolicy: params.groupPolicy,
    groupAllowFrom: params.allowFrom,
    senderId: params.sender.raw,
    isSenderAllowed: () => isSignalSenderAllowed(params.sender, params.allowFrom)
  }).allowed;
}
export {
  formatSignalPairingIdLine,
  formatSignalSenderDisplay,
  formatSignalSenderId,
  isSignalGroupAllowed,
  isSignalSenderAllowed,
  looksLikeUuid,
  normalizeSignalAllowRecipient,
  resolveSignalPeerId,
  resolveSignalRecipient,
  resolveSignalSender
};
