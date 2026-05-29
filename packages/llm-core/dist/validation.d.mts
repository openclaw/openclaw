import { Tool, ToolCall } from "./types.mjs";

//#region packages/llm-core/src/validation.d.ts
declare function validateToolCall(tools: Tool[], toolCall: ToolCall): unknown;
declare function validateToolArguments(tool: Tool, toolCall: ToolCall): unknown;
//#endregion
export { validateToolArguments, validateToolCall };