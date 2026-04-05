import { requireOpenAllowFrom } from "mullusi/plugin-sdk/channel-config-primitives";
import type { z } from "mullusi/plugin-sdk/zod";

export function requireChannelOpenAllowFrom(params: {
  channel: string;
  policy?: string;
  allowFrom?: Array<string | number>;
  ctx: z.RefinementCtx;
}) {
  requireOpenAllowFrom({
    policy: params.policy,
    allowFrom: params.allowFrom,
    ctx: params.ctx,
    path: ["allowFrom"],
    message: `channels.${params.channel}.dmPolicy="open" requires channels.${params.channel}.allowFrom to include "*"`,
  });
}
