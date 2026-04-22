import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { CreateAgentSessionOptions } from "@mariozechner/pi-coding-agent";
import { collectAllowedToolNames, toSessionToolAllowlist } from "../tool-name-allowlist.js";
import { splitSdkTools } from "../tool-split.js";
import type { ClientToolDefinition } from "./params.js";

export type EmbeddedAgentSessionOptions = {
  cwd: string;
  agentDir: string;
  authStorage: unknown;
  modelRegistry: unknown;
  model: unknown;
  thinkingLevel: unknown;
  tools: NonNullable<CreateAgentSessionOptions["tools"]>;
  customTools: NonNullable<CreateAgentSessionOptions["customTools"]>;
  sessionManager: unknown;
  settingsManager: unknown;
  resourceLoader: unknown;
};

export function resolveEmbeddedAgentSessionToolOptions(params: {
  tools: AgentTool[];
  clientTools?: ClientToolDefinition[];
  sandboxEnabled: boolean;
}): Pick<EmbeddedAgentSessionOptions, "tools" | "customTools"> {
  const { customTools } = splitSdkTools({
    tools: params.tools,
    sandboxEnabled: params.sandboxEnabled,
  });
  return {
    // Pi's `tools` option is the active tool-name allowlist. OpenClaw still
    // registers the actual implementations through `customTools`, so we must
    // pass the matching names here or the SDK silently disables those tools.
    tools: toSessionToolAllowlist(
      collectAllowedToolNames({
        tools: params.tools,
        clientTools: params.clientTools,
      }),
    ),
    customTools,
  };
}

export async function createEmbeddedAgentSessionWithResourceLoader<Result>(params: {
  createAgentSession: (options: EmbeddedAgentSessionOptions) => Promise<Result> | Result;
  options: EmbeddedAgentSessionOptions;
}): Promise<Result> {
  return await params.createAgentSession(params.options);
}
