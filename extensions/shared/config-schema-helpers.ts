import type { z } from "zod";

type RequireOpenAllowFromFn = (params: {
  policy: unknown;
  allowFrom: unknown;
  ctx: z.RefinementCtx;
  path: string[];
  message: string;
}) => void;

export function requireChannelOpenAllowFrom(params: {
  channel: string;
  policy: unknown;
  allowFrom: unknown;
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
