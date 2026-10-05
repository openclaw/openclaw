import { resolveWhatsAppAccount } from "../accounts.js";
import type { getRuntimeConfig } from "./config.runtime.js";

type WhatsAppRuntimeConfig = ReturnType<typeof getRuntimeConfig>;
type WhatsAppSection = NonNullable<NonNullable<WhatsAppRuntimeConfig["channels"]>["whatsapp"]>;

/**
 * Projects the account-resolved WhatsApp settings onto the root channel section for one turn.
 *
 * Durable final delivery compares this section with the live Gateway's raw config before a
 * registry handoff. A resolved value of `undefined` for a key the raw section does not have
 * reads identically to an absent key, so it is left out: adding it would make an unchanged
 * config compare unequal (`isDeepStrictEqual({ a: undefined }, {})` is false) and drop the reply.
 */
export function resolveWebMonitorConfigSnapshot(params: {
  cfg: WhatsAppRuntimeConfig;
  accountId?: string | null;
}): {
  cfg: WhatsAppRuntimeConfig;
  account: ReturnType<typeof resolveWhatsAppAccount>;
} {
  const account = resolveWhatsAppAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const rawWhatsApp = params.cfg.channels?.whatsapp;
  const whatsapp: WhatsAppSection = { ...rawWhatsApp };
  const pin = <K extends keyof WhatsAppSection>(key: K, value: WhatsAppSection[K]) => {
    if (value === undefined && !(rawWhatsApp && Object.hasOwn(rawWhatsApp, key))) {
      return;
    }
    whatsapp[key] = value;
  };
  pin("responsePrefix", account.messagePrefix);
  pin("allowFrom", account.allowFrom);
  pin("groupAllowFrom", account.groupAllowFrom);
  pin("groupPolicy", account.groupPolicy);
  pin("textChunkLimit", account.textChunkLimit);
  // Account merge replaces `streaming` wholesale, so pinning the
  // account-resolved object here keeps downstream root-level resolver
  // reads (chunk mode, block enable/coalesce) on this account's config.
  pin("streaming", account.streaming);
  pin("mediaMaxMb", account.mediaMaxMb);
  pin("groups", account.groups);
  const cfg = {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      whatsapp,
    },
  } satisfies WhatsAppRuntimeConfig;
  return { cfg, account };
}
