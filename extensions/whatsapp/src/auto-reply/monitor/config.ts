import { resolveWhatsAppAccount } from "../../accounts.js";
import { getRuntimeConfig } from "../config.runtime.js";

type WhatsAppRuntimeConfig = ReturnType<typeof getRuntimeConfig>;

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
  const cfg = {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      whatsapp: {
        ...params.cfg.channels?.whatsapp,
        responsePrefix: account.messagePrefix,
        allowFrom: account.allowFrom,
        groupAllowFrom: account.groupAllowFrom,
        groupPolicy: account.groupPolicy,
        textChunkLimit: account.textChunkLimit,
        // Account merge replaces `streaming` wholesale, so pinning the
        // account-resolved object here keeps downstream root-level resolver
        // reads (chunk mode, block enable/coalesce) on this account's config.
        streaming: account.streaming,
        mediaMaxMb: account.mediaMaxMb,
        groups: account.groups,
      },
    },
  } satisfies WhatsAppRuntimeConfig;
  return { cfg, account };
}
