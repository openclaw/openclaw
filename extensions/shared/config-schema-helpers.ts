import type { z } from "zod";

type RequireOpenAllowFromFn = (params: {
  policy?: string;
  allowFrom?: Array<string | number>;
  ctx: z.RefinementCtx;
  path: Array<string | number>;
  message: string;
}) => void;

export function requireChannelOpenAllowFrom(params: {
  channel: string;
  policy?: string;
  allowFrom?: Array<string | number>;
  ctx: z.RefinementCtx;
  requireOpenAllowFrom: RequireOpenAllowFromFn;
}) {
  params.requireOpenAllowFrom({
    policy: params.policy,
    allowFrom: params.allowFrom,
    ctx: params.ctx,
    path: ["allowFrom"],
    message: `channels.${params.channel}.dmPolicy="open" requires channels.${params.channel}.allowFrom to include "*"`,
  });
}
