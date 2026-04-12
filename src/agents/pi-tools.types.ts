import type { 
  AgentTool, 
  AgentToolResult as CoreAgentToolResult, 
  AgentToolUpdateCallback
} from "@mariozechner/pi-agent-core";

// Use `any` for the schema type to bypass the constraint
export type AnyAgentTool<TDetails = any> = AgentTool<any, TDetails>;

export type AgentToolResult<TDetails = any> = CoreAgentToolResult<TDetails>;

// Your working content block types
export type ImageContentBlock = {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
};

export type TextContentBlock = {
  type: "text";
  text: string;
};

export type ToolContentBlock = ImageContentBlock | TextContentBlock;

export type { AgentToolUpdateCallback };