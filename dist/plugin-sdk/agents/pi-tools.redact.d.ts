import type { AnyAgentTool } from "./pi-tools.types.js";
export declare function redactToolResult<T>(result: T): T;
export declare function wrapToolWithResultRedaction(tool: AnyAgentTool): AnyAgentTool;
