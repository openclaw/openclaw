import { type ToolErrorSummary } from "../tool-error-summary.js";
import type { EmbeddedRunFailureSignal } from "./types.js";
export declare function resolveEmbeddedRunFailureSignal(params: {
    trigger?: string | undefined;
    lastToolError?: ToolErrorSummary | undefined;
}): EmbeddedRunFailureSignal | undefined;
