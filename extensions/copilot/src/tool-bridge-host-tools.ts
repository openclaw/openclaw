import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import type {
  AgentHarnessAttemptParamsV2,
  AnyAgentTool,
} from "openclaw/plugin-sdk/agent-harness-runtime";

type CreateOpenClawCodingTools =
  (typeof import("openclaw/plugin-sdk/agent-harness"))["createOpenClawCodingTools"];
type ToolSurfaceOptions = NonNullable<Parameters<CreateOpenClawCodingTools>[0]>;

export async function createCopilotHostToolSurface(params: {
  bindingOptions?: Readonly<{ cwd?: string }>;
  factory?: (
    options?: ToolSurfaceOptions,
  ) => ReturnType<CreateOpenClawCodingTools> | Promise<ReturnType<CreateOpenClawCodingTools>>;
  hostCapabilities: NonNullable<AgentHarnessAttemptParamsV2["hostCapabilities"]>;
  options: ToolSurfaceOptions;
}): Promise<AnyAgentTool[]> {
  const createToolSurface = params.hostCapabilities.createToolSurface;
  if (createToolSurface) {
    const tools = createToolSurface(params.options, params.bindingOptions);
    if (!Array.isArray(tools)) {
      throw new Error("createOpenClawCodingTools must return an array of tools");
    }
    return tools;
  }

  // Compatibility for published hosts through 2026.9.2. Remove once the
  // Copilot plugin's minHostVersion advances beyond that stable release.
  const tools = await (params.factory ?? createOpenClawCodingTools)(params.options);
  if (!Array.isArray(tools)) {
    throw new Error("createOpenClawCodingTools must return an array of tools");
  }
  return params.hostCapabilities.bindToolSurface(tools, params.bindingOptions);
}

export function bindNewCopilotTools(params: {
  bindingOptions?: Readonly<{ cwd?: string }>;
  compactedTools: readonly AnyAgentTool[];
  hostCapabilities: NonNullable<AgentHarnessAttemptParamsV2["hostCapabilities"]>;
  previouslyBound: ReadonlySet<AnyAgentTool>;
}): AnyAgentTool[] {
  const fresh = params.compactedTools.filter((tool) => !params.previouslyBound.has(tool));
  const bound =
    fresh.length > 0
      ? params.hostCapabilities.bindToolSurface(fresh, params.bindingOptions)
      : fresh;
  if (bound.length !== fresh.length) {
    throw new Error("Copilot host capability changed the tool surface length.");
  }
  const replacements = new Map<AnyAgentTool, AnyAgentTool>();
  for (let index = 0; index < fresh.length; index += 1) {
    replacements.set(fresh[index]!, bound[index]!);
  }
  return params.compactedTools.map((tool) => replacements.get(tool) ?? tool);
}

export function findDuplicateToolNames(tools: readonly AnyAgentTool[]): string[] {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    if (typeof tool.name === "string" && tool.name.length > 0) {
      counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .toSorted();
}
