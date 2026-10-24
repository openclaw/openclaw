import { expect, vi } from "vitest";
import type { CodeModeConfig as CodeModeToolsConfig } from "../config/types.tools.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { codeModeReplayIdForToolCall } from "./code-mode-bridge.js";
import type { CodeModeExecutorContinuation } from "./code-mode-executor-types.js";
import { runCodeModeExecutor } from "./code-mode-executor.js";
import type { CodeModeSkill } from "./code-mode-skills.js";
import {
  activeRuns,
  disposeAllCodeModeRuns,
  removeExpiredRuns,
  resumingRunIds,
} from "./code-mode-state.js";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  type ToolSearchCatalogRef,
  type ToolSearchToolContext,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

const directContinuations = new Set<CodeModeExecutorContinuation>();

export const testing = {
  activeRuns,
  resumingRunIds,
  codeModeReplayIdForToolCall,
  removeExpiredRuns,
  runCodeModeExecutor: async (...args: Parameters<typeof runCodeModeExecutor>) => {
    const result = await runCodeModeExecutor(...args);
    if (result.status === "waiting") {
      directContinuations.add(result.continuation);
    }
    return result;
  },
};

export async function resetCodeModeTestState(): Promise<void> {
  await disposeAllCodeModeRuns();
  await Promise.all([...directContinuations].map((continuation) => continuation.dispose()));
  directContinuations.clear();
}

export function fakeTool(name: string, description: string): AnyAgentTool {
  return {
    name,
    label: name,
    description,
    parameters: { type: "object", properties: { value: { type: "string" } } },
    execute: vi.fn(async (_toolCallId, input) => jsonResult({ name, input })),
  };
}

export function pluginTool(
  name: string,
  description: string,
  pluginId = "fake-code-mode",
): AnyAgentTool {
  const tool = fakeTool(name, description);
  setPluginToolMeta(tool, { pluginId, optional: true });
  return tool;
}

export function pluginToolWithExecute(
  name: string,
  description: string,
  execute: AnyAgentTool["execute"],
): AnyAgentTool {
  return Object.assign(pluginTool(name, description), { execute: vi.fn(execute) });
}

export function jsonTool(name: string, value: unknown, description = name): AnyAgentTool {
  return pluginToolWithExecute(name, description, async () => jsonResult(value));
}

export function expectCompleted(result: unknown, value: unknown): void {
  expect(result).toMatchObject({ status: "completed", value });
}

export function expectFailure(
  result: unknown,
  phase: string,
  code = "internal_error",
  fields: Record<string, unknown> = {},
): void {
  expect(result).toMatchObject({ status: "failed", code, failurePhase: phase, ...fields });
}

export function expectToolCalls(count: number, ...tools: AnyAgentTool[]): void {
  for (const tool of tools) {
    expect(tool.execute).toHaveBeenCalledTimes(count);
  }
}

export function mcpTool(params: {
  name: string;
  serverName: string;
  safeServerName?: string;
  toolName: string;
  description?: string;
  parameters?: AnyAgentTool["parameters"];
  operation?: "tool" | "resources_list" | "resources_read" | "prompts_list" | "prompts_get";
  instructions?: string;
  execute?: AnyAgentTool["execute"];
}): AnyAgentTool {
  const tool: AnyAgentTool = {
    name: params.name,
    label: params.toolName,
    description: params.description ?? `MCP ${params.toolName}`,
    parameters: params.parameters ?? { type: "object", properties: {} },
    execute:
      params.execute ??
      vi.fn(async (_toolCallId, input) =>
        jsonResult({ serverName: params.serverName, toolName: params.toolName, input }),
      ),
  };
  setPluginToolMeta(tool, {
    pluginId: "bundle-mcp",
    optional: false,
    mcp: {
      serverName: params.serverName,
      safeServerName: params.safeServerName ?? params.serverName,
      toolName: params.toolName,
      operation: params.operation ?? "tool",
      ...(params.instructions ? { instructions: params.instructions } : {}),
    },
  });
  return tool;
}

export function resultDetails(result: { details?: unknown }): Record<string, unknown> {
  expect(typeof result.details).toBe("object");
  return result.details as Record<string, unknown>;
}

export function resultText(
  result: Pick<Awaited<ReturnType<AnyAgentTool["execute"]>>, "content">,
): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** Compare public summaries to independently constructed, normalized guest data. */
export function expectOriginalCodeModeMarker(marker: unknown, original: unknown): void {
  expect(marker).toMatchObject({
    truncated: true,
    guidance: "Output truncated; rerun with narrower args.",
  });
  const { prefix, omittedBytes } = marker as { prefix: string; omittedBytes: number };
  const serialized = JSON.stringify(original);
  expect(serialized.startsWith(prefix), "summary must retain the original JSON prefix").toBe(true);
  expect(omittedBytes).toBe(Buffer.byteLength(serialized) - Buffer.byteLength(prefix));
  expect(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(prefix))).toBe(prefix);
}

export function expectCodeModeSharedBudget(
  result: { output?: unknown; value?: unknown; error?: unknown },
  maxBytes: number,
): void {
  let bytes = 0;
  for (const field of ["output", "value", "error"] as const) {
    if (Object.hasOwn(result, field)) {
      const value = result[field];
      if (!(field === "output" && Array.isArray(value) && value.length === 0)) {
        bytes += Buffer.byteLength(JSON.stringify(value));
      }
    }
  }
  expect(bytes).toBeLessThanOrEqual(maxBytes);
}

export function createHeadlessCodeModeHarness(
  tools: AnyAgentTool[] = [],
  options: { swarmEnabled?: boolean; codeMode?: CodeModeToolsConfig } = {},
): ToolSearchToolContext {
  const config = {
    tools: {
      codeMode:
        typeof options.codeMode === "object"
          ? { enabled: false, timeoutMs: 60_000, ...options.codeMode }
          : (options.codeMode ?? { enabled: false, timeoutMs: 60_000 }),
      ...(options.swarmEnabled ? { swarm: true } : {}),
    },
  } as never;
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools });
  return { config, runtimeConfig: config, agentId: "main", catalogRef };
}

export function createCodeModeHarness(
  params: {
    agentId?: string;
    catalogRef?: ToolSearchCatalogRef;
    codeModeSkills?: readonly CodeModeSkill[];
    codeMode?: CodeModeToolsConfig;
    forceRestartSafeTools?: boolean;
    abortSignal?: AbortSignal;
    modelContextWindowTokens?: number;
  } = {},
) {
  const catalogRef = params.catalogRef ?? createToolSearchCatalogRef();
  const config = {
    tools: {
      codeMode:
        typeof params.codeMode === "object"
          ? { enabled: true, ...params.codeMode }
          : (params.codeMode ?? true),
    },
  };
  const ctx = {
    config,
    runtimeConfig: config,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: "session-code-mode",
    sessionKey: params.agentId ? `agent:${params.agentId}:main` : "agent:main:main",
    runId: "run-code-mode",
    catalogRef,
    forceRestartSafeTools: params.forceRestartSafeTools,
    codeModeSkills: params.codeModeSkills,
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    ...(params.modelContextWindowTokens === undefined
      ? {}
      : { modelContextWindowTokens: params.modelContextWindowTokens }),
  };
  const tools = createCodeModeTools(ctx);
  return { catalogRef, config, ctx, tools };
}

export function createCatalogCodeModeHarness(
  targets: AnyAgentTool[] = [],
  options?: Parameters<typeof createCodeModeHarness>[0],
) {
  const h = createCodeModeHarness(options);
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, ...targets] });
  return {
    ...h,
    ...codeModeRunner(h.tools),
    complete: (code: string) =>
      runUntilCompleted({ execTool: h.tools[0]!, waitTool: h.tools[1]!, code }),
  };
}

export function codeModeRunner(tools: AnyAgentTool[]) {
  const execute = (code: string, id = "cell", args: Record<string, unknown> = {}) =>
    tools[0]!.execute(id, { code, ...args });
  return {
    execute,
    run: async (code: string, id = "cell", args: Record<string, unknown> = {}) =>
      resultDetails(await execute(code, id, args)),
    resume: async (details: Record<string, unknown>, id = "resume") =>
      resultDetails(await tools[1]!.execute(id, { runId: details.runId })),
  };
}

export async function runUntilCompleted(params: {
  execTool: AnyAgentTool;
  waitTool: AnyAgentTool;
  code: string;
  restartSafe?: boolean;
}) {
  const details = await codeModeRunner([params.execTool]).run(params.code, "code-call-1", {
    restartSafe: params.restartSafe,
  });
  return await waitUntilCompleted({ details, waitTool: params.waitTool });
}

export async function waitUntilCompleted(params: {
  details: Record<string, unknown>;
  waitTool: AnyAgentTool;
}) {
  // Resume the existing run through public waits; never replay its actions.
  let details = params.details;
  for (let index = 0; index < 8 && details.status === "waiting"; index += 1) {
    const runId = details.runId;
    expect(typeof runId).toBe("string");
    details = resultDetails(await params.waitTool.execute(`code-wait-${index}`, { runId }));
  }
  return details;
}
