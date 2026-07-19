// Whatsapp plugin module implements resolve outbound target behavior.
import { missingTargetError } from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveWhatsAppAccount } from "./accounts.js";
import { readWhatsAppLidToPnMappings } from "./lid-mapping-files.js";
import {
  isWhatsAppGroupJid,
  isWhatsAppNewsletterJid,
  normalizeWhatsAppDirectPhone,
  normalizeWhatsAppTarget,
} from "./normalize-target.js";
import { classifyWhatsAppDirectJid } from "./whatsapp-jid.js";

type WhatsAppOutboundTargetResolution = { ok: true; to: string } | { ok: false; error: Error };

function whatsappAllowFromPolicyError(target: string): Error {
  return new Error(`Target "${target}" is not listed in the configured WhatsApp allowFrom policy.`);
}

function resolveAuthorizedTargetPhone(params: {
  target: string;
  cfg?: OpenClawConfig;
  accountId?: string | null;
}): string | null {
  const directPhone = normalizeWhatsAppDirectPhone(params.target);
  if (directPhone || !params.cfg) {
    return directPhone;
  }
  const directJid = classifyWhatsAppDirectJid(params.target);
  if (directJid?.kind !== "lid") {
    return null;
  }
  const account = resolveWhatsAppAccount({ cfg: params.cfg, accountId: params.accountId });
  const mappings = readWhatsAppLidToPnMappings({
    lid: directJid.user,
    mappingDirs: [account.authDir],
  });
  return mappings.length === 1 ? (mappings[0] ?? null) : null;
}

export function resolveWhatsAppOutboundTarget(params: {
  to: string | null | undefined;
  allowFrom: Array<string | number> | null | undefined;
  mode: string | null | undefined;
  cfg?: OpenClawConfig;
  accountId?: string | null;
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

  const allowListRaw = normalizeStringEntries(params.allowFrom ?? []);
  const hasWildcard = allowListRaw.includes("*");
  const constrainedEntries = allowListRaw.filter((entry) => entry !== "*");
  const allowList = constrainedEntries
    .map((entry) => normalizeWhatsAppDirectPhone(entry))
    .filter((entry): entry is string => Boolean(entry));
  if (hasWildcard || constrainedEntries.length === 0) {
    return { ok: true, to: normalizedTo };
  }
  const normalizedTargetPhone = resolveAuthorizedTargetPhone({
    target: normalizedTo,
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (normalizedTargetPhone && allowList.includes(normalizedTargetPhone)) {
    return { ok: true, to: normalizedTo };
  }
  return {
    ok: false,
    error: whatsappAllowFromPolicyError(normalizedTo),
  };
}
