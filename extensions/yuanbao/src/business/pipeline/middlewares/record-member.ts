/**
 * Middleware: record group member info
 *
 * 记录群消息中出现的用户信息，供 AI tool 查询。
 * Only effective in group chat scenarios.
 */

import { getMember } from "../../../infra/cache/member.js";
import type { MiddlewareDescriptor } from "../types.js";

export const recordMember: MiddlewareDescriptor = {
  name: "record-member",
  when: (ctx) => ctx.isGroup,
  handler: async (ctx, next) => {
    getMember(ctx.account.accountId).recordUser(
      ctx.groupCode!,
      ctx.fromAccount,
      ctx.senderNickname || ctx.fromAccount,
    );
    await next();
  },
};
