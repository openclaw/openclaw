// Whatsapp plugin module implements resolve outbound target behavior.
import { missingTargetError } from "openclaw/plugin-sdk/channel-feedback";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isWhatsAppGroupJid,
  isWhatsAppNewsletterJid,
  normalizeWhatsAppTarget,
} from "./normalize-target.js";

export type WhatsAppOutboundTargetResolution =
  | { ok: true; to: string }
  | { ok: false; error: Error };

function whatsappDirectPolicyError(
  target: string,
  policyField: "allowFrom" | "allowSendTo",
): Error {
  return new Error(
    `Target "${target}" is not listed in the configured WhatsApp ${policyField} policy.`,
  );
}

export function resolveWhatsAppOutboundTarget(params: {
  to: string | null | undefined;
  allowFrom: Array<string | number> | null | undefined;
  allowSendTo?: Array<string | number> | null | undefined;
  mode: string | null | undefined;
}): WhatsAppOutboundTargetResolution {
  const trimmed = params.to?.trim() ?? "";
  if (!trimmed) {
    return {
      ok: false,
      error: missingTargetError("WhatsApp", "<E.164|group JID|newsletter JID>"),
    };
  }

  const normalizedTo = normalizeWhatsAppTarget(trimmed);
  if (!normalizedTo) {
    return {
      ok: false,
      error: missingTargetError("WhatsApp", "<E.164|group JID|newsletter JID>"),
    };
  }
  if (isWhatsAppGroupJid(normalizedTo) || isWhatsAppNewsletterJid(normalizedTo)) {
    return { ok: true, to: normalizedTo };
  }

  const hasExplicitAllowSendTo = params.allowSendTo != null;
  const policyField = hasExplicitAllowSendTo ? "allowSendTo" : "allowFrom";
  const allowListRaw = normalizeStringEntries(
    (hasExplicitAllowSendTo ? params.allowSendTo : params.allowFrom) ?? [],
  );
  const hasWildcard = allowListRaw.includes("*");
  const allowList = allowListRaw
    .filter((entry) => entry !== "*")
    .map((entry) => normalizeWhatsAppTarget(entry))
    .filter((entry): entry is string => Boolean(entry));
  if (hasWildcard || (!hasExplicitAllowSendTo && allowList.length === 0)) {
    return { ok: true, to: normalizedTo };
  }
  if (allowList.includes(normalizedTo)) {
    return { ok: true, to: normalizedTo };
  }
  return {
    ok: false,
    error: whatsappDirectPolicyError(normalizedTo, policyField),
  };
}
