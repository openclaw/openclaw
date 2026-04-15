/**
 * 中间件：Agent Route resolution
 *
 * 使用 SDK 官方 resolveAgentRoute + resolveInboundSessionEnvelopeContext
 * 解析路由、storePath、envelopeOptions、previousTimestamp。
 */

import { resolveInboundSessionEnvelopeContext } from "openclaw/plugin-sdk/channel-inbound";
import type { MiddlewareDescriptor } from "../types.js";

export const resolveRoute: MiddlewareDescriptor = {
  name: "resolve-route",
  handler: async (ctx, next) => {
    const { core, config, account, isGroup, fromAccount, groupCode } = ctx;

    const route = core.channel.routing.resolveAgentRoute({
      cfg: config,
      channel: "yuanbao",
      accountId: account.accountId,
      peer: isGroup ? { kind: "group", id: groupCode! } : { kind: "direct", id: fromAccount },
    });

    ctx.route = route;

    // 使用 SDK 官方 API 解析 storePath + envelopeOptions + previousTimestamp
    const { storePath, envelopeOptions, previousTimestamp } = resolveInboundSessionEnvelopeContext({
      cfg: config,
      agentId: route.agentId,
      sessionKey: route.sessionKey,
    });

    ctx.storePath = storePath;
    ctx.envelopeOptions = envelopeOptions;
    ctx.previousTimestamp = previousTimestamp;

    ctx.log.debug(
      `[resolve-route] route resolved, agentId=${route.agentId}, sessionKey=${route.sessionKey}`,
    );

    await next();
  },
};
