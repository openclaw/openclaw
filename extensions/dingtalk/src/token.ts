import type { DingTalkConfig } from "openclaw/plugin-sdk";

export type DingTalkCredentials = {
  appKey: string;
  appSecret: string;
};

export function resolveDingTalkCredentials(
  cfg?: DingTalkConfig,
): DingTalkCredentials | undefined {
  const appKey = cfg?.appKey?.trim() || process.env.DINGTALK_APP_KEY?.trim();
  const appSecret = cfg?.appSecret?.trim() || process.env.DINGTALK_APP_SECRET?.trim();

  if (!appKey || !appSecret) {
    return undefined;
  }

  return { appKey, appSecret };
}
