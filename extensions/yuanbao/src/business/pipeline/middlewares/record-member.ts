/**
 * Middleware: record group member info for AI tool queries.
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
