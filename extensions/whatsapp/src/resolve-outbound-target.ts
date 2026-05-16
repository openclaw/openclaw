import { resolveWhatsAppTargetFacts } from "./target-facts.js";

export type WhatsAppOutboundTargetResolution =
  | { ok: true; to: string }
  | { ok: false; error: Error };

export function resolveWhatsAppOutboundTarget(params: {
  to: string | null | undefined;
  allowFrom: Array<string | number> | null | undefined;
  mode: string | null | undefined;
}): WhatsAppOutboundTargetResolution {
  const resolution = resolveWhatsAppTargetFacts({
    target: params.to,
    allowFrom: params.allowFrom,
  });
  if (!resolution.ok) {
    return { ok: false, error: resolution.error };
  }
  const facts = resolution.facts;
  if (facts.authorization.allowed) {
    return {
      ok: true,
      to: facts.wireDelivery.preserveJidAsAuthorizedTarget
        ? facts.wireDelivery.jid
        : facts.normalizedTarget,
    };
  }
  return {
    ok: false,
    error: facts.authorization.error,
  };
}
