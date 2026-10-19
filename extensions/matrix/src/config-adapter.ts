import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  listMatrixAccountIds,
  resolveDefaultMatrixAccountId,
  resolveMatrixAccount,
  resolveMatrixAccountAsync,
  resolveMatrixAccountConfig,
  type ResolvedMatrixAccount,
} from "./matrix/accounts.js";
import { normalizeMatrixAllowList } from "./matrix/monitor/allowlist.js";

export const matrixConfigAdapter = {
  ...createScopedChannelConfigAdapter<
    ResolvedMatrixAccount,
    ReturnType<typeof resolveMatrixAccountConfig>
  >({
    sectionKey: "matrix",
    listAccountIds: listMatrixAccountIds,
    /** @deprecated Use resolveAccountAsync. Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
    resolveAccount: adaptScopedAccountAccessor(resolveMatrixAccount),
    resolveAccessorAccount: resolveMatrixAccountConfig,
    defaultAccountId: resolveDefaultMatrixAccountId,
    clearBaseFields: [
      "name",
      "homeserver",
      "network",
      "proxy",
      "userId",
      "accessToken",
      "password",
      "deviceId",
      "deviceName",
      "avatarUrl",
      "initialSyncLimit",
    ],
    resolveAllowFrom: (account) => account.dm?.allowFrom,
    formatAllowFrom: normalizeMatrixAllowList,
  }),
  resolveAccountAsync: adaptScopedAccountAccessor(resolveMatrixAccountAsync),
};
