import type { JsonObject, ToolPlanEntry } from "./types.js";
export type ToolProtocolDescriptor = {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: JsonObject;
};
export declare function toToolProtocolDescriptor(entry: ToolPlanEntry): ToolProtocolDescriptor;
export declare function toToolProtocolDescriptors(entries: readonly ToolPlanEntry[]): readonly ToolProtocolDescriptor[];
