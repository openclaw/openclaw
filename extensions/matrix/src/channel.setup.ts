import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { MatrixChannelConfigSchema } from "./config-schema.js";
import {
  listMatrixAccountIds,
  resolveDefaultMatrixAccountId,
  resolveMatrixAccount,
  resolveMatrixAccountAsync,
  resolveMatrixAccountConfig,
  type ResolvedMatrixAccount,
} from "./matrix/accounts.js";
import { normalizeMatrixAllowList } from "./matrix/monitor/allowlist.js";
import { createMatrixSetupWizardProxy, matrixSetupContract } from "./setup-core.js";

const matrixSetupWizard = createMatrixSetupWizardProxy(async () => ({
  matrixSetupWizard: (await import("./onboarding.js")).matrixOnboardingAdapter,
}));

export const matrixPluginBase = {
  id: "matrix",
  meta: {
    id: "matrix",
    label: "Matrix",
    selectionLabel: "Matrix (plugin)",
    docsPath: "/channels/matrix",
    docsLabel: "matrix",
    blurb: "open protocol; configure a homeserver + access token.",
    order: 70,
    quickstartAllowFrom: true,
  },
  setupWizard: matrixSetupWizard,
  setupContract: matrixSetupContract,
  capabilities: {
    chatTypes: ["direct", "group", "thread"],
    polls: true,
    reactions: true,
    threads: true,
    media: true,
  },
  reload: { configPrefixes: ["channels.matrix"], noopPrefixes: ["messages.ackReactionScope"] },
  lifecycle: {
    // channels remove loads the setup plugin; a removed account must not hand its cached
    // login to a later account with the same id.
    onAccountRemoved: async ({ accountId }: { accountId: string }) => {
      const { clearMatrixCredentials } = await import("./matrix/credentials.js");
      await clearMatrixCredentials(process.env, accountId);
    },
  },
  configSchema: MatrixChannelConfigSchema,
  config: {
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
    isConfigured: (account) => account.configured,
    describeAccount: (account) =>
      describeAccountSnapshot({
        account,
        configured: account.configured,
        extra: {
          baseUrl: account.homeserver,
        },
      }),
  },
} satisfies ChannelPlugin<ResolvedMatrixAccount>;

export const matrixSetupPlugin: ChannelPlugin<ResolvedMatrixAccount> = {
  ...matrixPluginBase,
  config: {
    ...matrixPluginBase.config,
    /** @deprecated Use hasConfiguredStateAsync. Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
    hasConfiguredState: ({ cfg, env }) => resolveMatrixAccount({ cfg, env }).configured,
    hasConfiguredStateAsync: async ({ cfg, env }) =>
      (await resolveMatrixAccountAsync({ cfg, env })).configured,
  },
};
