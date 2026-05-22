import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { parseSlackBlocksInput } from "./blocks-input.js";
import { type OpenClawConfig } from "./runtime-api.js";
export declare const slackActionRuntime: {
    deleteSlackMessage: typeof import("./actions.ts").deleteSlackMessage;
    downloadSlackFile: typeof import("./actions.ts").downloadSlackFile;
    editSlackMessage: typeof import("./actions.ts").editSlackMessage;
    getSlackMemberInfo: typeof import("./actions.ts").getSlackMemberInfo;
    listSlackEmojis: typeof import("./actions.ts").listSlackEmojis;
    listSlackPins: typeof import("./actions.ts").listSlackPins;
    listSlackReactions: typeof import("./actions.ts").listSlackReactions;
    parseSlackBlocksInput: typeof parseSlackBlocksInput;
    pinSlackMessage: typeof import("./actions.ts").pinSlackMessage;
    reactSlackMessage: typeof import("./actions.ts").reactSlackMessage;
    readSlackMessages: typeof import("./actions.ts").readSlackMessages;
    removeOwnSlackReactions: typeof import("./actions.ts").removeOwnSlackReactions;
    removeSlackReaction: typeof import("./actions.ts").removeSlackReaction;
    sendSlackMessage: typeof import("./actions.ts").sendSlackMessage;
    unpinSlackMessage: typeof import("./actions.ts").unpinSlackMessage;
};
export type SlackActionContext = {
    /** Current channel ID for auto-threading. */
    currentChannelId?: string;
    /** Current thread timestamp for auto-threading. */
    currentThreadTs?: string;
    /** Reply-to mode for auto-threading. */
    replyToMode?: "off" | "first" | "all" | "batched";
    /** Mutable ref to track if a reply was sent for single-use reply modes. */
    hasRepliedRef?: {
        value: boolean;
    };
    /** True when same-channel root posting would leak a thread-originated reply. */
    sameChannelThreadRequired?: boolean;
    /** Allowed local media directories for file uploads. */
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
};
export declare function handleSlackAction(params: Record<string, unknown>, cfg: OpenClawConfig, context?: SlackActionContext): Promise<AgentToolResult<unknown>>;
