import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import {
  type ProviderCapabilityLookupOptions,
  requiresOpenAiCompatibleAnthropicToolPayload,
  usesOpenAiFunctionAnthropicToolSchema,
  usesOpenAiStringModeAnthropicToolChoice,
} from "../provider-capabilities.js";

type AnthropicToolPayloadResolverOptions = ProviderCapabilityLookupOptions;

function hasOpenAiAnthropicToolPayloadCompatFlag(model: { compat?: unknown }): boolean {
  if (!model.compat || typeof model.compat !== "object" || Array.isArray(model.compat)) {
    return false;
  }

  return (
    (model.compat as { requiresOpenAiAnthropicToolPayload?: unknown })
      .requiresOpenAiAnthropicToolPayload === true
  );
}

function requiresAnthropicToolPayloadCompatibilityForModel(
  model: {
    api?: unknown;
    provider?: unknown;
    compat?: unknown;
  },
  options?: AnthropicToolPayloadResolverOptions,
): boolean {
  if (model.api !== "anthropic-messages") {
    return false;
  }

  if (
    typeof model.provider === "string" &&
    requiresOpenAiCompatibleAnthropicToolPayload(model.provider, options)
  ) {
    return true;
  }
  return hasOpenAiAnthropicToolPayloadCompatFlag(model);
}

function usesOpenAiFunctionAnthropicToolSchemaForModel(
  model: {
    provider?: unknown;
    compat?: unknown;
  },
  options?: AnthropicToolPayloadResolverOptions,
): boolean {
  if (
    typeof model.provider === "string" &&
    usesOpenAiFunctionAnthropicToolSchema(model.provider, options)
  ) {
    return true;
  }
  return hasOpenAiAnthropicToolPayloadCompatFlag(model);
}

function usesOpenAiStringModeAnthropicToolChoiceForModel(
  model: {
    provider?: unknown;
    compat?: unknown;
  },
  options?: AnthropicToolPayloadResolverOptions,
): boolean {
  if (
    typeof model.provider === "string" &&
    usesOpenAiStringModeAnthropicToolChoice(model.provider, options)
  ) {
    return true;
  }
  return hasOpenAiAnthropicToolPayloadCompatFlag(model);
}

function normalizeOpenAiFunctionAnthropicToolDefinition(
  tool: unknown,
): Record<string, unknown> | undefined {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
    return undefined;
  }

  const toolObj = tool as Record<string, unknown>;
  if (toolObj.function && typeof toolObj.function === "object") {
    return toolObj;
  }

  const rawName = typeof toolObj.name === "string" ? toolObj.name.trim() : "";
  if (!rawName) {
    return toolObj;
  }

  const functionSpec: Record<string, unknown> = {
    name: rawName,
    parameters:
      toolObj.input_schema && typeof toolObj.input_schema === "object"
        ? toolObj.input_schema
        : toolObj.parameters && typeof toolObj.parameters === "object"
          ? toolObj.parameters
          : { type: "object", properties: {} },
  };

  if (typeof toolObj.description === "string" && toolObj.description.trim()) {
    functionSpec.description = toolObj.description;
  }
  if (typeof toolObj.strict === "boolean") {
    functionSpec.strict = toolObj.strict;
  }

  return {
    type: "function",
    function: functionSpec,
  };
}

function normalizeOpenAiStringModeAnthropicToolChoice(toolChoice: unknown): unknown {
  if (!toolChoice || typeof toolChoice !== "object" || Array.isArray(toolChoice)) {
    return toolChoice;
  }

  const choice = toolChoice as Record<string, unknown>;
  if (choice.type === "auto") {
    return "auto";
  }
  if (choice.type === "none") {
    return "none";
  }
  if (choice.type === "required" || choice.type === "any") {
    return "required";
  }
  if (choice.type === "tool" && typeof choice.name === "string" && choice.name.trim()) {
    return {
      type: "function",
      function: { name: choice.name.trim() },
    };
  }

  return toolChoice;
}

export function createAnthropicToolPayloadCompatibilityWrapper(
  baseStreamFn: StreamFn | undefined,
  resolverOptions?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
  },
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, streamOptions) => {
    const originalOnPayload = streamOptions?.onPayload;
    return underlying(model, context, {
      ...streamOptions,
      onPayload: (payload) => {
        if (
          payload &&
          typeof payload === "object" &&
          requiresAnthropicToolPayloadCompatibilityForModel(model, {
            config: resolverOptions?.config,
            workspaceDir: resolverOptions?.workspaceDir,
            env: resolverOptions?.env,
          })
        ) {
          const payloadObj = payload as Record<string, unknown>;
          if (
            Array.isArray(payloadObj.tools) &&
            usesOpenAiFunctionAnthropicToolSchemaForModel(model, {
              config: resolverOptions?.config,
              workspaceDir: resolverOptions?.workspaceDir,
              env: resolverOptions?.env,
            })
          ) {
            payloadObj.tools = payloadObj.tools
              .map((tool) => normalizeOpenAiFunctionAnthropicToolDefinition(tool))
              .filter((tool): tool is Record<string, unknown> => !!tool);
          }
          if (
            usesOpenAiStringModeAnthropicToolChoiceForModel(model, {
              config: resolverOptions?.config,
              workspaceDir: resolverOptions?.workspaceDir,
              env: resolverOptions?.env,
            })
          ) {
            payloadObj.tool_choice = normalizeOpenAiStringModeAnthropicToolChoice(
              payloadObj.tool_choice,
            );
          }
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}
