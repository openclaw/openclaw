import type { BuildStatusTextParams } from "../../status/status-text.types.js";
import type { ReplyPayload } from "../types.js";
import type { CommandContext } from "./commands-types.js";
export { buildStatusText } from "../../status/status-text.js";
type BuildStatusReplyParams = Omit<BuildStatusTextParams, "statusChannel"> & {
    command: CommandContext;
};
export declare function buildStatusReply(params: BuildStatusReplyParams): Promise<ReplyPayload | undefined>;
