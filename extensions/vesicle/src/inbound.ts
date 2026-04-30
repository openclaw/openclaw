import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import { handleVesicleInboundMessage } from "./inbound-core.js";
import { getVesicleRuntime } from "./runtime.js";
import { sendMessageVesicle } from "./send.js";
import type { ResolvedVesicleAccount, VesicleInboundMessage } from "./types.js";

export async function handleVesicleInbound(params: {
  account: ResolvedVesicleAccount;
  config: OpenClawConfig;
  message: VesicleInboundMessage;
}): Promise<void> {
  await handleVesicleInboundMessage({
    ...params,
    runtime: getVesicleRuntime(),
    dispatchInboundReplyWithBase,
    sendText: async ({ to, text }) => {
      await sendMessageVesicle(to, text, {
        cfg: params.config,
        accountId: params.account.accountId,
      });
    },
  });
}
