import { readdir } from "node:fs/promises";
import { racePromiseWithAbortSignal } from "../../../infra/abort-signal.js";
import type { DirectoryEntry } from "../../../infra/directory-entries.js";
import { toErrorObject } from "../../../infra/errors.js";
import type { AgentTool } from "../../runtime/index.js";
import { toolResultFitsBudget, type ToolResultBudget } from "../../tool-result-limits.js";
import { assertFileToolNotAborted } from "./file-tool-abort.js";
import { normalizePositiveLimit } from "./limits.js";
import { resolveLocalPathToCwd, resolveToCwd } from "./path-utils.js";
import type { LsToolDetails } from "./tool-contracts.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { lsSchema } from "./tool-schemas.js";
import { DEFAULT_MAX_BYTES } from "./truncate.js";

const DEFAULT_LIMIT = 500;

/**
 * Pluggable operations for the ls tool.
 * Override these to delegate directory listing to remote systems (for example SSH).
 */
export interface LsOperations {
  readDirectory: (
    absolutePath: string,
    signal?: AbortSignal,
  ) => Promise<DirectoryEntry[]> | DirectoryEntry[];
}

const defaultLsOperations: LsOperations = {
  readDirectory: async (absolutePath) =>
    (await readdir(absolutePath, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    })),
};

export interface LsToolOptions {
  /** Custom operations for directory listing. Default: local filesystem */
  operations?: LsOperations;
  modelBudget?: ToolResultBudget;
}

function formatLsContinuation(after: string): string {
  return `\n\n[More entries. Continue with the same path and after=${JSON.stringify(after)}.]`;
}

export function createLsTool(
  cwd: string,
  options?: LsToolOptions,
): AgentTool<typeof lsSchema, LsToolDetails> {
  const ops = options?.operations ?? defaultLsOperations;
  const resolvePath = options?.operations ? resolveToCwd : resolveLocalPathToCwd;
  return wrapToolDefinition<typeof lsSchema, LsToolDetails>({
    name: "ls",
    label: "ls",
    description:
      "List directory entries in binary filename order, including dotfiles and links. Names are JSON-quoted; / marks actual directories. Pass the returned after cursor with the same path to continue.",
    parameters: lsSchema,
    async execute(_toolCallId, { path, limit, after }, signal, _onUpdate, _ctx) {
      assertFileToolNotAborted(signal);

      const runListing = async () => {
        try {
          const dirPath = resolvePath(path || ".", cwd);
          const effectiveLimit = normalizePositiveLimit(limit, DEFAULT_LIMIT);
          const directoryEntries = await ops.readDirectory(dirPath, signal);
          assertFileToolNotAborted(signal);
          const entries = directoryEntries
            .filter((entry) => after === undefined || entry.name > after)
            .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          if (entries.length === 0) {
            return {
              content: [{ type: "text" as const, text: "(empty directory)" }],
              details: { content: "(empty directory)" },
            };
          }
          const fitsPage = (text: string) =>
            Buffer.byteLength(text) <= DEFAULT_MAX_BYTES &&
            toolResultFitsBudget(text, options?.modelBudget);
          const lines: string[] = [];
          let content = "";
          for (const entry of entries) {
            if (lines.length >= effectiveLimit) {
              break;
            }
            const line = JSON.stringify(entry.name + (entry.isDirectory ? "/" : ""));
            const candidate = content ? `${content}\n${line}` : line;
            if (!fitsPage(candidate)) {
              break;
            }
            lines.push(line);
            content = candidate;
          }
          // Complete final pages need no footer. Reserve continuation only after
          // selection, and advance past only the entries that remain visible.
          while (lines.length > 0) {
            const nextAfter =
              lines.length < entries.length ? entries[lines.length - 1]!.name : undefined;
            const output =
              content + (nextAfter === undefined ? "" : formatLsContinuation(nextAfter));
            if (fitsPage(output)) {
              return {
                content: [{ type: "text" as const, text: output }],
                details: { content: output, ...(nextAfter === undefined ? {} : { nextAfter }) },
              };
            }
            lines.pop();
            content = lines.join("\n");
          }
          throw new Error("A directory entry cannot fit within the listing output budget.");
        } catch (e: unknown) {
          throw toErrorObject(e, "Non-Error rejection");
        }
      };

      return await racePromiseWithAbortSignal(
        runListing,
        signal,
        () => new Error("Operation aborted"),
      );
    },
  });
}
