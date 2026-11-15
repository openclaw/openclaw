import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export type TelegramChannelConfig = NonNullable<
  NonNullable<OpenClawConfig["channels"]>["telegram"]
>;

export function makeTelegramConfig(
  telegram: TelegramChannelConfig,
  config: Omit<OpenClawConfig, "channels"> = {},
): OpenClawConfig {
  return {
    ...config,
    messages: {
      ...config.messages,
      inbound: { debounceMs: 0, ...config.messages?.inbound },
    },
    channels: { telegram },
  };
}

export function makeDirectTelegramConfig(
  storePath: string,
  telegramOverrides: TelegramChannelConfig = {},
): OpenClawConfig {
  return makeTelegramConfig(
    { dmPolicy: "open", allowFrom: ["*"], ...telegramOverrides },
    { session: { store: storePath } },
  );
}
