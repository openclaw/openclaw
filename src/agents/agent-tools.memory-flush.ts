import { logWarn } from "../logger.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { copyAgentToolMetadata } from "./agent-tool-metadata.js";
import type { MemoryFlushToolRunContext } from "./agent-tools.memory-flush.types.js";
import { messageProviderExcludesTool } from "./agent-tools.message-provider-policy.js";
import type { OpenClawCodingToolsOptions } from "./agent-tools.options.js";
import { wrapToolMemoryFlushAppendOnlyWrite } from "./agent-tools.read.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { recordModelFallbackStop } from "./model-fallback-stop.js";
import { isToolResultError } from "./tool-result-error.js";

type MemoryFlushToolProjection =
  | Parameters<typeof wrapToolMemoryFlushAppendOnlyWrite>[1]
  | MemoryFlushToolRunContext;

/** Validate the memory trigger's persistence arm and expose its plugin identity. */
export function resolveMemoryFlushToolSetup(options?: OpenClawCodingToolsOptions) {
  const isMemoryFlushRun = options?.trigger === "memory";
  if (isMemoryFlushRun && !options?.memoryFlushWritePath && !options?.memoryFlushTools) {
    throw new Error("Memory flush requires memoryFlushWritePath or memoryFlushTools");
  }
  return {
    isMemoryFlushRun,
    memoryFlushWritePath: isMemoryFlushRun ? options.memoryFlushWritePath : undefined,
    memoryFlush:
      isMemoryFlushRun && options?.memoryFlushTools
        ? { flushId: options.memoryFlushTools.flushId }
        : undefined,
  };
}

/** Warn when policy removes the append-only writer from a file-arm flush. */
export function warnIfMemoryFlushFileWriterUnavailable(params: {
  tools: readonly AnyAgentTool[];
  relativePath: string | undefined;
  messageProvider: string | undefined;
}): void {
  if (
    params.relativePath &&
    !params.tools.some((tool) => tool.name === "write") &&
    // A transport whose allowlist never carries `write`, such as node, is an intended
    // configuration, not a lost writer, so it stays quiet instead of warning per flush.
    !messageProviderExcludesTool(params.messageProvider, "write")
  ) {
    // Checked on the final authorized list, not the earlier flush surface: tools.deny,
    // the model-provider policy and the rest of the pipeline all run after that surface
    // is built, so a flush can hold `write` there and lose it here.
    // Otherwise the run completes normally, the model reports the save as done, and the
    // memory is lost with no record that it was never persisted. The text names no
    // single config key because any of those filters can be the one that removed it.
    logWarn(
      `memory flush cannot persist ${params.relativePath}: no write tool survived this agent's tool policy, so this run will not save anything.`,
    );
  }
}

/** A pre-inference skip when the provider has no authorized persistence tool. */
export class MemoryFlushToolsUnavailableError extends Error {
  constructor(readonly missingToolNames: readonly string[]) {
    const names = missingToolNames.length > 0 ? missingToolNames.join(", ") : "<none declared>";
    super(`memory flush skipped: no declared persistence tool survived policy (${names})`);
    this.name = "MemoryFlushToolsUnavailableError";
    recordModelFallbackStop(this);
  }
}

// A resolved error result is not persistence evidence, just like a thrown error.
function wrapPersistenceTool(
  tool: AnyAgentTool,
  recordPersistenceToolSuccess: () => void,
): AnyAgentTool {
  return copyAgentToolMetadata(tool, {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const result = await tool.execute(toolCallId, params, signal, onUpdate);
      if (!isToolResultError(result) && !("isError" in result && result.isError === true)) {
        recordPersistenceToolSuccess();
      }
      return result;
    },
  });
}

/** Project a memory flush onto its file writer or selected provider-owned persistence tools. */
export function projectMemoryFlushTools(
  tools: AnyAgentTool[],
  projection: MemoryFlushToolProjection | undefined,
): AnyAgentTool[] {
  if (!projection) {
    return tools;
  }
  if ("persistenceToolNames" in projection) {
    const persistenceNames = new Set(projection.persistenceToolNames);
    const lookupNames = new Set(projection.lookupToolNames ?? []);
    return tools.flatMap((tool) => {
      if (tool.name === "read") {
        return [tool];
      }
      const owner = getPluginToolMeta(tool)?.pluginId;
      if (owner !== projection.ownerPluginId) {
        return [];
      }
      if (persistenceNames.has(tool.name)) {
        return [wrapPersistenceTool(tool, projection.recordPersistenceToolSuccess)];
      }
      return lookupNames.has(tool.name) ? [tool] : [];
    });
  }
  return tools.flatMap((tool) => {
    if (tool.name === "read") {
      return [tool];
    }
    return tool.name === "write" ? [wrapToolMemoryFlushAppendOnlyWrite(tool, projection)] : [];
  });
}

/** Reject a tools-arm flush before inference when policy removed every declared writer. */
export function assertMemoryFlushPersistenceToolAvailable(
  tools: readonly AnyAgentTool[],
  context: MemoryFlushToolRunContext | undefined,
): void {
  if (!context) {
    return;
  }
  const availableNames = new Set(
    tools
      .filter((tool) => getPluginToolMeta(tool)?.pluginId === context.ownerPluginId)
      .map((tool) => tool.name),
  );
  const isPersistenceToolAvailable = (name: string) => name !== "read" && availableNames.has(name);
  if (!context.persistenceToolNames.some(isPersistenceToolAvailable)) {
    throw new MemoryFlushToolsUnavailableError(
      context.persistenceToolNames.filter((name) => !isPersistenceToolAvailable(name)),
    );
  }
  // Missing lookup tools warn without blocking an available persistence tool.
  const missingNames = [
    ...new Set((context.lookupToolNames ?? []).filter((name) => !availableNames.has(name))),
  ];
  if (missingNames.length > 0) {
    logWarn(
      `plugin "${context.ownerPluginId}" flush cannot check for existing memory: ${missingNames.join(", ")} did not survive this agent's tool policy.`,
    );
  }
}
