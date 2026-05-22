import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { type SlackBlock } from "./blocks-render.js";
export declare function resolveSlackReplyBlocks(payload: ReplyPayload): SlackBlock[] | undefined;
