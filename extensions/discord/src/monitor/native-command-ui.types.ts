import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { DiscordLivePolicyReader } from "./live-policy.js";
import type {
  DiscordBuildInboundContext,
  DiscordConfig,
  DiscordDispatchReplyFromConfig,
} from "./native-command.types.js";
import type { ThreadBindingManager } from "./thread-bindings.js";

export type DiscordCommandArgContext = {
  readPolicy?: DiscordLivePolicyReader;
  cfg: OpenClawConfig;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionPrefix: string;
  threadBindings: ThreadBindingManager;
  buildContext?: DiscordBuildInboundContext;
  dispatchReplyFromConfig?: DiscordDispatchReplyFromConfig;
  postApplySettleMs?: number;
};

export type SafeDiscordInteractionCall = <T>(
  label: string,
  fn: () => Promise<T>,
) => Promise<T | null>;
