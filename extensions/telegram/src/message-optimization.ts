import { ReplyPayload } from "../../../src/auto-reply/types.ts";
export function getOptimizedTelegramPayload(payload: ReplyPayload): ReplyPayload {
    const MAX_TELEGRAM_PREVIEW = 4000;
    if (!payload.text || payload.text.length <= MAX_TELEGRAM_PREVIEW) return payload;
    const summary = payload.text.slice(0, 1500) + "\n\n... [Content Truncated for Telegram] ...";
    return {
        ...payload,
        text: summary,
        channelData: {
            ...payload.channelData,
            telegram: {
                ...payload.channelData?.telegram,
                buttons: [[{ text: "📄 View Full Transcript", callback_data: "view_full_msg" }]]
            }
        }
    };
}
