import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  createChannelSecretContract,
  hasConfiguredSecretInputValue,
  hasOwnProperty,
  normalizeSecretStringValue,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { getMatrixScopedEnvVarNames } from "./env-vars.js";

function accountSecretOwner(accountId: string) {
  return {
    ownerKind: "account" as const,
    ownerId: `matrix:${normalizeAccountId(accountId)}`,
    requiredForGateway: false,
    disposition: "isolate" as const,
  };
}

export const channelSecrets = createChannelSecretContract({
  channelKey: "matrix",
  account: ["accessToken", "password"],
  channel: ["accessToken", "password"],
  collect(params) {
    const { channel: matrix, surface } = params;
    const envAccessTokenConfigured =
      normalizeSecretStringValue(params.context.env.MATRIX_ACCESS_TOKEN).length > 0;
    const defaultScopedAccessTokenConfigured =
      normalizeSecretStringValue(
        params.context.env[getMatrixScopedEnvVarNames("default").accessToken],
      ).length > 0;
    const defaultScopedPasswordConfigured =
      normalizeSecretStringValue(params.context.env[getMatrixScopedEnvVarNames("default").password])
        .length > 0;
    const defaultAccount = surface.hasExplicitAccounts
      ? surface.accounts.find(
          ({ accountId }) => normalizeAccountId(accountId) === DEFAULT_ACCOUNT_ID,
        )
      : undefined;
    const defaultAccountEnabled = surface.channelEnabled && (defaultAccount?.enabled ?? true);
    const defaultAccountAccessTokenConfigured = hasConfiguredSecretInputValue(
      defaultAccount?.account.accessToken,
      params.defaults,
    );
    const defaultAccountPasswordConfigured = hasConfiguredSecretInputValue(
      defaultAccount?.account.password,
      params.defaults,
    );
    const baseAccessTokenConfigured = hasConfiguredSecretInputValue(
      matrix.accessToken,
      params.defaults,
    );
    params.collectSecret(matrix, "accessToken", "channels.matrix.accessToken", {
      active:
        defaultAccountEnabled &&
        !defaultAccountAccessTokenConfigured &&
        !defaultScopedAccessTokenConfigured,
      inactiveReason:
        "Matrix channel or default account is disabled, or default-account access-token auth overrides the top-level accessToken.",
      owner: accountSecretOwner(DEFAULT_ACCOUNT_ID),
    });
    params.collectSecret(matrix, "password", "channels.matrix.password", {
      active:
        defaultAccountEnabled &&
        !(
          baseAccessTokenConfigured ||
          envAccessTokenConfigured ||
          defaultScopedAccessTokenConfigured ||
          defaultAccountAccessTokenConfigured ||
          defaultAccountPasswordConfigured ||
          defaultScopedPasswordConfigured
        ),
      inactiveReason:
        "Matrix channel or default account is disabled, or higher-precedence default-account auth is configured.",
      owner: accountSecretOwner(DEFAULT_ACCOUNT_ID),
    });
    if (!surface.hasExplicitAccounts) {
      return;
    }
    for (const { accountId, account, enabled } of surface.accounts) {
      if (hasOwnProperty(account, "accessToken")) {
        params.collectSecret(
          account,
          "accessToken",
          `channels.matrix.accounts.${accountId}.accessToken`,
          {
            active: enabled,
            inactiveReason: "Matrix account is disabled.",
            owner: accountSecretOwner(accountId),
          },
        );
      }
      if (!hasOwnProperty(account, "password")) {
        continue;
      }
      const accountAccessTokenConfigured = hasConfiguredSecretInputValue(
        account.accessToken,
        params.defaults,
      );
      const scopedEnvAccessTokenConfigured =
        normalizeSecretStringValue(
          params.context.env[getMatrixScopedEnvVarNames(accountId).accessToken],
        ).length > 0;
      const inheritedDefaultAccountAccessTokenConfigured =
        normalizeAccountId(accountId) === DEFAULT_ACCOUNT_ID &&
        (baseAccessTokenConfigured || envAccessTokenConfigured);
      params.collectSecret(account, "password", `channels.matrix.accounts.${accountId}.password`, {
        active:
          enabled &&
          !(
            accountAccessTokenConfigured ||
            scopedEnvAccessTokenConfigured ||
            inheritedDefaultAccountAccessTokenConfigured
          ),
        inactiveReason: "Matrix account is disabled or this account has an accessToken configured.",
        owner: accountSecretOwner(accountId),
      });
    }
  },
});

export const { secretTargetRegistryEntries, collectRuntimeConfigAssignments } = channelSecrets;
