import { createHash } from "node:crypto";
import {
  buildWatchedSessionsHarnessContext,
  embeddedAgentLog,
  type AgentMessage,
  type ContextEngineProjection,
  type EmbeddedContextFile,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { MESSAGE_TOOL_DELIVERY_HINTS } from "openclaw/plugin-sdk/message-tool-delivery-hints";
import type {
  SessionTranscriptTargetParams,
  TranscriptTurnAdmission,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { readNonBlankString as readNonEmptyString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import {
  CODEX_MEMORY_CONTEXT_BASENAME,
  CODEX_NATIVE_PROJECT_DOC_BASENAMES,
  getCodexContextFileBasename,
  getCodexContextFileDisplayBasename,
  isNonEmptyString,
  normalizeCodexContextFilePath,
  normalizeCodexDynamicToolName,
  shouldInjectCodexOpenClawPromptContext,
  type CodexBootstrapFile,
  type CodexWorkspaceBootstrapContext,
} from "./attempt-workspace-context.js";
import type { CodexDynamicToolFunctionSpec, CodexDynamicToolSpec, JsonValue } from "./protocol.js";
import { flattenCodexDynamicToolFunctions, isJsonObject } from "./protocol.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import { readCodexMirroredSessionHistoryMessages } from "./session-history.js";
import { stabilizeJsonValue } from "./thread-fingerprints.js";
import {
  areCodexDynamicToolFingerprintsCompatible,
  buildContextEngineBinding,
  isContextEngineBindingCompatible,
  type CodexContextEngineThreadBootstrapProjection,
} from "./thread-lifecycle.js";

export type CodexSystemPromptReport = NonNullable<EmbeddedRunAttemptResult["systemPromptReport"]>;
type CodexToolReportEntry = CodexSystemPromptReport["tools"]["entries"][number];

export async function readMirroredSessionHistoryMessages(params: {
  agentId?: string;
  sessionFile: string;
  sessionId: string;
  sessionKey?: string;
  sessionTarget?: Partial<SessionTranscriptTargetParams>;
  admission?: TranscriptTurnAdmission;
  signal?: AbortSignal;
  contextTokenBudget?: number;
}): Promise<AgentMessage[] | undefined> {
  const { admission, signal, contextTokenBudget, ...target } = params;
  const messages = await readCodexMirroredSessionHistoryMessages(
    target,
    admission,
    signal,
    contextTokenBudget,
  );
  if (!messages) {
    embeddedAgentLog.warn("failed to read mirrored session history for codex harness hooks", {
      sessionFile: params.sessionFile,
    });
  }
  return messages;
}

export function readContextEngineThreadBootstrapProjection(
  projection: ContextEngineProjection | undefined,
): CodexContextEngineThreadBootstrapProjection | undefined {
  if (projection?.mode !== "thread_bootstrap") {
    return undefined;
  }
  const epoch = projection.epoch?.trim();
  if (!epoch) {
    embeddedAgentLog.warn(
      "context engine requested Codex thread-bootstrap projection without an epoch; using per-turn projection",
    );
    return undefined;
  }
  const fingerprint = projection.fingerprint?.trim();
  return {
    mode: "thread_bootstrap",
    epoch,
    ...(fingerprint ? { fingerprint } : {}),
  };
}

export function resolveContextEngineBootstrapProjectionDecision(params: {
  startupBinding: CodexAppServerThreadBinding | undefined;
  expectedBinding: ReturnType<typeof buildContextEngineBinding>;
  projection: CodexContextEngineThreadBootstrapProjection;
  dynamicToolsFingerprint: string;
  legacyDynamicToolsFingerprint?: string;
}): { project: boolean; reason: string } {
  const bindingProjection = params.startupBinding?.contextEngine?.projection;
  if (!params.startupBinding?.threadId || !bindingProjection) {
    return {
      project: true,
      reason: !params.startupBinding?.threadId
        ? "missing-thread-binding"
        : "missing-projection-binding",
    };
  }
  if (
    !params.expectedBinding ||
    !isContextEngineBindingCompatible(params.startupBinding.contextEngine, params.expectedBinding)
  ) {
    return { project: true, reason: "context-engine-binding-mismatch" };
  }
  if (
    !areCodexDynamicToolFingerprintsCompatible({
      previous: params.startupBinding.dynamicToolsFingerprint,
      next: params.dynamicToolsFingerprint,
      nextLegacy: params.legacyDynamicToolsFingerprint,
    })
  ) {
    return { project: true, reason: "dynamic-tools-mismatch" };
  }
  const projectionChanged =
    bindingProjection.mode !== "thread_bootstrap" ||
    bindingProjection.epoch !== params.projection.epoch ||
    bindingProjection.fingerprint !== params.projection.fingerprint;
  return projectionChanged
    ? { project: true, reason: "projection-mismatch" }
    : { project: false, reason: "matching-thread-bootstrap-binding" };
}

export function buildCodexSystemPromptReport(params: {
  attempt: EmbeddedRunAttemptParams;
  sessionKey: string;
  workspaceDir: string;
  developerInstructions: string;
  workspaceBootstrapContext: CodexWorkspaceBootstrapContext;
  omitWorkspaceReferences?: boolean;
  skillsPrompt: string;
  tools: CodexDynamicToolSpec[];
}): CodexSystemPromptReport {
  const toolEntries = flattenCodexDynamicToolFunctions(params.tools).map(buildCodexToolReportEntry);
  const schemaChars = toolEntries.reduce((sum, tool) => sum + tool.schemaChars, 0);
  const skillsPrompt = params.skillsPrompt.trim();
  const bootstrapMaxChars = readPositiveNumber(
    params.attempt.config?.agents?.defaults?.bootstrapMaxChars,
  );
  const bootstrapTotalMaxChars = readPositiveNumber(
    params.attempt.config?.agents?.defaults?.bootstrapTotalMaxChars,
  );
  return {
    source: "run",
    generatedAt: Date.now(),
    sessionId: params.attempt.sessionId,
    sessionKey: params.sessionKey,
    provider: params.attempt.provider,
    model: params.attempt.modelId,
    workspaceDir: params.workspaceDir,
    ...(bootstrapMaxChars ? { bootstrapMaxChars } : {}),
    ...(bootstrapTotalMaxChars ? { bootstrapTotalMaxChars } : {}),
    systemPrompt: {
      chars: params.developerInstructions.length,
      projectContextChars: 0,
      nonProjectContextChars: params.developerInstructions.length,
      hash: sha256Text(params.developerInstructions),
    },
    injectedWorkspaceFiles: buildCodexBootstrapInjectionStats({
      bootstrapFiles: params.workspaceBootstrapContext.bootstrapFiles,
      injectedFiles: params.workspaceBootstrapContext.promptContextFiles ?? [],
      omitReferenceFiles: params.omitWorkspaceReferences,
      developerInstructionFiles: [
        ...(params.workspaceBootstrapContext.threadDeveloperInstructionFiles ?? []),
        ...(params.workspaceBootstrapContext.turnScopedDeveloperInstructionFiles ?? []),
      ],
      memoryToolRoutedBootstrapFiles:
        params.workspaceBootstrapContext.memoryToolRoutedBootstrapFiles ?? [],
      memoryToolRouted: params.workspaceBootstrapContext.memoryToolRouted === true,
    }),
    skills: {
      promptChars: skillsPrompt.length,
      hash: sha256Text(skillsPrompt),
      entries: buildCodexSkillReportEntries(skillsPrompt),
    },
    tools: {
      listChars: 0,
      schemaChars,
      entries: toolEntries,
    },
  };
}

function buildCodexSkillReportEntries(
  skillsPrompt: string,
): CodexSystemPromptReport["skills"]["entries"] {
  if (!skillsPrompt) {
    return [];
  }
  return Array.from(skillsPrompt.matchAll(/<skill>[\s\S]*?<\/skill>/gi), ([block]) => ({
    name: block.match(/<name>\s*([^<]+?)\s*<\/name>/i)?.[1]?.trim() || "(unknown)",
    blockChars: block.length,
  }));
}

function buildCodexToolReportEntry(tool: CodexDynamicToolFunctionSpec): CodexToolReportEntry {
  const summary = tool.description.trim();
  return {
    name: tool.name,
    summaryChars: summary.length,
    summaryHash: sha256Text(summary),
    ...(tool.deferLoading === true
      ? { schemaChars: 0, schemaHash: stableJsonHash(null), propertiesCount: null }
      : buildCodexToolSchemaStats(tool.inputSchema)),
  };
}

function buildCodexToolSchemaStats(
  schema: JsonValue,
): Pick<CodexToolReportEntry, "schemaChars" | "schemaHash" | "propertiesCount"> {
  const schemaChars = (() => {
    try {
      return JSON.stringify(schema).length;
    } catch {
      return 0;
    }
  })();
  const properties =
    isJsonObject(schema) && isJsonObject(schema.properties) ? schema.properties : null;
  return {
    schemaChars,
    schemaHash: stableJsonHash(schema),
    propertiesCount: properties ? Object.keys(properties).length : null,
  };
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJsonHash(value: JsonValue): string {
  return sha256Text(JSON.stringify(stabilizeJsonValue(value)) ?? "null");
}

function buildCodexBootstrapInjectionStats(params: {
  bootstrapFiles: CodexBootstrapFile[];
  injectedFiles: EmbeddedContextFile[];
  omitReferenceFiles?: boolean;
  developerInstructionFiles?: EmbeddedContextFile[];
  memoryToolRoutedBootstrapFiles?: CodexBootstrapFile[];
  memoryToolRouted?: boolean;
}): CodexSystemPromptReport["injectedWorkspaceFiles"] {
  const injectedIndex = indexCodexContextFileContent(params.injectedFiles);
  const developerInstructionIndex = indexCodexContextFileContent(
    params.developerInstructionFiles ?? [],
  );
  const memoryToolRoutedPaths = new Set(
    (params.memoryToolRoutedBootstrapFiles ?? [])
      .map((file) => readNonEmptyString(file.path))
      .filter(isNonEmptyString)
      .map(normalizeCodexContextFilePath),
  );
  return params.bootstrapFiles.map((file) => {
    const fileName = readNonEmptyString(file.name);
    const pathValue = readNonEmptyString(file.path) ?? fileName ?? "";
    const displayName = (fileName ?? getCodexContextFileDisplayBasename(pathValue)) || pathValue;
    const baseName = getCodexContextFileBasename(pathValue || fileName || "");
    const rawChars = file.missing ? 0 : (file.content ?? "").trimEnd().length;
    const memoryToolRoutedFile =
      baseName === CODEX_MEMORY_CONTEXT_BASENAME &&
      params.memoryToolRouted === true &&
      memoryToolRoutedPaths.has(normalizeCodexContextFilePath(pathValue));
    const injected = memoryToolRoutedFile
      ? undefined
      : (readCodexIndexedContextFileContent(injectedIndex, pathValue, fileName) ??
        readCodexIndexedContextFileContent(developerInstructionIndex, pathValue, fileName));
    if (
      !file.missing &&
      injected === undefined &&
      CODEX_NATIVE_PROJECT_DOC_BASENAMES.has(baseName)
    ) {
      return {
        name: displayName,
        path: pathValue,
        missing: false,
        rawChars,
        injectionStatus: "native_unverified",
        injectedChars: null,
        truncated: null,
      };
    }
    const omitted =
      memoryToolRoutedFile ||
      (params.omitReferenceFiles &&
        readCodexIndexedContextFileContent(injectedIndex, pathValue, fileName) !== undefined);
    const injectedChars = omitted ? 0 : (injected?.length ?? 0);
    const truncated = omitted ? false : !file.missing && injectedChars < rawChars;
    return {
      name: displayName,
      path: pathValue,
      missing: file.missing,
      rawChars,
      injectedChars,
      truncated,
    };
  });
}

function indexCodexContextFileContent(files: EmbeddedContextFile[]): {
  byPath: Map<string, string>;
  byBaseName: Map<string, string>;
} {
  const byPath = new Map<string, string>();
  const byBaseName = new Map<string, string>();
  for (const file of files) {
    const pathValue = readNonEmptyString(file.path);
    if (!pathValue) {
      continue;
    }
    if (!byPath.has(pathValue)) {
      byPath.set(pathValue, file.content);
    }
    const baseName = getCodexContextFileBasename(pathValue);
    if (baseName && !byBaseName.has(baseName)) {
      byBaseName.set(baseName, file.content);
    }
  }
  return { byPath, byBaseName };
}

function readCodexIndexedContextFileContent(
  index: { byPath: Map<string, string>; byBaseName: Map<string, string> },
  pathValue: string,
  fileName: string | undefined,
): string | undefined {
  const baseName = getCodexContextFileBasename(fileName ?? pathValue);
  return (
    index.byPath.get(pathValue) ??
    (fileName ? index.byPath.get(fileName) : undefined) ??
    (baseName ? index.byBaseName.get(baseName) : undefined)
  );
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export function buildCodexOpenClawPromptContext(params: {
  params: EmbeddedRunAttemptParams;
  workspacePromptContext?: string;
  watchedSessionsContext?: string;
}): string | undefined {
  if (!shouldInjectCodexOpenClawPromptContext(params.params)) {
    return undefined;
  }
  const sections = [
    params.workspacePromptContext?.trim()
      ? ["## OpenClaw Workspace Context", "", params.workspacePromptContext.trim()].join("\n")
      : undefined,
    params.watchedSessionsContext?.trim() || undefined,
  ].filter(isNonEmptyString);
  if (sections.length === 0) {
    return undefined;
  }
  return [
    "OpenClaw runtime context for this turn:",
    "Treat this OpenClaw-provided context as supporting project/user reference for the current request.",
    "",
    ...sections,
  ].join("\n");
}

/**
 * Renders the watched-sessions block for the Codex per-turn runtime context.
 * Codex builds its own instruction layers, so the embedded prompt's Watched
 * Sessions section must be re-surfaced here or Codex-backed main sessions
 * keep refusing cross-session questions (openclaw#114797).
 */
export function buildCodexWatchedSessionsContext(params: {
  attempt: EmbeddedRunAttemptParams;
  dynamicTools: readonly CodexDynamicToolSpec[];
  sessionKey?: string;
  sandboxed?: boolean;
}): string | undefined {
  if (!shouldInjectCodexOpenClawPromptContext(params.attempt)) {
    return undefined;
  }
  return buildWatchedSessionsHarnessContext({
    config: params.attempt.config,
    sessionKey: params.sessionKey,
    sandboxed: params.sandboxed,
    toolNames: flattenCodexDynamicToolFunctions(params.dynamicTools).map((tool) =>
      normalizeCodexDynamicToolName(tool.name),
    ),
  });
}

export function renderCodexSkillsInstructions(params: {
  attempt: EmbeddedRunAttemptParams;
  skillsPrompt?: string;
}): string | undefined {
  if (!shouldInjectCodexOpenClawPromptContext(params.attempt)) {
    return undefined;
  }
  return params.skillsPrompt?.trim()
    ? ["## OpenClaw Skills", "", params.skillsPrompt.trim()].join("\n")
    : undefined;
}

/**
 * Prepends OpenClaw context while preserving leading delivery metadata as
 * routing guidance instead of user request text.
 */
export function prependCodexOpenClawPromptContext(
  prompt: string,
  context: string | undefined,
  options: { preservePromptWithoutContext?: boolean } = {},
): string {
  const { deliveryHint, prompt: promptWithoutDeliveryHint } = splitLeadingCodexDeliveryHint(prompt);
  if (!context?.trim() && (!deliveryHint || options.preservePromptWithoutContext)) {
    return prompt;
  }
  const promptSection = promptWithoutDeliveryHint.startsWith(
    "OpenClaw assembled context for this turn:",
  )
    ? promptWithoutDeliveryHint
    : ["Current user request:", promptWithoutDeliveryHint].join("\n");
  const deliverySection = deliveryHint
    ? [
        "OpenClaw delivery metadata:",
        "This delivery metadata is runtime routing guidance, not the user's request.",
        deliveryHint,
      ].join("\n")
    : undefined;
  return [context?.trim(), deliverySection, promptSection].filter(Boolean).join("\n\n");
}

/**
 * Maps the surviving user-request portion of an input range after delivery
 * metadata has been relocated before the request.
 */
export function resolveCodexDeliveryHintPreservedInputRange(params: {
  prompt: string;
  promptInputRange: { start: number; end: number } | undefined;
  decoratedPrompt: string;
}): { start: number; end: number } | undefined {
  const { prompt, promptInputRange, decoratedPrompt } = params;
  const { deliveryHint, prompt: promptWithoutDeliveryHint } = splitLeadingCodexDeliveryHint(prompt);
  if (
    !deliveryHint ||
    !promptInputRange ||
    promptInputRange.start < 0 ||
    promptInputRange.end < promptInputRange.start ||
    promptInputRange.end > prompt.length ||
    !decoratedPrompt.endsWith(promptWithoutDeliveryHint)
  ) {
    return undefined;
  }
  const promptWithoutDeliveryHintStart = prompt.length - promptWithoutDeliveryHint.length;
  const inputStart = Math.max(promptInputRange.start, promptWithoutDeliveryHintStart);
  const inputEnd = Math.max(
    inputStart,
    Math.min(
      promptInputRange.end,
      promptWithoutDeliveryHint.length + promptWithoutDeliveryHintStart,
    ),
  );
  const decoratedPromptSuffixStart = decoratedPrompt.length - promptWithoutDeliveryHint.length;
  const requestHeader = "Current user request:\n";
  const requestHeaderStart = decoratedPromptSuffixStart - requestHeader.length;
  // Delivery metadata moves outside the request, so retain the remaining input
  // span rather than treating the original, now non-contiguous range as valid.
  return {
    start:
      inputStart === promptWithoutDeliveryHintStart &&
      decoratedPrompt.slice(requestHeaderStart, decoratedPromptSuffixStart) === requestHeader
        ? requestHeaderStart
        : decoratedPromptSuffixStart + inputStart - promptWithoutDeliveryHintStart,
    end: decoratedPromptSuffixStart + inputEnd - promptWithoutDeliveryHintStart,
  };
}

function splitLeadingCodexDeliveryHint(prompt: string): {
  deliveryHint?: string;
  prompt: string;
} {
  const trimmedStart = prompt.trimStart();
  const matchedHint = MESSAGE_TOOL_DELIVERY_HINTS.find((hint) => trimmedStart.startsWith(hint));
  if (!matchedHint) {
    return { prompt };
  }
  // Delivery hints are runtime routing metadata; split them before wrapping the
  // user prompt so Codex does not treat delivery policy as the request itself.
  const remainder = trimmedStart
    .slice(matchedHint.length)
    .replace(/^\s*\n/, "")
    .trimStart();
  return { deliveryHint: matchedHint, prompt: remainder };
}
