import {
  applyEmbeddedAttemptToolsAllow,
  HEARTBEAT_RESPONSE_TOOL_NAME,
  normalizeHeartbeatToolResponse,
  type AnyAgentTool,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { Type } from "typebox";
import type { CodexPluginConfig } from "./config.js";
import type { CodexToolDescriptor } from "./dynamic-tool-catalog.js";
import { filterCodexDynamicTools } from "./dynamic-tool-profile.js";
import { flattenCodexDynamicToolFunctions, type CodexDynamicToolSpec } from "./protocol.js";

type InactiveCodexHeartbeatResponseDescriptor = Pick<CodexToolDescriptor, "name" | "description">;

const InactiveHeartbeatResponseParameters = Type.Object({}, { additionalProperties: true });

export function resolveInactiveCodexHeartbeatResponseDescriptor(params: {
  registeredTools: readonly CodexToolDescriptor[];
  registeredSpecs?: readonly CodexDynamicToolSpec[];
}): InactiveCodexHeartbeatResponseDescriptor | undefined {
  const descriptors = params.registeredSpecs
    ? flattenCodexDynamicToolFunctions(params.registeredSpecs)
    : params.registeredTools;
  const descriptor = descriptors.find((tool) => tool.name === HEARTBEAT_RESPONSE_TOOL_NAME);
  return descriptor ? { name: descriptor.name, description: descriptor.description } : undefined;
}

/** Keeps the thread-stable heartbeat endpoint executable on ordinary Codex turns. */
function createInactiveCodexHeartbeatResponseTool(
  descriptor: InactiveCodexHeartbeatResponseDescriptor,
): AnyAgentTool {
  if (descriptor.name !== HEARTBEAT_RESPONSE_TOOL_NAME) {
    throw new Error(`Expected ${HEARTBEAT_RESPONSE_TOOL_NAME}, received ${descriptor.name}`);
  }
  return {
    name: descriptor.name,
    label: descriptor.name,
    description: descriptor.description,
    // The inherited thread declaration remains authoritative. This executor only
    // needs an object boundary before the shared heartbeat normalizer runs.
    parameters: InactiveHeartbeatResponseParameters,
    execute: async (_toolCallId, args) => {
      const response = normalizeHeartbeatToolResponse(args);
      if (!response) {
        throw new Error(
          "Invalid heartbeat response. Provide outcome, notify, and non-empty summary.",
        );
      }
      if (response.notify) {
        throw new Error("heartbeat_respond cannot send notifications outside a heartbeat turn");
      }
      return {
        content: [
          {
            type: "text" as const,
            text: "No heartbeat is active for this turn. Continue the current task and respond normally.",
          },
        ],
        details: { status: "ignored", reason: "non-heartbeat-turn" },
      };
    },
  };
}

export function selectInactiveCodexHeartbeatResponseTool(params: {
  descriptor: InactiveCodexHeartbeatResponseDescriptor;
  disableTools?: boolean;
  toolsAllow?: string[];
  pluginConfig: Pick<CodexPluginConfig, "codexDynamicToolsExclude">;
}): AnyAgentTool | undefined {
  if (params.disableTools) {
    return undefined;
  }
  const allowed = applyEmbeddedAttemptToolsAllow(
    [createInactiveCodexHeartbeatResponseTool(params.descriptor)],
    params.toolsAllow,
  );
  return filterCodexDynamicTools(allowed, params.pluginConfig)[0];
}
