import {
  patchScopedAccountConfig,
  prepareScopedSetupConfig,
} from "../../../src/channels/plugins/setup-helpers.js";
import type { ChannelSetupAdapter } from "../../../src/channels/plugins/types.adapters.js";
import type { ChannelSetupInput } from "../../../src/channels/plugins/types.core.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../src/routing/session-key.js";
import { buildTlonAccountFields } from "./account-fields.js";
import { resolveTlonAccount } from "./types.js";

const channel = "tlon" as const;

export type TlonSetupInput = ChannelSetupInput & {
  ship?: string;
  url?: string;
  code?: string;
  allowPrivateNetwork?: boolean;
  groupChannels?: string[];
  dmAllowlist?: string[];
  autoDiscoverChannels?: boolean;
  ownerShip?: string;
};

export function applyTlonSetupConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: TlonSetupInput;
}): OpenClawConfig {
  const { cfg, accountId, input } = params;
  const useDefault = accountId === DEFAULT_ACCOUNT_ID;
  const namedConfig = prepareScopedSetupConfig({
    cfg,
    channelKey: channel,
    accountId,
    name: input.name,
  });
  const base = namedConfig.channels?.tlon ?? {};
  const payload = buildTlonAccountFields(input);

  if (useDefault) {
    return {
      ...namedConfig,
      channels: {
        ...namedConfig.channels,
        tlon: {
          ...base,
          enabled: true,
          ...payload,
        },
      },
    };
  }

  return patchScopedAccountConfig({
    cfg: namedConfig,
    channelKey: channel,
    accountId,
    patch: { enabled: base.enabled ?? true },
    accountPatch: {
      enabled: true,
      ...payload,
    },
    ensureChannelEnabled: false,
    ensureAccountEnabled: false,
  });
}

export const tlonSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    prepareScopedSetupConfig({
      cfg,
      channelKey: channel,
      accountId,
      name,
    }),
  validateInput: ({ cfg, accountId, input }) => {
    const setupInput = input as TlonSetupInput;
    const resolved = resolveTlonAccount(cfg, accountId ?? undefined);
    const ship = setupInput.ship?.trim() || resolved.ship;
    const url = setupInput.url?.trim() || resolved.url;
    const code = setupInput.code?.trim() || resolved.code;
    if (!ship) {
      return "Tlon requires --ship.";
    }
    if (!url) {
      return "Tlon requires --url.";
    }
    if (!code) {
      return "Tlon requires --code.";
    }
    return null;
  },
  applyAccountConfig: ({ cfg, accountId, input }) =>
    applyTlonSetupConfig({
      cfg,
      accountId,
      input: input as TlonSetupInput,
    }),
};
