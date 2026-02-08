import type { AgentTool } from "@mariozechner/pi-agent-core";
import { toToolDefinitions } from "../pi-tool-definition-adapter.js";

type AnyAgentTool = AgentTool;

function isOpenAiCompletionsToolsEnabled(options: {
  modelApi?: string;
  openaiCompletionsTools?: boolean;
}): boolean {
  return options.modelApi === "openai-completions" && options.openaiCompletionsTools === true;
}

export function splitSdkTools(options: {
  tools: AnyAgentTool[];
  sandboxEnabled: boolean;
  modelApi?: string;
  openaiCompletionsTools?: boolean;
}): {
  builtInTools: AnyAgentTool[];
  customTools: ReturnType<typeof toToolDefinitions>;
} {
  const { tools } = options;
  // Default behavior: route all tools through `customTools` so our policy filtering,
  // sandbox integration, and extended toolset remain consistent across providers.
  //
  // Some OpenAI-compatible servers (notably local vLLM) only support tool calling on
  // /v1/chat/completions when tools are passed via the SDK tool path.
  if (isOpenAiCompletionsToolsEnabled(options)) {
    return {
      builtInTools: tools,
      customTools: [],
    };
  }
  return {
    builtInTools: [],
    customTools: toToolDefinitions(tools),
  };
}
