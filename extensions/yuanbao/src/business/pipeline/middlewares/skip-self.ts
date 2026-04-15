/**
 * Middleware: skip bot self messages
 */

import type { MiddlewareDescriptor } from "../types.js";

export const skipSelf: MiddlewareDescriptor = {
  name: "skip-self",
  handler: async (ctx, next) => {
    if (ctx.fromAccount === ctx.account.botId) {
      ctx.log.info(`[skip-self] skipping bot self message <- ${ctx.fromAccount}`);
      return; // 终止管线
    }
    await next();
  },
};
