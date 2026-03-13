import type { MsgContext } from "../../auto-reply/templating.js";
import type { GroupKeyResolution } from "./types.js";
export declare function buildGroupDisplayName(params: {
    provider?: string;
    subject?: string;
    groupChannel?: string;
    space?: string;
    id?: string;
    key: string;
}): string;
export declare function resolveGroupSessionKey(ctx: MsgContext): GroupKeyResolution | null;
