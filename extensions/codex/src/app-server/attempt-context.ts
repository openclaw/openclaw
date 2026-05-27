import { createHash } from "node:crypto";
import path from "node:path";
import {
  embeddedAgentLog,
  resolveBootstrapContextForRun,
  type AgentMessage,
  type ContextEngineProjection,
  type EmbeddedContextFile,
  type EmbeddedRunAttemptParams,
  type EmbeddedRunAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexDynamicToolSpec, JsonValue } from "./protocol.js";
import { isJsonObject } from "./protocol.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import { readCodexMirroredSessionHistoryMessages } from "./session-history.js";
import {
  areCodexDynamicToolFingerprintsCompatible,
  buildContextEngineBinding,
  isContextEngineBindingCompatible,
  type CodexContextEngineThreadBootstrapProjection,
} from "./thread-lifecycle.js";

const CODEX_NATIVE_PROJECT_DOC_BASENAMES = new Set(["agents.md"]);
const CODEX_INHERITED_WORKSPACE_DEVELOPER_CONTEXT_BASENAMES = new Set(["tools.md"]);
const CODEX_TURN_SCOPED_WORKSPACE_DEVELOPER_CONTEXT_BASENAMES = new Set([
  "identity.md",
  "soul.md",
  "user.md",
]);
const CODEX_WORKSPACE_DEVELOPER_CONTEXT_BASENAMES = new Set([
  ...CODEX_INHERITED_WORKSPACE_DEVELOPER_CONTEXT_BASENAMES,
  ...CODEX_TURN_SCOPED_WORKSPACE_DEVELOPER_CONTEXT_BASENAMES,
]);
const CODEX_HEARTBEAT_CONTEXT_BASENAME = "heartbeat.md";
const CODEX_BOOTSTRAP_CONTEXT_ORDER = new Map<string, number>([
  ["soul.md", 10],
  ["identity.md", 20],
  ["user.md", 30],
  ["tools.md", 40],
  ["bootstrap.md", 50],
  ["memory.md", 60],
  ["heartbeat.md", 70],
]);

type CodexBootstrapContext = Awaited<ReturnType<typeof resolveBootstrapContextForRun>>;
type CodexBootstrapFile = CodexBootstrapContext["bootstrapFiles"][number];
export type CodexSystemPromptReport = NonNullable<EmbeddedRunAttemptResult["systemPromptReport"]>;
type CodexToolReportEntry = CodexSystemPromptReport["tools"]["entries"][number];
type CodexWorkspaceBootstrapContext = CodexBootstrapContext & {
  promptContextFiles?: EmbeddedContextFile[];
  developerInstructionFiles?: EmbeddedContextFile[];
  turnScopedDeveloperInstructionFiles?: EmbeddedContextFile[];
  heartbeatReferenceFiles?: EmbeddedContextFile[];
  promptContext?: string;
  developerInstructions?: string;
  turnScopedDeveloperInstructions?: string;
  heartbeatCollaborationInstructions?: string;
};

export async function readMirroredSessionHistoryMessages(
  sessionFile: string,
): Promise<AgentMessage[] | undefined> {
  const messages = await readCodexMirroredSessionHistoryMessages(sessionFile);
  if (!messages) {
    embeddedAgentLog.warn("failed to read mirrored session history for codex harness hooks", {
      sessionFile,
    });
  }
  return messages;
}

export function shouldProjectMirroredHistoryForCodexStart(params: {
  startupBinding: CodexAppServerThreadBinding | undefined;
  dynamicToolsFingerprint: string;
  historyMessages: AgentMessage[];
  forceProject?: boolean;
}): boolean {
  if (!params.historyMessages.some((message) => message.role === "user")) {
    return false;
  }
  if (params.forceProject) {
    return true;
  }
  if (!params.startupBinding?.threadId) {
    return true;
  }
  if (
    hasUserVisibleHistoryAfterCodexBinding({
      startupBinding: params.startupBinding,
      historyMessages: params.historyMessages,
    })
  ) {
    return true;
  }
  return !areCodexDynamicToolFingerprintsCompatible({
    previous: params.startupBinding.dynamicToolsFingerprint,
    next: params.dynamicToolsFingerprint,
  });
}

export function hasUserVisibleHistoryAfterCodexBinding(params: {
  startupBinding: CodexAppServerThreadBinding;
  historyMessages: AgentMessage[];
}): boolean {
  const bindingUpdatedAt = Date.parse(params.startupBinding.updatedAt);
  if (!Number.isFinite(bindingUpdatedAt)) {
    return false;
  }
  return params.historyMessages.some((message) => {
    if (message.role !== "user" && message.role !== "assistant") {
      return false;
    }
    if (isCodexAppServerMirroredTranscriptMessage(message)) {
      return false;
    }
    const timestamp =
      typeof message.timestamp === "number"
        ? message.timestamp
        : typeof message.timestamp === "string"
          ? Date.parse(message.timestamp)
          : Number.NaN;
    return Number.isFinite(timestamp) && timestamp > bindingUpdatedAt;
  });
}

export function isCodexAppServerMirroredTranscriptMessage(message: AgentMessage): boolean {
  const record = message as unknown as Record<string, unknown>;
  const idempotencyKey = record.idempotencyKey;
  if (typeof idempotencyKey === "string" && idempotencyKey.startsWith("codex-app-server:")) {
    return true;
  }
  const meta = record["__openclaw"];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return false;
  }
  return typeof (meta as Record<string, unknown>).mirrorIdentity === "string";
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

export async function buildCodexWorkspaceBootstrapContext(params: {
  params: EmbeddedRunAttemptParams;
  resolvedWorkspace: string;
  effectiveWorkspace: string;
  sessionKey: string;
  sessionAgentId: string;
}): Promise<CodexWorkspaceBootstrapContext> {
  try {
    const bootstrapContext = await resolveBootstrapContextForRun({
      workspaceDir: params.resolvedWorkspace,
      config: params.params.config,
      sessionKey: params.sessionKey,
      sessionId: params.params.sessionId,
      agentId: params.params.agentId ?? params.sessionAgentId,
      warn: (message) => embeddedAgentLog.warn(message),
      contextMode: params.params.bootstrapContextMode,
      runKind: params.params.bootstrapContextRunKind,
    });
    const contextFiles = bootstrapContext.contextFiles.map((file) =>
      remapCodexContextFilePath({
        file,
        sourceWorkspaceDir: params.resolvedWorkspace,
        targetWorkspaceDir: params.effectiveWorkspace,
      }),
    );
    const promptContextFiles = selectCodexWorkspacePromptContextFiles(contextFiles);
    const developerInstructionFiles = shouldInjectCodexOpenClawPromptContext(params.params)
      ? selectCodexWorkspaceInheritedDeveloperInstructionFiles(contextFiles)
      : [];
    const turnScopedDeveloperInstructionFiles = shouldInjectCodexOpenClawPromptContext(
      params.params,
    )
      ? selectCodexWorkspaceTurnScopedDeveloperInstructionFiles(contextFiles)
      : [];
    const heartbeatReferenceFiles = selectCodexWorkspaceHeartbeatReferenceFiles(contextFiles);
    return {
      ...bootstrapContext,
      contextFiles,
      promptContextFiles,
      developerInstructionFiles,
      turnScopedDeveloperInstructionFiles,
      heartbeatReferenceFiles,
      promptContext: renderCodexWorkspaceBootstrapPromptContext(promptContextFiles),
      developerInstructions:
        renderCodexWorkspaceThreadDeveloperInstructions(developerInstructionFiles),
      turnScopedDeveloperInstructions: renderCodexWorkspaceCollaborationDeveloperInstructions(
        turnScopedDeveloperInstructionFiles,
      ),
      heartbeatCollaborationInstructions:
        renderCodexWorkspaceHeartbeatReference(heartbeatReferenceFiles),
    };
  } catch (error) {
    embeddedAgentLog.warn("failed to load codex workspace bootstrap instructions", { error });
    return { bootstrapFiles: [], contextFiles: [] };
  }
}

export function buildCodexSystemPromptReport(params: {
  attempt: EmbeddedRunAttemptParams;
  sessionKey: string;
  workspaceDir: string;
  developerInstructions: string;
  workspaceBootstrapContext: CodexWorkspaceBootstrapContext;
  skillsPrompt: string;
  tools: CodexDynamicToolSpec[];
}): CodexSystemPromptReport {
  const toolEntries = params.tools.map(buildCodexToolReportEntry);
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
      developerInstructionFiles: [
        ...(params.workspaceBootstrapContext.developerInstructionFiles ?? []),
        ...(params.workspaceBootstrapContext.turnScopedDeveloperInstructionFiles ?? []),
      ],
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
  return Array.from(skillsPrompt.matchAll(/<skill>[\s\S]*?<\/skill>/gi))
    .map((match) => match[0] ?? "")
    .map((block) => ({
      name: block.match(/<name>\s*([^<]+?)\s*<\/name>/i)?.[1]?.trim() || "(unknown)",
      blockChars: block.length,
    }))
    .filter((entry) => entry.blockChars > 0);
}

function buildCodexToolReportEntry(tool: CodexDynamicToolSpec): CodexToolReportEntry {
  const summary = tool.description.trim();
  if (tool.deferLoading === true) {
    return {
      name: tool.name,
      summaryChars: summary.length,
      summaryHash: sha256Text(summary),
      schemaChars: 0,
      schemaHash: stableJsonHash(null),
      propertiesCount: null,
    };
  }
  return {
    name: tool.name,
    summaryChars: summary.length,
    summaryHash: sha256Text(summary),
    ...buildCodexToolSchemaStats(tool.inputSchema),
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

function normalizeForStableHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForStableHash(entry));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .toSorted((left, right) => left.localeCompare(right))
        .map((key) => [key, normalizeForStableHash(record[key])]),
    );
  }
  return value;
}

function stableJsonHash(value: JsonValue): string {
  return sha256Text(JSON.stringify(normalizeForStableHash(value)) ?? "null");
}

function buildCodexBootstrapInjectionStats(params: {
  bootstrapFiles: CodexBootstrapFile[];
  injectedFiles: EmbeddedContextFile[];
  developerInstructionFiles?: EmbeddedContextFile[];
}): CodexSystemPromptReport["injectedWorkspaceFiles"] {
  const injectedIndex = indexCodexContextFileContent(params.injectedFiles);
  const developerInstructionIndex = indexCodexContextFileContent(
    params.developerInstructionFiles ?? [],
  );
  return params.bootstrapFiles.map((file) => {
    const fileName = readNonEmptyString(file.name);
    const pathValue = readNonEmptyString(file.path) ?? fileName ?? "";
    const displayName = (fileName ?? getCodexContextFileDisplayBasename(pathValue)) || pathValue;
    const baseName = getCodexContextFileBasename(pathValue || fileName || "");
    const rawChars = file.missing ? 0 : (file.content ?? "").trimEnd().length;
    const injected =
      readCodexIndexedContextFileContent(injectedIndex, pathValue, fileName) ??
      readCodexIndexedContextFileContent(developerInstructionIndex, pathValue, fileName);
    let injectedChars = injected?.length ?? 0;
    let truncated = !file.missing && injectedChars < rawChars;
    if (injected === undefined) {
      if (CODEX_NATIVE_PROJECT_DOC_BASENAMES.has(baseName)) {
        injectedChars = rawChars;
        truncated = false;
      } else if (baseName === CODEX_HEARTBEAT_CONTEXT_BASENAME) {
        injectedChars = 0;
        truncated = false;
      }
    }
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
  const pathContent = index.byPath.get(pathValue);
  if (pathContent !== undefined) {
    return pathContent;
  }
  if (fileName) {
    const nameContent = index.byPath.get(fileName);
    if (nameContent !== undefined) {
      return nameContent;
    }
  }
  const baseName = getCodexContextFileBasename(fileName ?? pathValue);
  return baseName ? index.byBaseName.get(baseName) : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function buildCodexOpenClawPromptContext(params: {
  params: EmbeddedRunAttemptParams;
  skillsPrompt?: string;
  workspacePromptContext?: string;
}): string | undefined {
  if (!shouldInjectCodexOpenClawPromptContext(params.params)) {
    return undefined;
  }
  const sections = [
    params.skillsPrompt?.trim()
      ? ["## OpenClaw Skills", "", params.skillsPrompt.trim()].join("\n")
      : undefined,
    params.workspacePromptContext?.trim()
      ? ["## OpenClaw Workspace Context", "", params.workspacePromptContext.trim()].join("\n")
      : undefined,
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

function shouldInjectCodexOpenClawPromptContext(params: EmbeddedRunAttemptParams): boolean {
  // Lightweight cron runs are commonly exact commands. Keep the user input byte-for-byte
  // to avoid changing command intent while Codex keeps its native project-doc loader.
  return !(
    params.bootstrapContextMode === "lightweight" && params.bootstrapContextRunKind === "cron"
  );
}

export function prependCodexOpenClawPromptContext(
  prompt: string,
  context: string | undefined,
): string {
  if (!context?.trim()) {
    return prompt;
  }
  const { deliveryHint, prompt: promptWithoutDeliveryHint } = splitLeadingCodexDeliveryHint(prompt);
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
  return [context.trim(), deliverySection, promptSection].filter(Boolean).join("\n\n");
}

const CODEX_DELIVERY_HINT_LINES = [
  "Delivery: to send a message, use the `message` tool.",
  "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send user-visible output.",
] as const;

function splitLeadingCodexDeliveryHint(prompt: string): {
  deliveryHint?: string;
  prompt: string;
} {
  const trimmedStart = prompt.trimStart();
  const matchedHint = CODEX_DELIVERY_HINT_LINES.find((hint) => trimmedStart.startsWith(hint));
  if (!matchedHint) {
    return { prompt };
  }
  const remainder = trimmedStart
    .slice(matchedHint.length)
    .replace(/^\s*\n/, "")
    .trimStart();
  return { deliveryHint: matchedHint, prompt: remainder };
}

function renderCodexWorkspaceBootstrapPromptContext(
  contextFiles: EmbeddedContextFile[],
): string | undefined {
  const files = selectCodexWorkspacePromptContextFiles(contextFiles);
  if (files.length === 0) {
    return undefined;
  }
  const lines = [
    "OpenClaw loaded these user-editable workspace files for the current turn. Codex loads AGENTS.md natively. TOOLS.md is provided as inherited Codex developer instructions. SOUL.md, IDENTITY.md, and USER.md are provided as turn-scoped collaboration instructions so native Codex subagents do not inherit them. HEARTBEAT.md is handled by heartbeat collaboration-mode guidance. Those files are not repeated here.",
    "",
    "# Project Context",
    "",
    "The following project context files have been loaded:",
  ];
  lines.push("");
  for (const file of files) {
    lines.push(`## ${file.path}`, "", file.content, "");
  }
  return lines.join("\n").trim();
}

function selectCodexWorkspacePromptContextFiles(
  contextFiles: EmbeddedContextFile[],
): EmbeddedContextFile[] {
  return contextFiles
    .filter((file) => {
      const baseName = getCodexContextFileBasename(file.path);
      return (
        baseName &&
        !CODEX_NATIVE_PROJECT_DOC_BASENAMES.has(baseName) &&
        !CODEX_WORKSPACE_DEVELOPER_CONTEXT_BASENAMES.has(baseName) &&
        baseName !== CODEX_HEARTBEAT_CONTEXT_BASENAME &&
        !isMissingCodexBootstrapContextFile(file)
      );
    })
    .toSorted(compareCodexContextFiles);
}

function selectCodexWorkspaceInheritedDeveloperInstructionFiles(
  contextFiles: EmbeddedContextFile[],
): EmbeddedContextFile[] {
  return selectCodexWorkspaceDeveloperInstructionFiles(
    contextFiles,
    CODEX_INHERITED_WORKSPACE_DEVELOPER_CONTEXT_BASENAMES,
  );
}

function selectCodexWorkspaceTurnScopedDeveloperInstructionFiles(
  contextFiles: EmbeddedContextFile[],
): EmbeddedContextFile[] {
  return selectCodexWorkspaceDeveloperInstructionFiles(
    contextFiles,
    CODEX_TURN_SCOPED_WORKSPACE_DEVELOPER_CONTEXT_BASENAMES,
  );
}

function selectCodexWorkspaceDeveloperInstructionFiles(
  contextFiles: EmbeddedContextFile[],
  basenames: ReadonlySet<string>,
): EmbeddedContextFile[] {
  return contextFiles
    .filter((file) => {
      const baseName = getCodexContextFileBasename(file.path);
      return (
        baseName &&
        basenames.has(baseName) &&
        !isMissingCodexBootstrapContextFile(file) &&
        file.content.trim().length > 0
      );
    })
    .toSorted(compareCodexContextFiles);
}

function renderCodexWorkspaceThreadDeveloperInstructions(
  files: EmbeddedContextFile[],
): string | undefined {
  return renderCodexWorkspaceDeveloperInstructions({
    files,
    header: "## OpenClaw Workspace Instructions",
    preamble:
      "OpenClaw loaded these workspace instruction files from the active agent workspace. Internalize and follow them accordingly.",
  });
}

function renderCodexWorkspaceCollaborationDeveloperInstructions(
  files: EmbeddedContextFile[],
): string | undefined {
  return renderCodexWorkspaceDeveloperInstructions({
    files,
    header: "## OpenClaw Agent Soul",
    preamble:
      "OpenClaw loaded these workspace instruction files from the active agent workspace. They are the canonical definitions of who you are, how you think and work, and the human you work alongside. Internalize and follow them accordingly.",
  });
}

function renderCodexWorkspaceDeveloperInstructions(params: {
  files: EmbeddedContextFile[];
  header: string;
  preamble: string;
}): string | undefined {
  const { files, header, preamble } = params;
  if (files.length === 0) {
    return undefined;
  }
  const lines = [header, "", preamble, ""];
  for (const file of files) {
    lines.push(`### ${file.path}`, "", file.content, "");
  }
  return lines.join("\n").trim();
}

function selectCodexWorkspaceHeartbeatReferenceFiles(
  contextFiles: EmbeddedContextFile[],
): EmbeddedContextFile[] {
  return contextFiles
    .filter((file) => {
      const baseName = getCodexContextFileBasename(file.path);
      return (
        baseName === CODEX_HEARTBEAT_CONTEXT_BASENAME &&
        !isMissingCodexBootstrapContextFile(file) &&
        file.content.trim().length > 0
      );
    })
    .toSorted(compareCodexContextFiles);
}

function renderCodexWorkspaceHeartbeatReference(files: EmbeddedContextFile[]): string | undefined {
  if (files.length === 0) {
    return undefined;
  }
  const lines = [
    "## OpenClaw Heartbeat Workspace",
    "",
    "HEARTBEAT.md exists in the active agent workspace. Read it before proceeding with this heartbeat, then decide what action is appropriate.",
    "",
  ];
  for (const file of files) {
    lines.push(`- ${file.path}`);
  }
  return lines.join("\n").trim();
}

function isMissingCodexBootstrapContextFile(file: EmbeddedContextFile): boolean {
  return file.content.trimStart().startsWith("[MISSING] Expected at:");
}

export function remapCodexContextFilePath(params: {
  file: EmbeddedContextFile;
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
}): EmbeddedContextFile {
  const relativePath = path.relative(params.sourceWorkspaceDir, params.file.path);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath) ||
    params.sourceWorkspaceDir === params.targetWorkspaceDir
  ) {
    return params.file;
  }
  const targetUsesPosixSeparators =
    params.targetWorkspaceDir.includes("/") && !params.targetWorkspaceDir.includes("\\");
  const normalizedRelativePath = targetUsesPosixSeparators
    ? relativePath.replaceAll("\\", "/")
    : relativePath.replaceAll("/", "\\");
  return {
    ...params.file,
    path: targetUsesPosixSeparators
      ? path.posix.join(params.targetWorkspaceDir, normalizedRelativePath)
      : path.win32.join(params.targetWorkspaceDir, normalizedRelativePath),
  };
}

function compareCodexContextFiles(left: EmbeddedContextFile, right: EmbeddedContextFile): number {
  const leftPath = normalizeCodexContextFilePath(left.path);
  const rightPath = normalizeCodexContextFilePath(right.path);
  const leftBase = getCodexContextFileBasename(left.path);
  const rightBase = getCodexContextFileBasename(right.path);
  const leftOrder = CODEX_BOOTSTRAP_CONTEXT_ORDER.get(leftBase) ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = CODEX_BOOTSTRAP_CONTEXT_ORDER.get(rightBase) ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  if (leftBase !== rightBase) {
    return leftBase.localeCompare(rightBase);
  }
  return leftPath.localeCompare(rightPath);
}

function normalizeCodexContextFilePath(filePath: string): string {
  return filePath.trim().replaceAll("\\", "/").toLowerCase();
}

function getCodexContextFileDisplayBasename(filePath: string): string {
  return filePath.trim().replaceAll("\\", "/").split("/").pop()?.trim() ?? "";
}

function getCodexContextFileBasename(filePath: string): string {
  return normalizeCodexContextFilePath(filePath).split("/").pop() ?? "";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
