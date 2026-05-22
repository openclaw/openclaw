import type { SessionEntry } from "../../config/sessions/types.js";
import type { ReplyPayload } from "../types.js";
import type { HandleCommandsParams } from "./commands-types.js";
export interface ExportCommandSessionTarget {
    entry: SessionEntry;
    sessionFile: string;
}
export declare function parseExportCommandOutputPath(commandBodyNormalized: string, aliases: readonly string[]): {
    outputPath?: string;
    error?: string;
};
export declare function resolveExportCommandSessionTarget(params: HandleCommandsParams): ExportCommandSessionTarget | ReplyPayload;
export declare function isReplyPayload(value: ExportCommandSessionTarget | ReplyPayload): value is ReplyPayload;
