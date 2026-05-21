import { createScopedChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import {
  inspectLineAccount,
  listLineAccountIds,
  resolveDefaultLineAccountId,
  resolveLineAccount,
  type ResolvedLineAccount,
} from "./channel-api.js";

type LineAccessorAccount = ReturnType<typeof inspectLineAccount>;

function normalizeLineAllowFrom(entry: string): string {
  return entry.replace(/^line:(?:user:)?/i, "");
}

export const lineConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedLineAccount,
  LineAccessorAccount
>({
  sectionKey: "line",
  listAccountIds: listLineAccountIds,
  resolveAccount: (cfg, accountId) =>
    resolveLineAccount({ cfg, accountId: accountId ?? undefined }),
  inspectAccount: (cfg, accountId) => inspectLineAccount({ cfg, accountId }),
  resolveAccessorAccount: ({ cfg, accountId }) => inspectLineAccount({ cfg, accountId }),
  defaultAccountId: resolveDefaultLineAccountId,
  clearBaseFields: ["channelSecret", "tokenFile", "secretFile"],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    allowFrom
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .map(normalizeLineAllowFrom),
});
