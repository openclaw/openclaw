import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { buildOutboundSessionContext } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

type TelegramActionDeliveryOptions = {
  mediaAccess?: ChannelMessageActionContext["mediaAccess"];
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  sessionKey?: string | null;
  agentId?: string | null;
};

/** Host-owned media access and outbound session for an action send. */
export function resolveTelegramActionDelivery(params: {
  cfg: OpenClawConfig;
  options?: TelegramActionDeliveryOptions;
  accountId?: string;
}) {
  const { cfg, options, accountId } = params;
  const mediaAccess =
    options?.mediaAccess ??
    (options?.mediaLocalRoots || options?.mediaReadFile
      ? {
          ...(options.mediaLocalRoots ? { localRoots: options.mediaLocalRoots } : {}),
          ...(options.mediaReadFile ? { readFile: options.mediaReadFile } : {}),
        }
      : undefined);
  // Without a session key the selected agent is the only owner a media send can stage under.
  const outboundSession = buildOutboundSessionContext({
    cfg,
    sessionKey: options?.sessionKey,
    agentId: options?.agentId,
    requesterAccountId: accountId,
  });
  return { mediaAccess, outboundSession };
}
