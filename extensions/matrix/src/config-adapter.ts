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
