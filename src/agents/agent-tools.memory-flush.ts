import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { root as fsRoot } from "../infra/fs-safe.js";
import { logWarn } from "../logger.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { copyAgentToolMetadata } from "./agent-tool-metadata.js";
import {
  captureAgentToolSourceExecutionGuard,
  runWithAgentToolSourceExecutionScope,
} from "./agent-tool-source-execution-guard.js";
import type { MemoryFlushToolRunContext } from "./agent-tools.memory-flush.types.js";
import { messageProviderExcludesTool } from "./agent-tools.message-provider-policy.js";
import type { OpenClawCodingToolsOptions } from "./agent-tools.options.js";
import {
  REQUIRED_PARAM_GROUPS,
  assertRequiredParams,
  getToolParamsRecord,
  normalizeFileToolPathParamsFromKeys,
} from "./agent-tools.params.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { assertNewMemoryFlushContent } from "./memory-flush-content.js";
import type { MemoryWriteProvenanceObserver } from "./memory-write-provenance.js";
import { recordModelFallbackStop } from "./model-fallback-stop.js";
import { resolveToolPathAgainstWorkspaceRoot } from "./path-policy.js";
import { resolveSandboxFileMutationQueueKey } from "./sandbox/file-mutation-identity.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import { withFileMutationQueueKeyResolution } from "./sessions/tools/file-mutation-queue.js";
import { isToolResultError } from "./tool-result-error.js";

type MemoryFlushToolProjection = MemoryFlushAppendOnlyWriteOptions | MemoryFlushToolRunContext;

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

type MemoryFlushAppendOnlyWriteOptions = {
  root: string;
  relativePath: string;
  memoryWriteProvenance?: MemoryWriteProvenanceObserver;
  containerWorkdir?: string;
  sandbox?: {
    root: string;
    bridge: SandboxFsBridge;
  };
};

async function readOptionalUtf8File(params: {
  absolutePath: string;
  relativePath: string;
  sandbox?: MemoryFlushAppendOnlyWriteOptions["sandbox"];
  signal?: AbortSignal;
}): Promise<string> {
  try {
    if (params.sandbox) {
      const stat = await params.sandbox.bridge.stat({
        filePath: params.relativePath,
        cwd: params.sandbox.root,
        signal: params.signal,
      });
      if (!stat) {
        return "";
      }
      const buffer = await params.sandbox.bridge.readFile({
        filePath: params.relativePath,
        cwd: params.sandbox.root,
        signal: params.signal,
      });
      return buffer.toString("utf-8");
    }
    return await fs.readFile(params.absolutePath, "utf-8");
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return "";
    }
    throw error;
  }
}

async function appendMemoryFlushContent(params: {
  absolutePath: string;
  root: string;
  relativePath: string;
  content: string;
  sandbox?: MemoryFlushAppendOnlyWriteOptions["sandbox"];
  signal?: AbortSignal;
  assertCurrent: ReturnType<typeof captureAgentToolSourceExecutionGuard>;
}) {
  await runWithAgentToolSourceExecutionScope(params.assertCurrent, async () => {
    const sandbox = params.sandbox;
    if (!sandbox) {
      const root = await fsRoot(params.root);
      params.assertCurrent();
      await root.append(params.relativePath, params.content, {
        mkdir: true,
        prependNewlineIfNeeded: true,
        assertBeforeMutation: params.assertCurrent,
      });
      return;
    }
    // Share write/edit ordering; the bridge has no cross-process append primitive.
    const queueKey = resolveSandboxFileMutationQueueKey({
      ...sandbox,
      filePath: params.absolutePath,
      cwd: sandbox.root,
      signal: params.signal,
    });
    await withFileMutationQueueKeyResolution(queueKey, async () => {
      const existing = await readOptionalUtf8File(params);
      const separator =
        existing.length > 0 && !existing.endsWith("\n") && !params.content.startsWith("\n")
          ? "\n"
          : "";
      params.assertCurrent();
      await sandbox.bridge.writeFile({
        filePath: params.relativePath,
        cwd: sandbox.root,
        data: `${existing}${separator}${params.content}`,
        mkdir: true,
        signal: params.signal,
      });
    });
  });
}

/** Restrict a write tool to appending memory-flush content to one path. */
function wrapToolMemoryFlushAppendOnlyWrite(
  tool: AnyAgentTool,
  options: MemoryFlushAppendOnlyWriteOptions,
): AnyAgentTool {
  const allowedAbsolutePath = path.resolve(options.root, options.relativePath);
  return {
    ...tool,
    description: `Append new memory notes to ${options.relativePath}; creates parent directories. The content is appended verbatim. Send only new text, never existing entries or a rewritten file.`,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const assertCurrent = captureAgentToolSourceExecutionGuard(signal);
      const record = getToolParamsRecord(args);
      const normalizedRecord = record
        ? await normalizeFileToolPathParamsFromKeys(
            record,
            ["path"],
            options.root,
            options.sandbox?.bridge,
          )
        : undefined;
      assertRequiredParams(normalizedRecord, REQUIRED_PARAM_GROUPS.write, tool.name);
      const filePath =
        typeof normalizedRecord?.path === "string" && normalizedRecord.path.trim()
          ? normalizedRecord.path
          : undefined;
      const content = typeof record?.content === "string" ? record.content : undefined;
      if (!filePath || content === undefined) {
        return tool.execute(toolCallId, args, signal, onUpdate);
      }

      const resolvedPath = resolveToolPathAgainstWorkspaceRoot({
        filePath,
        root: options.root,
        containerWorkdir: options.containerWorkdir,
      });
      if (filePath.startsWith("@") || resolvedPath !== allowedAbsolutePath) {
        throw new Error(
          `Memory flush writes are restricted to ${options.relativePath}; use that path only.`,
        );
      }

      const contentBefore = await runWithAgentToolSourceExecutionScope(assertCurrent, async () => {
        const previousContent = await readOptionalUtf8File({
          absolutePath: allowedAbsolutePath,
          relativePath: options.relativePath,
          sandbox: options.sandbox,
          signal,
        });
        assertCurrent();
        return previousContent;
      });
      assertNewMemoryFlushContent(contentBefore, content);
      const separator =
        contentBefore.length > 0 && !contentBefore.endsWith("\n") && !content.startsWith("\n")
          ? "\n"
          : "";
      const commit = () =>
        appendMemoryFlushContent({
          absolutePath: allowedAbsolutePath,
          root: options.root,
          relativePath: options.relativePath,
          content,
          sandbox: options.sandbox,
          signal,
          assertCurrent,
        });
      const memoryWriteProvenance = options.memoryWriteProvenance;
      if (memoryWriteProvenance && (await memoryWriteProvenance.classifies(allowedAbsolutePath))) {
        await memoryWriteProvenance.write({
          absolutePath: allowedAbsolutePath,
          contentBefore,
          contentAfter: `${contentBefore}${separator}${content}`,
          commit,
        });
      } else {
        await commit();
      }
      // This wrapper inherits the write tool's output schema, so report only
      // the authoritative `changed`; deriving `created` before append is racy.
      return {
        content: [{ type: "text", text: `Appended content to ${options.relativePath}.` }],
        details: { changed: true },
      };
    },
  };
}
