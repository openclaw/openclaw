import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { TSchema } from "typebox";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayToolPolicyConfig } from "../config/types.tools.js";
import { copyAgentToolMetadata, isGatewayToolPolicyControl } from "./agent-tool-metadata.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { isCodeModeControlTool } from "./code-mode-control-tools.js";
import { ToolAuthorizationError } from "./tool-input-error.js";
import { normalizeToolPolicyName } from "./tool-policy-shared.js";

type GatewayToolPolicyTarget = { name: string; parameters: unknown };

function isExecutableTool(tool: GatewayToolPolicyTarget): tool is AnyAgentTool {
  return (
    "execute" in tool &&
    typeof tool.execute === "function" &&
    "label" in tool &&
    "description" in tool
  );
}

function policyActions(policy: GatewayToolPolicyConfig, name: string): string[] | undefined {
  const lists = Object.entries(policy.actions ?? {})
    .filter(([key]) => normalizeToolPolicyName(key) === name)
    .map(([, actions]) => actions);
  // Alias spellings cannot grant more than the canonical entry.
  return lists.length
    ? lists.reduce((result, next) => result.filter((action) => next.includes(action)))
    : undefined;
}

function hasAction(schema: unknown): boolean {
  if (!isRecord(schema)) {
    return false;
  }
  return (
    Boolean(isRecord(schema.properties) && schema.properties.action) ||
    [schema.anyOf, schema.oneOf, schema.allOf].some(
      (variants) =>
        Array.isArray(variants) &&
        variants.some((variant) => isRecord(variant) && hasAction(variant)),
    )
  );
}

function narrowActions(
  tool: GatewayToolPolicyTarget,
  actions: readonly string[],
): TSchema | undefined {
  const schema = tool.parameters;
  const refusal = `Gateway tool policy requires ${tool.name} to declare a top-level string action field.`;
  if (isRecord(schema) && Array.isArray(schema.anyOf)) {
    // Union-parameter tools (variants each declare a literal action) keep only the
    // members the policy allows. A member whose action is missing or carries neither
    // const nor enum cannot be narrowed, so it keeps the same refusal.
    const anyOf = schema.anyOf.flatMap((variant) => {
      if (!isRecord(variant) || !isRecord(variant.properties)) {
        throw new Error(refusal);
      }
      const action = variant.properties.action;
      if (!isRecord(action)) {
        throw new Error(refusal);
      }
      const values = Array.isArray(action.enum)
        ? action.enum.filter((value): value is string => typeof value === "string")
        : typeof action.const === "string"
          ? [action.const]
          : [];
      if (!values.length) {
        throw new Error(refusal);
      }
      return values.some((value) => actions.includes(value)) ? [variant] : [];
    });
    return anyOf.length ? { ...schema, anyOf } : undefined;
  }
  const properties = isRecord(schema) ? schema.properties : undefined;
  const action = isRecord(properties) ? properties.action : undefined;
  if (
    !isRecord(schema) ||
    !isRecord(properties) ||
    !isRecord(action) ||
    action.type !== "string" ||
    action.anyOf ||
    action.oneOf ||
    action.allOf
  ) {
    throw new Error(refusal);
  }
  const allowed = actions.filter(
    (value) =>
      (!Array.isArray(action.enum) || action.enum.includes(value)) &&
      (action.const === undefined || action.const === value),
  );
  if (!allowed.length) {
    return undefined;
  }
  const actionSchema: Record<string, unknown> = { ...action, enum: allowed };
  delete actionSchema.default;
  return {
    ...schema,
    properties: { ...properties, action: actionSchema },
    required: [...new Set([...(Array.isArray(schema.required) ? schema.required : []), "action"])],
  };
}

function toolAllowed(policy: GatewayToolPolicyConfig, name: string): boolean {
  return policy.allow.some((entry) => normalizeToolPolicyName(entry) === name);
}

/** Query the execution contract for tools such as exec that have no action argument. */
export function isGatewayToolAllowedWithoutAction(
  toolName: string,
  config: OpenClawConfig | undefined = getRuntimeConfigSnapshot() ?? undefined,
): boolean {
  const policy = config?.tools?.gatewayPolicy;
  const name = normalizeToolPolicyName(toolName);
  return !policy || (toolAllowed(policy, name) && policyActions(policy, name) === undefined);
}

/** Capture the deployment policy when constructing the tool executor. */
export function createGatewayToolPolicyAssertion(
  tool: GatewayToolPolicyTarget,
  config: OpenClawConfig | undefined = getRuntimeConfigSnapshot() ?? undefined,
) {
  const policy = config?.tools?.gatewayPolicy;
  return (args: unknown): void => {
    if (!policy || isGatewayToolPolicyControl(tool) || isCodeModeControlTool(tool)) {
      return;
    }
    const name = normalizeToolPolicyName(tool.name);
    if (!toolAllowed(policy, name)) {
      throw new ToolAuthorizationError(`Gateway tool policy denies tool "${name}".`);
    }
    const actions = policyActions(policy, name);
    if (!hasAction(tool.parameters) && actions === undefined) {
      return;
    }
    const action =
      isRecord(args) && typeof args.action === "string" ? args.action.trim() : undefined;
    if (!action || !actions?.includes(action)) {
      throw new ToolAuthorizationError(
        `Gateway tool policy denies ${name} action "${action ?? "<missing>"}".`,
      );
    }
  };
}

/** Apply the deployment policy after ordinary tool and plugin grants. */
export function applyGatewayToolPolicy<T extends GatewayToolPolicyTarget>(
  tools: T[],
  config: OpenClawConfig | undefined = getRuntimeConfigSnapshot() ?? undefined,
): T[] {
  const policy = config?.tools?.gatewayPolicy;
  if (!policy) {
    return tools;
  }
  return tools.flatMap((tool) => {
    if (isGatewayToolPolicyControl(tool) || isCodeModeControlTool(tool)) {
      return [tool];
    }
    const name = normalizeToolPolicyName(tool.name);
    if (!toolAllowed(policy, name)) {
      return [];
    }
    const actions = policyActions(policy, name);
    if (hasAction(tool.parameters) && actions === undefined) {
      throw new Error(`Gateway tool policy requires tools.gatewayPolicy.actions.${name}.`);
    }
    if (actions === undefined) {
      return [tool];
    }
    if (!actions.length) {
      return [];
    }
    const parameters = narrowActions(tool, actions);
    if (!parameters) {
      return [];
    }
    return [
      isExecutableTool(tool)
        ? copyAgentToolMetadata(tool, { ...tool, parameters })
        : { ...tool, parameters },
    ];
  });
}
