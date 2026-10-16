import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";

export function mediaResult(mediaUrl: string, audioAsVoice?: boolean): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: "Generated media reply." }],
    details: {
      media: {
        mediaUrl,
        ...(audioAsVoice === true ? { audioAsVoice: true } : {}),
      },
    },
  };
}

export function textToolResult(text: string, details: unknown = {}): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}
