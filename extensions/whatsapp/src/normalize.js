import {
  looksLikeHandleOrPhoneTarget,
  trimMessagingTarget
} from "../../../src/channels/plugins/normalize/shared.js";
import { normalizeWhatsAppTarget } from "../../../src/whatsapp/normalize.js";
function normalizeWhatsAppMessagingTarget(raw) {
  const trimmed = trimMessagingTarget(raw);
  if (!trimmed) {
    return void 0;
  }
  return normalizeWhatsAppTarget(trimmed) ?? void 0;
}
function normalizeWhatsAppAllowFromEntries(allowFrom) {
  return allowFrom.map((entry) => String(entry).trim()).filter((entry) => Boolean(entry)).map((entry) => entry === "*" ? entry : normalizeWhatsAppTarget(entry)).filter((entry) => Boolean(entry));
}
function looksLikeWhatsAppTargetId(raw) {
  return looksLikeHandleOrPhoneTarget({
    raw,
    prefixPattern: /^whatsapp:/i
  });
}
export {
  looksLikeWhatsAppTargetId,
  normalizeWhatsAppAllowFromEntries,
  normalizeWhatsAppMessagingTarget
};
