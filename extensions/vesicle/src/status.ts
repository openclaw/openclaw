import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { buildProbeChannelStatusSummary } from "openclaw/plugin-sdk/channel-status";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  resolveVesicleEffectiveAllowPrivateNetwork,
  type ResolvedVesicleAccount,
} from "./accounts.js";
import { probeVesicle, type VesicleProbe } from "./probe.js";

export const vesicleStatus = createComputedAccountStatusAdapter<
  ResolvedVesicleAccount,
  VesicleProbe
>({
  defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
  buildChannelSummary: ({ snapshot }) =>
    buildProbeChannelStatusSummary(snapshot, { baseUrl: snapshot.baseUrl ?? null }),
  probeAccount: async ({ account, timeoutMs }) =>
    await probeVesicle({
      baseUrl: account.baseUrl,
      authToken: account.config.authToken ?? null,
      timeoutMs: timeoutMs ?? account.config.probeTimeoutMs,
      allowPrivateNetwork: resolveVesicleEffectiveAllowPrivateNetwork({
        baseUrl: account.baseUrl,
        config: account.config,
      }),
    }),
  resolveAccountSnapshot: ({ account, runtime, probe }) => {
    const running = runtime?.running ?? false;
    return {
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      extra: {
        baseUrl: account.baseUrl,
        connected: probe?.ok ?? running,
        nativeStatus: probe?.nativeStatus ?? null,
      },
    };
  },
});
