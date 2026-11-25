import { projectRuntimeToolInputSchema } from "openclaw/plugin-sdk/agent-harness-runtime";
import { applyGatewayToolPolicy } from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  type JsonSchemaObject,
  validateJsonSchemaValue,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { normalizeOpenAIStrictCompatSchema } from "openclaw/plugin-sdk/provider-tools";
import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexDynamicToolsLoading } from "./config.js";
import {
  CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
  type CodexDynamicToolFunctionSpec,
  type CodexDynamicToolSpec,
  type JsonValue,
} from "./protocol.js";

export type CodexToolDescriptor = {
  name: string;
  description: string;
  parameters: unknown;
  catalogMode?: string;
};
export type ProjectedCodexDynamicTool<T extends CodexToolDescriptor> = {
  tool: T;
  name: string;
  description: string;
  inputSchema: JsonSchemaObject & JsonValue;
};
export type CodexDynamicToolSchemaQuarantine = { tool: string; violations: readonly string[] };

const CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE = "openclaw";
const CODEX_DYNAMIC_TOOL_NAME_MAX_CHARS = 128;
const CODEX_DYNAMIC_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/u;

// Keep OpenClaw control-path tools directly callable even when Codex tool_search
// is unavailable or resolves a connector-only universe. Developer instructions
// still steer normal Codex subagents to native spawn_agent.
// sessions_yield is normally routed by its catalogMode "direct-only" before
// this set is consulted; the name entry stays as the metadata-independent
// contract that control-path tools remain directly callable.
const ALWAYS_DIRECT_DYNAMIC_TOOL_NAMES = new Set([
  "agents_list",
  "agents_wait",
  // Native update_plan is disabled on every thread; its replacement must be
  // available in the initial context, including catalogs prepared at creation.
  "progress_card",
  // Native Goals are disabled; core controls must not depend on model tool-search support.
  "get_goal",
  "create_goal",
  "update_goal",
  "sessions_spawn",
  "sessions_yield",
]);
export function createCodexDynamicToolSpecs(params: {
  entries: readonly ProjectedCodexDynamicTool<CodexToolDescriptor>[];
  loading: CodexDynamicToolsLoading;
  directToolNames?: Iterable<string>;
  /** Direct loading still namespaces direct-only tools; SIWC requires plain function specs. */
  functionToolsOnly?: boolean;
}): CodexDynamicToolSpec[] {
  const directToolNames = new Set([
    ...ALWAYS_DIRECT_DYNAMIC_TOOL_NAMES,
    ...(params.directToolNames ?? []),
  ]);
  const specs: CodexDynamicToolSpec[] = [];
  const namespaceTools: CodexDynamicToolFunctionSpec[] = [];
  const directOnlyNamespaceTools: CodexDynamicToolFunctionSpec[] = [];
  // Codex reuses its incremental websocket request only when the complete
  // searchable surface is unchanged. Direct mode retains its compatibility order.
  const entries =
    params.loading === "direct"
      ? params.entries
      : params.entries.toSorted((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const functionSpec: CodexDynamicToolFunctionSpec = {
      type: "function",
      name: entry.name,
      description: entry.description,
      inputSchema: entry.inputSchema,
    };
    if (entry.name === "openclaw" && directToolNames.has(entry.name)) {
      // OpenClaw is ring-zero and its whole turn surface. Keep its canonical
      // root name even though generic direct-only tools use a model namespace.
      specs.push(functionSpec);
      continue;
    }
    if (entry.tool.catalogMode === "direct-only" && !params.functionToolsOnly) {
      directOnlyNamespaceTools.push(functionSpec);
      continue;
    }
    if (params.loading === "direct" || directToolNames.has(entry.name)) {
      specs.push(functionSpec);
      continue;
    }
    namespaceTools.push({ ...functionSpec, deferLoading: true });
  }
  for (const [name, tools] of [
    [CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE, namespaceTools],
    [CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE, directOnlyNamespaceTools],
  ] as const) {
    if (tools.length > 0) {
      specs.push({ type: "namespace", name, description: "", tools });
    }
  }
  return specs;
}

export function projectCodexDynamicTools<T extends CodexToolDescriptor>(
  tools: readonly T[],
  gatewayPolicy?: { config?: OpenClawConfig },
): {
  tools: ProjectedCodexDynamicTool<T>[];
  quarantinedTools: CodexDynamicToolSchemaQuarantine[];
} {
  const projectedTools: ProjectedCodexDynamicTool<T>[] = [];
  const quarantinedTools: CodexDynamicToolSchemaQuarantine[] = [];
  const hasGatewayPolicy = Boolean(
    gatewayPolicy &&
    (gatewayPolicy.config?.tools?.gatewayPolicy ||
      getRuntimeConfigSnapshot()?.tools?.gatewayPolicy),
  );
  for (const [toolIndex, candidate] of tools.entries()) {
    const descriptor = readCodexDynamicToolDescriptor(candidate, toolIndex, hasGatewayPolicy);
    if ("diagnostic" in descriptor) {
      quarantinedTools.push(descriptor.diagnostic);
      continue;
    }
    // Quarantine unreadable descriptors before policy reads them. Policy errors
    // remain fatal, and the concrete tool retains its private control metadata.
    const tool = gatewayPolicy
      ? applyGatewayToolPolicy([candidate], gatewayPolicy.config)[0]
      : candidate;
    if (!tool) {
      continue;
    }
    const parameters = tool === candidate ? descriptor.parameters : tool.parameters;
    const normalizedParameters = normalizeOpenAIStrictCompatSchema(parameters);
    const projection = projectRuntimeToolInputSchema(
      normalizedParameters ?? parameters,
      `${descriptor.name}.inputSchema`,
    );
    if (projection.violations.length > 0) {
      quarantinedTools.push({ tool: descriptor.name, violations: projection.violations });
      continue;
    }
    if (!isRecord(projection.schema)) {
      quarantinedTools.push({
        tool: descriptor.name,
        violations: [`${descriptor.name}.inputSchema must be a JSON object schema`],
      });
      continue;
    }
    projectedTools.push({
      tool,
      name: descriptor.name,
      description: descriptor.description,
      inputSchema: projection.schema,
    });
  }
  return { tools: projectedTools, quarantinedTools };
}

type CodexDynamicToolDescriptorRead =
  | Pick<CodexToolDescriptor, "name" | "description" | "parameters">
  | { diagnostic: CodexDynamicToolSchemaQuarantine };

function readCodexDynamicToolDescriptor(
  tool: CodexToolDescriptor,
  toolIndex: number,
  hasGatewayPolicy: boolean,
): CodexDynamicToolDescriptorRead {
  const fallbackName = `tool[${toolIndex}]`;
  const invalid = (name: string, violation: string): CodexDynamicToolDescriptorRead => ({
    diagnostic: { tool: name, violations: [`${name}.${violation}`] },
  });
  let name: string;
  try {
    const rawName = tool.name;
    if (typeof rawName !== "string" || !rawName) {
      return invalid(fallbackName, "name must be a non-empty string");
    }
    const trimmedName = rawName.trim();
    let nameViolation: string | undefined;
    if (!trimmedName) {
      nameViolation = "name must not be empty";
    } else if (trimmedName !== rawName) {
      nameViolation = "name must not have leading or trailing whitespace";
    } else if (!CODEX_DYNAMIC_TOOL_NAME_PATTERN.test(rawName)) {
      nameViolation = "name must match ^[a-zA-Z0-9_-]+$";
    } else if (rawName.length > CODEX_DYNAMIC_TOOL_NAME_MAX_CHARS) {
      nameViolation = `name must be at most ${CODEX_DYNAMIC_TOOL_NAME_MAX_CHARS} characters`;
    } else if (rawName === "mcp" || rawName.startsWith("mcp__")) {
      nameViolation = "name is reserved by Codex app-server";
    }
    if (nameViolation) {
      return invalid(rawName, nameViolation);
    }
    name = rawName;
  } catch {
    return invalid(fallbackName, "name is unreadable");
  }
  let description: string;
  try {
    description = typeof tool.description === "string" ? tool.description : "";
  } catch {
    return invalid(name, "description is unreadable");
  }
  let parameters: unknown;
  try {
    parameters = tool.parameters;
  } catch {
    return invalid(name, "inputSchema is unreadable");
  }
  if (hasGatewayPolicy) {
    try {
      // Action narrowing copies enumerable metadata and checks the executor.
      // Keep the original object so identity-backed host controls stay intact.
      Object.assign({}, tool);
      if ("execute" in tool) {
        void tool.execute;
      }
    } catch {
      return invalid(name, "metadata is unreadable");
    }
  }
  return { name, description, parameters };
}

const MAX_CODEX_DYNAMIC_TOOL_VALIDATION_ERRORS = 4;
const MAX_CODEX_DYNAMIC_TOOL_VALIDATION_ERROR_CHARS = 160;
const CODEX_DYNAMIC_TOOL_VALIDATION_TRUNCATED_SUFFIX = " [detail truncated]";

export function assertCodexDynamicToolInputMatchesSchema(params: {
  toolName: string;
  schema: JsonSchemaObject;
  value: unknown;
}): void {
  const validation = validateJsonSchemaValue({
    schema: params.schema,
    cacheKey: `codex-dynamic-tool-input:${params.toolName}:${JSON.stringify(params.schema)}`,
    value: params.value,
  });
  if (validation.ok) {
    return;
  }
  const visibleErrors = validation.errors.slice(0, MAX_CODEX_DYNAMIC_TOOL_VALIDATION_ERRORS);
  const details = visibleErrors
    .map((error) => {
      if (error.text.length <= MAX_CODEX_DYNAMIC_TOOL_VALIDATION_ERROR_CHARS) {
        return error.text;
      }
      return `${error.text.slice(
        0,
        MAX_CODEX_DYNAMIC_TOOL_VALIDATION_ERROR_CHARS -
          CODEX_DYNAMIC_TOOL_VALIDATION_TRUNCATED_SUFFIX.length,
      )}${CODEX_DYNAMIC_TOOL_VALIDATION_TRUNCATED_SUFFIX}`;
    })
    .join("; ");
  const omitted = validation.errors.length - visibleErrors.length;
  const omittedSuffix = omitted > 0 ? `; ${omitted} more violation(s) omitted` : "";
  throw new Error(`Invalid arguments for tool "${params.toolName}": ${details}${omittedSuffix}.`);
}
