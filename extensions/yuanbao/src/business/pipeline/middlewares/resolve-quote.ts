/**
 * Middleware: parse quote message info from cloud_custom_data.
 */

import { parseQuoteFromCloudCustomData } from "../../messaging/quote.js";
import type { MiddlewareDescriptor } from "../types.js";

export const resolveQuote: MiddlewareDescriptor = {
  name: "resolve-quote",
  handler: async (ctx, next) => {
    const quoteInfo = parseQuoteFromCloudCustomData(ctx.raw.cloud_custom_data);

    if (quoteInfo) {
      ctx.quoteInfo = quoteInfo;
      ctx.log.info(
        `[resolve-quote] detected quote message, quoted from: ${quoteInfo.sender_nickname || quoteInfo.sender_id || "unknown"}`,
      );
      ctx.log.debug("[resolve-quote] quote content", { quote: quoteInfo.desc || "" });
    }

    await next();
  },
};
