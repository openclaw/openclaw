export type ToolCallShapedTextDetection = {
    kind: "json_tool_call" | "xml_tool_call" | "bracketed_tool_call" | "react_action";
    toolName?: string;
};
export declare function detectToolCallShapedText(text: string): ToolCallShapedTextDetection | null;
