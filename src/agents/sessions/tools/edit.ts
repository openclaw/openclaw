/**
 * Built-in edit session tool.
 *
 * Applies exact targeted replacements with queued file mutation, diff previews, and TUI renderers.
 */
import { constants } from "node:fs";
import {
  access as fsAccess,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import * as Diff from "diff";
import { Type } from "typebox";
import { levenshteinDistance } from "../../../shared/levenshtein-distance.js";
import { renderDiff } from "../../modes/interactive/components/diff.js";
import type { AgentTool } from "../../runtime/index.js";
import { textResult } from "../../tools/common.js";
import type { ToolDefinition } from "../extensions/types.js";
import {
  applyEditsToNormalizedContent,
  computeEditsDiff,
  detectLineEnding,
  EditNoChangeError,
  type Edit,
  type EditDiffError,
  type EditDiffResult,
  generateDiffString,
  generateUnifiedPatch,
  normalizeToLF,
  restoreLineEndings,
  splitNoOpEdits,
  stripBom,
  validateNoOpEditTargets,
} from "./edit-diff.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { resolveToCwd } from "./path-utils.js";
import { invalidArgText, shortenPath, str } from "./render-utils.js";
import type { EditToolDetails, EditToolInput } from "./tool-contracts.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

type EditPreview = EditDiffResult | EditDiffError;

type EditRenderState = {
  callComponent?: EditCallRenderComponent;
};

const replaceEditSchema = Type.Object(
  {
    oldText: Type.String({
      description:
        "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
    }),
    newText: Type.String({
      description: "Replacement text for this targeted edit.",
    }),
  },
  { additionalProperties: false },
);

const editSchema = Type.Object(
  {
    path: Type.String({
      description: "Path to the file to edit (relative or absolute)",
    }),
    edits: Type.Array(replaceEditSchema, {
      description:
        "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
    }),
  },
  { additionalProperties: false },
);
export type { EditToolDetails, EditToolInput } from "./tool-contracts.js";

type LegacyEditToolInput = Record<string, unknown> & {
  edits?: unknown;
  oldText?: unknown;
  newText?: unknown;
};

type EditMismatchPhase = "validation" | "apply";

const EDIT_MISMATCH_MESSAGE = "Could not find the exact text in";
const EDIT_INDEXED_MISMATCH_MESSAGE = "Could not find edits[";
const EDIT_MISMATCH_HINT_LIMIT = 800;
const EDIT_MISMATCH_CANDIDATE_LIMIT = 3;
const EDIT_MISMATCH_PREFILTER_LIMIT = 24;
const EDIT_MISMATCH_CANDIDATE_DIFF_LIMIT = 600;
const EDIT_MISMATCH_SCORE_TEXT_LIMIT = 240;
const EDIT_MISMATCH_SCAN_LINE_LIMIT = 1000;

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
export interface EditOperations {
  /** Read file contents as a Buffer */
  readFile: (absolutePath: string) => Promise<Buffer>;
  /** Write content to a file */
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  /** Check if file is readable and writable (throw if not) */
  access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
  readFile: (path) => fsReadFile(path),
  writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
  access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
  /** Custom operations for file editing. Default: local filesystem */
  operations?: EditOperations;
}

function prepareEditArguments(input: unknown): EditToolInput {
  if (!input || typeof input !== "object") {
    return input as EditToolInput;
  }

  const args = input as Record<string, unknown>;

  // Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array
  if (typeof args.edits === "string") {
    try {
      const parsed = JSON.parse(args.edits);
      if (Array.isArray(parsed)) {
        args.edits = parsed;
      }
    } catch {}
  }

  const legacy = args as LegacyEditToolInput;
  if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
    return args as unknown as EditToolInput;
  }

  const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
  edits.push({ oldText: legacy.oldText, newText: legacy.newText });
  const { oldText: _oldText, newText: _newText, ...rest } = legacy;
  return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): {
  path: string;
  edits: Edit[];
} {
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  }
  return { path: input.path, edits: input.edits };
}

function removeExactOccurrences(content: string, needle: string): string {
  return needle.length > 0 ? content.split(needle).join("") : content;
}

function didEditLikelyApply(params: {
  originalContent: string;
  currentContent: string;
  edits: Edit[];
}): boolean {
  if (params.edits.length === 0) {
    return false;
  }
  const normalizedOriginal = normalizeToLF(params.originalContent);
  const normalizedCurrent = normalizeToLF(params.currentContent);
  if (normalizedOriginal === normalizedCurrent) {
    return false;
  }

  let withoutInsertedNewText = normalizedCurrent;
  for (const edit of params.edits) {
    const normalizedNew = normalizeToLF(edit.newText);
    if (normalizedNew.length > 0 && !normalizedCurrent.includes(normalizedNew)) {
      return false;
    }
    withoutInsertedNewText = removeExactOccurrences(withoutInsertedNewText, normalizedNew);
  }

  return params.edits.every(
    (edit) => !withoutInsertedNewText.includes(normalizeToLF(edit.oldText)),
  );
}

function splitDiagnosticLines(text: string): string[] {
  const lines = normalizeToLF(text).split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function truncateForScore(text: string): string {
  return text.length <= EDIT_MISMATCH_SCORE_TEXT_LIMIT
    ? text
    : text.slice(0, EDIT_MISMATCH_SCORE_TEXT_LIMIT);
}

function similarityScore(a: string, b: string): number {
  const left = truncateForScore(a);
  const right = truncateForScore(b);
  const maxLength = Math.max(left.length, right.length, 1);
  return 1 - levenshteinDistance(left, right) / maxLength;
}

function scoreCandidate(target: string, candidate: string): number {
  const rawScore = similarityScore(target, candidate);
  const trimmedTarget = target.trim();
  const trimmedCandidate = candidate.trim();
  const trimmedScore = similarityScore(trimmedTarget, trimmedCandidate);
  const containmentBonus =
    trimmedTarget.length > 0 && trimmedCandidate.includes(trimmedTarget) ? 0.25 : 0;
  return trimmedScore * 2 + rawScore + containmentBonus;
}

function cheapCandidateScore(target: string, candidate: string): number {
  const trimmedTarget = target.trim();
  const trimmedCandidate = candidate.trim();
  const lengthPenalty = Math.abs(trimmedTarget.length - trimmedCandidate.length) / 1000;
  if (trimmedTarget.length === 0 || trimmedCandidate.length === 0) {
    return -lengthPenalty;
  }
  const targetTerms = new Set(trimmedTarget.split(/\s+/).filter(Boolean));
  let sharedTerms = 0;
  for (const term of trimmedCandidate.split(/\s+/)) {
    if (targetTerms.has(term)) {
      sharedTerms++;
    }
  }
  return sharedTerms / targetTerms.size - lengthPenalty;
}

function leadingWhitespaceDescription(line: string): string {
  const match = line.match(/^[\t ]*/);
  const value = match?.[0] ?? "";
  let spaces = 0;
  let tabs = 0;
  for (const char of value) {
    if (char === " ") {
      spaces += 1;
    } else {
      tabs += 1;
    }
  }
  const parts: string[] = [];
  if (spaces > 0) {
    parts.push(`${spaces} spaces`);
  }
  if (tabs > 0) {
    parts.push(`${tabs} tabs`);
  }
  return parts.join(", ") || "none";
}

function firstChangedLinePair(
  targetText: string,
  candidateText: string,
): { targetLine: string; candidateLine: string } | undefined {
  const targetLines = splitDiagnosticLines(targetText);
  const candidateLines = splitDiagnosticLines(candidateText);
  const count = Math.max(targetLines.length, candidateLines.length);
  for (let i = 0; i < count; i++) {
    const targetLine = targetLines[i] ?? "";
    const candidateLine = candidateLines[i] ?? "";
    if (targetLine !== candidateLine) {
      return { targetLine, candidateLine };
    }
  }
  return undefined;
}

function formatEscapedLineDiff(targetText: string, candidateText: string): string {
  const output: string[] = [];
  for (const part of Diff.diffLines(targetText, candidateText)) {
    const rawLines = part.value.split("\n");
    if (rawLines[rawLines.length - 1] === "") {
      rawLines.pop();
    }
    const prefix = part.added ? "+" : part.removed ? "-" : " ";
    for (const line of rawLines) {
      output.push(`${prefix} ${JSON.stringify(line)}`);
    }
  }
  const diff = output.join("\n");
  return diff.length <= EDIT_MISMATCH_CANDIDATE_DIFF_LIMIT
    ? diff
    : `${diff.slice(0, EDIT_MISMATCH_CANDIDATE_DIFF_LIMIT)}\n... (candidate diff truncated)`;
}

function formatCandidateBlock(params: {
  index: number;
  startLine: number;
  targetText: string;
  candidateText: string;
}): string {
  const lines = [`Candidate ${params.index + 1} (line ${params.startLine}):`];
  const changed = firstChangedLinePair(params.targetText, params.candidateText);
  if (changed) {
    const targetIndent = leadingWhitespaceDescription(changed.targetLine);
    const candidateIndent = leadingWhitespaceDescription(changed.candidateLine);
    if (targetIndent !== candidateIndent) {
      lines.push(`  indentation: expected ${targetIndent}, candidate ${candidateIndent}`);
    }
  }
  lines.push(formatEscapedLineDiff(params.targetText, params.candidateText));
  return lines.join("\n");
}

function findNearestEditCandidates(
  content: string,
  oldText: string,
): Array<{ startLine: number; text: string; score: number }> {
  const targetLines = splitDiagnosticLines(oldText);
  if (targetLines.length === 0 || (targetLines.length === 1 && targetLines[0] === "")) {
    return [];
  }

  const contentLines = splitDiagnosticLines(stripBom(content).text).slice(
    0,
    EDIT_MISMATCH_SCAN_LINE_LIMIT,
  );
  if (contentLines.length === 0) {
    return [];
  }

  const targetText = targetLines.join("\n");
  const windowSize = Math.max(1, targetLines.length);
  const seen = new Set<string>();
  const prefiltered: Array<{ startLine: number; text: string; cheapScore: number }> = [];
  for (let start = 0; start <= contentLines.length - windowSize; start++) {
    const text = contentLines.slice(start, start + windowSize).join("\n");
    if (seen.has(text)) {
      continue;
    }
    seen.add(text);
    prefiltered.push({
      startLine: start + 1,
      text,
      cheapScore: cheapCandidateScore(targetText, text),
    });
  }

  return prefiltered
    .toSorted((a, b) => b.cheapScore - a.cheapScore || a.startLine - b.startLine)
    .slice(0, EDIT_MISMATCH_PREFILTER_LIMIT)
    .map((candidate) => ({
      startLine: candidate.startLine,
      text: candidate.text,
      score: scoreCandidate(targetText, candidate.text),
    }))
    .toSorted((a, b) => b.score - a.score || a.startLine - b.startLine)
    .slice(0, EDIT_MISMATCH_CANDIDATE_LIMIT);
}

function selectMismatchEdits(error: Error, edits: Edit[]): Edit[] {
  const indexedMatch = error.message.match(/Could not find edits\[(\d+)\]/);
  if (indexedMatch) {
    const index = Number.parseInt(indexedMatch[1], 10);
    const edit = Number.isInteger(index) ? edits[index] : undefined;
    return edit ? [edit] : [];
  }
  return edits.length === 1 ? edits : [];
}

function formatMismatchCandidates(currentContent: string, edits: Edit[]): string {
  const blocks: string[] = [];
  for (const edit of edits) {
    const candidates = findNearestEditCandidates(currentContent, edit.oldText);
    for (const candidate of candidates) {
      blocks.push(
        formatCandidateBlock({
          index: blocks.length,
          startLine: candidate.startLine,
          targetText: normalizeToLF(edit.oldText),
          candidateText: candidate.text,
        }),
      );
      if (blocks.length >= EDIT_MISMATCH_CANDIDATE_LIMIT) {
        return `Nearest candidate lines:\n${blocks.join("\n\n")}`;
      }
    }
  }
  return blocks.length > 0 ? `Nearest candidate lines:\n${blocks.join("\n\n")}` : "";
}

function appendMismatchHint(error: Error, currentContent: string, edits: Edit[]): Error {
  const snippet =
    currentContent.length <= EDIT_MISMATCH_HINT_LIMIT
      ? currentContent
      : `${currentContent.slice(0, EDIT_MISMATCH_HINT_LIMIT)}\n... (truncated)`;
  const candidateHint = formatMismatchCandidates(currentContent, selectMismatchEdits(error, edits));
  const suffix = candidateHint ? `\n${candidateHint}` : "";
  const enhanced = new Error(`${error.message}\nCurrent file contents:\n${snippet}${suffix}`, {
    cause: error,
  });
  enhanced.stack = error.stack;
  return enhanced;
}

type RenderableEditArgs = {
  path?: string;
  file_path?: string;
  edits?: Edit[];
  oldText?: string;
  newText?: string;
};

type EditToolResultLike = {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  details?: EditToolDetails;
};

type EditCallRenderComponent = Box & {
  preview?: EditPreview;
  previewArgsKey?: string;
  previewPending?: boolean;
  settledError?: boolean;
};

function createEditCallRenderComponent(): EditCallRenderComponent {
  return Object.assign(new Box(1, 1, (text: string) => text), {
    preview: undefined as EditPreview | undefined,
    previewArgsKey: undefined as string | undefined,
    previewPending: false,
    settledError: false,
  });
}

function getEditCallRenderComponent(
  state: EditRenderState,
  lastComponent: unknown,
): EditCallRenderComponent {
  if (lastComponent instanceof Box) {
    const component = lastComponent as EditCallRenderComponent;
    state.callComponent = component;
    return component;
  }
  if (state.callComponent) {
    return state.callComponent;
  }
  const component = createEditCallRenderComponent();
  state.callComponent = component;
  return component;
}

function getRenderablePreviewInput(
  args: RenderableEditArgs | undefined,
): { path: string; edits: Edit[] } | null {
  if (!args) {
    return null;
  }

  const path =
    typeof args.path === "string"
      ? args.path
      : typeof args.file_path === "string"
        ? args.file_path
        : null;
  if (!path) {
    return null;
  }

  if (
    Array.isArray(args.edits) &&
    args.edits.length > 0 &&
    args.edits.every(
      (edit) => typeof edit?.oldText === "string" && typeof edit?.newText === "string",
    )
  ) {
    return { path, edits: args.edits };
  }

  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    return { path, edits: [{ oldText: args.oldText, newText: args.newText }] };
  }

  return null;
}

function formatEditCall(
  args: RenderableEditArgs | undefined,
  theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
  const invalidArg = invalidArgText(theme);
  const rawPath = str(args?.file_path ?? args?.path);
  const path = rawPath !== null ? shortenPath(rawPath) : null;
  const pathDisplay =
    path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
  return `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;
}

function formatEditResult(
  args: RenderableEditArgs | undefined,
  preview: EditPreview | undefined,
  result: EditToolResultLike,
  theme: typeof import("../../modes/interactive/theme/theme.js").theme,
  isError: boolean,
): string | undefined {
  const rawPath = str(args?.file_path ?? args?.path);
  const previewDiff = preview && !("error" in preview) ? preview.diff : undefined;
  const previewError = preview && "error" in preview ? preview.error : undefined;
  if (isError) {
    const errorText = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text || "")
      .join("\n");
    if (!errorText || errorText === previewError) {
      return undefined;
    }
    return theme.fg("error", errorText);
  }

  const resultDiff = result.details?.diff;
  if (resultDiff && resultDiff !== previewDiff) {
    return renderDiff(resultDiff, { filePath: rawPath ?? undefined });
  }

  return undefined;
}

function getEditHeaderBg(
  preview: EditPreview | undefined,
  settledError: boolean | undefined,
  theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): (text: string) => string {
  if (preview) {
    if ("error" in preview) {
      return (text: string) => theme.bg("toolErrorBg", text);
    }
    return (text: string) => theme.bg("toolSuccessBg", text);
  }
  if (settledError) {
    return (text: string) => theme.bg("toolErrorBg", text);
  }
  return (text: string) => theme.bg("toolPendingBg", text);
}

function buildEditCallComponent(
  component: EditCallRenderComponent,
  args: RenderableEditArgs | undefined,
  theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): EditCallRenderComponent {
  component.setBgFn(getEditHeaderBg(component.preview, component.settledError, theme));
  component.clear();
  component.addChild(new Text(formatEditCall(args, theme), 0, 0));

  if (!component.preview) {
    return component;
  }

  const body =
    "error" in component.preview
      ? theme.fg("error", component.preview.error)
      : renderDiff(component.preview.diff);
  component.addChild(new Spacer(1));
  component.addChild(new Text(body, 0, 0));
  return component;
}

function setEditPreview(
  component: EditCallRenderComponent,
  preview: EditPreview,
  argsKey: string | undefined,
): boolean {
  const current = component.preview;
  const changed =
    current === undefined ||
    ("error" in current && "error" in preview
      ? current.error !== preview.error
      : "error" in current !== "error" in preview) ||
    (!("error" in current) &&
      !("error" in preview) &&
      (current.diff !== preview.diff || current.firstChangedLine !== preview.firstChangedLine));
  component.preview = preview;
  component.previewArgsKey = argsKey;
  component.previewPending = false;
  return changed;
}

export function createEditToolDefinition(
  cwd: string,
  options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
  const ops = options?.operations ?? defaultEditOperations;
  return {
    name: "edit",
    label: "edit",
    description:
      "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
    promptSnippet:
      "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
    promptGuidelines: [
      "Use edit for precise changes (edits[].oldText must match exactly)",
      "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
      "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
      "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
    ],
    parameters: editSchema,
    renderShell: "self",
    prepareArguments: prepareEditArguments,
    async execute(toolCallId, input: EditToolInput, signal?: AbortSignal, onUpdate?, ctx?) {
      void toolCallId;
      void onUpdate;
      void ctx;
      const { path, edits: originalEdits } = validateEditInput(input);
      const absolutePath = resolveToCwd(path, cwd);

      return withFileMutationQueue(absolutePath, async () => {
        if (signal?.aborted) {
          throw new Error("Operation aborted");
        }

        let realEdits: Edit[] = [];

        try {
          await ops.access(absolutePath);
        } catch (error: unknown) {
          const errorMessage =
            error instanceof Error && "code" in error
              ? `Error code: ${String(error.code)}`
              : String(error);
          throw new Error(`Could not edit file: ${path}. ${errorMessage}.`, {
            cause: error,
          });
        }

        const buffer = await ops.readFile(absolutePath);
        const rawContent = buffer.toString("utf-8");
        let mismatchPhase: EditMismatchPhase = "validation";
        try {
          if (signal?.aborted) {
            throw new Error("Operation aborted");
          }

          const { bom, text: content } = stripBom(rawContent);
          const originalEnding = detectLineEnding(content);
          const normalizedContent = normalizeToLF(content);
          const editSets = splitNoOpEdits(normalizedContent, originalEdits, path);
          const noOpEdits = editSets.noOpEdits;
          realEdits = editSets.realEdits;
          validateNoOpEditTargets(normalizedContent, noOpEdits, realEdits, path);
          if (realEdits.length === 0) {
            return {
              ...textResult(
                `No changes made to ${path}. The replacement text is identical to the original.`,
                undefined,
              ),
              terminate: true,
            };
          }
          mismatchPhase = "apply";
          const { baseContent, newContent } = applyEditsToNormalizedContent(
            normalizedContent,
            realEdits,
            path,
          );
          const finalContent = bom + restoreLineEndings(newContent, originalEnding);
          await ops.writeFile(absolutePath, finalContent);
          if (signal?.aborted) {
            throw new Error("Operation aborted");
          }

          const diffResult = generateDiffString(baseContent, newContent);
          const patch = generateUnifiedPatch(path, baseContent, newContent);
          return {
            content: [
              {
                type: "text",
                text: `Successfully replaced ${realEdits.length} block(s) in ${path}.`,
              },
            ],
            details: {
              diff: diffResult.diff,
              patch,
              firstChangedLine: diffResult.firstChangedLine,
            },
          };
        } catch (error: unknown) {
          const normalizedError = error instanceof Error ? error : new Error(String(error));
          const currentContent = await ops
            .readFile(absolutePath)
            .then((current) => current.toString("utf-8"))
            .catch(() => rawContent);
          if (
            didEditLikelyApply({
              originalContent: rawContent,
              currentContent,
              edits: realEdits,
            })
          ) {
            return {
              content: [
                {
                  type: "text",
                  text: `Successfully replaced ${realEdits.length} block(s) in ${path}.`,
                },
              ],
              details: { diff: "", patch: "" },
            };
          }
          if (
            normalizedError.message.includes(EDIT_MISMATCH_MESSAGE) ||
            normalizedError.message.includes(EDIT_INDEXED_MISMATCH_MESSAGE)
          ) {
            const matchedEdits = mismatchPhase === "apply" ? realEdits : [];
            throw appendMismatchHint(normalizedError, currentContent, matchedEdits);
          }
          // Terminal no-op: the edit matched but produced identical content.
          if (normalizedError instanceof EditNoChangeError) {
            return {
              ...textResult(
                `No changes made to ${path}. The replacement produced identical content.`,
                undefined,
              ),
              terminate: true,
            };
          }
          throw normalizedError;
        }
      });
    },
    renderCall(args, theme, context) {
      const component = getEditCallRenderComponent(context.state, context.lastComponent);
      const previewInput = getRenderablePreviewInput(args as RenderableEditArgs | undefined);
      const argsKey = previewInput
        ? JSON.stringify({ path: previewInput.path, edits: previewInput.edits })
        : undefined;

      if (component.previewArgsKey !== argsKey) {
        component.preview = undefined;
        component.previewArgsKey = argsKey;
        component.previewPending = false;
        component.settledError = false;
      }

      if (context.argsComplete && previewInput && !component.preview && !component.previewPending) {
        component.previewPending = true;
        const requestKey = argsKey;
        void computeEditsDiff(previewInput.path, previewInput.edits, context.cwd, ops).then(
          (preview) => {
            if (component.previewArgsKey === requestKey) {
              setEditPreview(component, preview, requestKey);
              context.invalidate();
            }
          },
        );
      }

      return buildEditCallComponent(component, args, theme);
    },
    renderResult(result, optionsLocal, theme, context) {
      void optionsLocal;
      const callComponent = context.state.callComponent;
      const previewInput = getRenderablePreviewInput(
        context.args as RenderableEditArgs | undefined,
      );
      const argsKey = previewInput
        ? JSON.stringify({ path: previewInput.path, edits: previewInput.edits })
        : undefined;
      const typedResult = result as EditToolResultLike;
      const resultDiff = !context.isError ? typedResult.details?.diff : undefined;
      let changed = false;
      if (callComponent) {
        if (typeof resultDiff === "string") {
          changed =
            setEditPreview(
              callComponent,
              {
                diff: resultDiff,
                firstChangedLine: typedResult.details?.firstChangedLine,
              },
              argsKey,
            ) || changed;
        }
        if (callComponent.settledError !== context.isError) {
          callComponent.settledError = context.isError;
          changed = true;
        }
        if (changed) {
          buildEditCallComponent(
            callComponent,
            context.args as RenderableEditArgs | undefined,
            theme,
          );
        }
      }

      const output = formatEditResult(
        context.args,
        callComponent?.preview,
        typedResult,
        theme,
        context.isError,
      );
      const component = (context.lastComponent as Container | undefined) ?? new Container();
      component.clear();
      if (!output) {
        return component;
      }
      component.addChild(new Spacer(1));
      component.addChild(new Text(output, 1, 0));
      return component;
    },
  };
}

export function createEditTool(
  cwd: string,
  options?: EditToolOptions,
): AgentTool<typeof editSchema> {
  return wrapToolDefinition(createEditToolDefinition(cwd, options));
}
