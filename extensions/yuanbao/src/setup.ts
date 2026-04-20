import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { YuanbaoConfig } from "./types.js";

function parseAppKeySecretToken(token: string): { appKey: string; appSecret: string } | null {
  const colonIdx = token.indexOf(":");
  if (colonIdx <= 0) {
    return null;
  }
  const appKey = token.slice(0, colonIdx).trim();
  const appSecret = token.slice(colonIdx + 1).trim();
  if (!appKey || !appSecret) {
    return null;
  }
  return { appKey, appSecret };
}

export const yuanbaoSetupAdapter = {
  applyAccountConfig: ({
    cfg,
    input,
  }: {
    cfg: OpenClawConfig;
    input: { token?: string; name?: string };
  }) => {
    const yuanbaoCfg = cfg.channels?.yuanbao as YuanbaoConfig | undefined;
    const patch: Partial<YuanbaoConfig> = {};

    if (input.token?.trim()) {
      const parsed = parseAppKeySecretToken(input.token.trim());
      if (parsed) {
        patch.appKey = parsed.appKey;
        patch.appSecret = parsed.appSecret;
      }
    }

    if (input.name?.trim()) {
      patch.name = input.name.trim();
    }

    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        yuanbao: {
          dm: { policy: "open" as const, allowFrom: ["*"] },
          ...yuanbaoCfg,
          ...patch,
          enabled: true,
        },
      },
    } as OpenClawConfig;
  },

  validateInput: ({ cfg, input }: { cfg: OpenClawConfig; input: { token?: string } }) => {
    const yuanbaoCfg = cfg.channels?.yuanbao as YuanbaoConfig | undefined;
    const alreadyConfigured = Boolean(yuanbaoCfg?.appKey?.trim() && yuanbaoCfg?.appSecret?.trim());

    if (!input.token?.trim()) {
      if (!alreadyConfigured) {
        return 'Yuanbao requires credentials. Use --token "appKey:appSecret" (colon-separated).';
      }
      return null;
    }

    const parsed = parseAppKeySecretToken(input.token.trim());
    if (!parsed) {
      return 'Invalid token format. Use --token "appKey:appSecret" (colon-separated, both parts non-empty).';
    }
    return null;
  },
};
