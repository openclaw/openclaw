import { getToolParamsRecord, normalizeFileToolPathParam } from "./agent-tools.params.js";
import {
  createOpenClawReadTool,
  eraseSessionFileTool,
  mapContainerPathToWorkspaceRoot,
  resolveAdaptiveReadMaxBytes,
  type OpenClawReadToolOptions,
} from "./agent-tools.read.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { resolveToCwd } from "./sessions/tools/path-utils.js";
import { createReadTool } from "./sessions/tools/read.js";
import type { ReadToolDetails } from "./sessions/tools/tool-contracts.js";
import { runWithSkillReadContext, createSkillInstructionPage } from "./skill-instruction-page.js";
import {
  createAlreadyDeliveredSkillResult,
  rememberSkillInstructionDelivery,
} from "./skill-instruction-result.js";
import { resolveToolResultBudget } from "./tool-result-limits.js";

type SkillReadContent = {
  filePath: string;
  readContent?: string;
};

export type SkillInstructionDeliveryCache = Map<string, Promise<boolean>>;

/** Serve exact non-filesystem skill locators before workspace path guards run. */
export function wrapReadToolWithSkillContent(
  tool: AnyAgentTool<ReadToolDetails>,
  skills: readonly SkillReadContent[] | undefined,
  options?: OpenClawReadToolOptions & {
    cwd?: string;
    containerWorkdir?: string;
    instructionPaths?: readonly string[];
    instructionDeliveryCache?: SkillInstructionDeliveryCache;
  },
): AnyAgentTool<ReadToolDetails> {
  const cwd = options?.cwd ?? process.cwd();
  const resolveInstructionPath = (filePath: string): string => {
    if (filePath.startsWith("node://")) {
      return filePath;
    }
    const mapped = mapContainerPathToWorkspaceRoot({
      filePath,
      root: cwd,
      containerWorkdir: options?.containerWorkdir,
    });
    return resolveToCwd(mapped, cwd);
  };
  const instructionContent = new Map<string, string | undefined>(
    (options?.instructionPaths ?? []).map((filePath) => [
      resolveInstructionPath(filePath),
      undefined,
    ]),
  );
  for (const skill of skills ?? []) {
    instructionContent.set(
      resolveInstructionPath(skill.filePath),
      skill.filePath.startsWith("node://") ? skill.readContent : undefined,
    );
  }
  if (instructionContent.size === 0) {
    return tool;
  }
  const instructionDeliveryCache = options?.instructionDeliveryCache;
  const readContent = (filePath: string): string => {
    const content = instructionContent.get(filePath);
    if (content === undefined) {
      throw Object.assign(new Error(`Virtual skill file not found: ${filePath}`), {
        code: "ENOENT",
      });
    }
    return content;
  };
  let virtualRead: AnyAgentTool<ReadToolDetails> | undefined;
  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const record = getToolParamsRecord(args);
      const rawPath = record?.path;
      const normalizedPath =
        typeof rawPath === "string" ? normalizeFileToolPathParam(rawPath) : undefined;
      const instructionPath = normalizedPath ? resolveInstructionPath(normalizedPath) : undefined;
      if (!normalizedPath || !instructionPath || !instructionContent.has(instructionPath)) {
        return tool.execute(toolCallId, args, signal, onUpdate);
      }
      // Models still send ordinary file windows for skills. Preserve tolerance for
      // those windows, while string cursors retain verified continuation semantics.
      const cursor = typeof record?.cursor === "number" ? undefined : record?.cursor;
      for (;;) {
        const priorDelivery =
          cursor === undefined ? instructionDeliveryCache?.get(instructionPath) : undefined;
        if (!priorDelivery) {
          break;
        }
        const delivered = await priorDelivery;
        if (instructionDeliveryCache?.get(instructionPath) !== priorDelivery) {
          continue;
        }
        if (delivered) {
          return createAlreadyDeliveredSkillResult(priorDelivery);
        }
        instructionDeliveryCache?.delete(instructionPath);
      }
      let settleDelivery = (_delivered: boolean): void => undefined;
      let delivery: Promise<boolean> | undefined;
      if (instructionDeliveryCache && cursor === undefined) {
        delivery = new Promise<boolean>((resolve) => {
          settleDelivery = resolve;
        });
        // The resolved promise covers sequential and concurrent reads without
        // changing prior transcript bytes. The compaction owner clears it.
        instructionDeliveryCache.set(instructionPath, delivery);
      }
      const resetDelivery = () => {
        settleDelivery(false);
        if (delivery && instructionDeliveryCache?.get(instructionPath) === delivery) {
          instructionDeliveryCache.delete(instructionPath);
        }
      };
      const instructionTool =
        typeof instructionContent.get(instructionPath) === "string"
          ? (virtualRead ??= createOpenClawReadTool(
              eraseSessionFileTool(
                createReadTool("/", {
                  maxBytes: resolveAdaptiveReadMaxBytes(options),
                  modelBudget: resolveToolResultBudget(options?.modelContextWindowTokens),
                  operations: {
                    resolvePath: (filePath) => filePath,
                    access: async (filePath) => void readContent(filePath),
                    readFile: async (filePath) => Buffer.from(readContent(filePath), "utf8"),
                  },
                }),
              ),
              options,
            ))
          : tool;
      const instructionArgs: Record<string, unknown> = { ...record, path: normalizedPath };
      for (const key of ["offset", "limit", "cursor"]) {
        delete instructionArgs[key];
      }
      try {
        const result = await runWithSkillReadContext(
          {
            location: instructionPath,
            cursor,
            budget: resolveToolResultBudget(options?.modelContextWindowTokens),
          },
          () => instructionTool.execute(toolCallId, instructionArgs, signal, onUpdate),
        );
        const details = result.details;
        // Custom placement readers may already return complete text; never paginate a truncated source.
        const paged =
          details.kind === "text"
            ? createSkillInstructionPage(
                { name: instructionPath, location: instructionPath, content: details.content },
                cursor,
                resolveToolResultBudget(options?.modelContextWindowTokens),
              )
            : undefined;
        const page = paged?.details ?? (details.kind === "skill_page" ? details : undefined);
        if (!page) {
          resetDelivery();
          if (details.kind === "truncated") {
            throw new Error(
              "Skill source reader returned a truncated document; a complete source is required for continuation.",
            );
          }
          return result;
        }
        const output = paged
          ? { ...paged, details: { kind: "skill_page" as const, ...paged.details } }
          : result;
        if (page.startByte === 0 && page.nextCursor === null && !signal?.aborted) {
          rememberSkillInstructionDelivery(output, page.content, delivery);
          settleDelivery(true);
        } else {
          resetDelivery();
        }
        return output;
      } catch (error) {
        resetDelivery();
        throw error;
      }
    },
  };
}
