import { missingTargetError } from "openclaw/plugin-sdk/channel-feedback";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeWhatsAppTarget } from "./normalize-target.js";

type WhatsAppOutboundTargetResolution = { ok: true; to: string } | { ok: false; error: Error };

export function resolveWhatsAppOutboundTarget(params: {
  to: string | null | undefined;
  allowFrom: Array<string | number> | null | undefined;
  mode: string | null | undefined;
}): WhatsAppOutboundTargetResolution {
  const normalizedTo = normalizeWhatsAppTarget(params.to ?? "");
  if (!normalizedTo) {
    return {
      ok: false,
      error: missingTargetError("WhatsApp", "<E.164|group JID|newsletter JID>"),
    };
  }
  if (normalizedTo.endsWith("@g.us") || normalizedTo.endsWith("@newsletter")) {
    return { ok: true, to: normalizedTo };
  }

  const allowListRaw = normalizeStringEntries(params.allowFrom ?? []);
  const hasWildcard = allowListRaw.includes("*");
  const allowList = allowListRaw
    .filter((entry) => entry !== "*")
    .map((entry) => normalizeWhatsAppTarget(entry))
    .filter((entry): entry is string => Boolean(entry));
  if (hasWildcard || allowList.length === 0 || allowList.includes(normalizedTo)) {
    return { ok: true, to: normalizedTo };
  }
  return {
    ok: false,
    error: new Error(
      `Target "${normalizedTo}" is not listed in the configured WhatsApp allowFrom policy.`,
    ),
  };
}
