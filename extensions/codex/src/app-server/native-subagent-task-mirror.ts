import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CodexServerNotification,
  CodexSessionSource,
  CodexSubAgentThreadSpawnSource,
  CodexThread,
  CodexThreadStartedNotification,
  CodexThreadStatus,
  CodexThreadStatusChangedNotification,
  JsonObject,
  JsonValue,
} from "./protocol.js";
import { isJsonObject } from "./protocol.js";

const CODEX_NATIVE_SUBAGENT_RUNTIME = "subagent";
const CODEX_NATIVE_SUBAGENT_TASK_KIND = "codex-native";
const CODEX_NATIVE_TASK_RUNTIME_MODULE_ID = "openclaw/plugin-sdk/codex-native-task-runtime";
const CODEX_NATIVE_TASK_RUNTIME_SOURCE_FILE = path.join(
  "src",
  "plugin-sdk",
  "codex-native-task-runtime.ts",
);
const CODEX_NATIVE_TASK_RUNTIME_DIST_FILE = path.join(
  "dist",
  "plugin-sdk",
  "codex-native-task-runtime.js",
);
const requireCodexAppServerTaskRuntime = createRequire(import.meta.url);

export type TaskLifecycleRuntime = {
  createRunningTaskRun: (params: Record<string, unknown>) => unknown;
  recordTaskRunProgressByRunId: (params: Record<string, unknown>) => unknown;
  finalizeTaskRunByRunId: (params: Record<string, unknown>) => unknown;
};

export type CodexNativeSubagentTaskMirrorParams = {
  parentThreadId: string;
  requesterSessionKey?: string;
  agentId?: string;
  now?: () => number;
};

type RuntimeModuleRequire = (id: string) => unknown;
type RuntimeModuleLoader = (id: string) => unknown;
type RuntimeModuleLoaderFactory = (
  filename: string,
  options: Record<string, unknown>,
) => RuntimeModuleLoader;
type RuntimeResolutionContext = {
  moduleUrl: string;
  requireModule: RuntimeModuleRequire;
  argv1?: string;
  createJiti?: RuntimeModuleLoaderFactory;
};
type RuntimeArtifactCandidate = {
  filePath: string;
  packageRoot: string;
};

const unavailableRuntime: TaskLifecycleRuntime = {
  createRunningTaskRun: () => undefined,
  recordTaskRunProgressByRunId: () => undefined,
  finalizeTaskRunByRunId: () => undefined,
};

let defaultRuntime: TaskLifecycleRuntime | undefined;

function normalizeRuntimeModule(value: unknown): TaskLifecycleRuntime | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const runtime = value as Partial<TaskLifecycleRuntime>;
  if (
    typeof runtime.createRunningTaskRun === "function" &&
    typeof runtime.recordTaskRunProgressByRunId === "function" &&
    typeof runtime.finalizeTaskRunByRunId === "function"
  ) {
    return runtime as TaskLifecycleRuntime;
  }
  return null;
}

function filePathFromModuleUrl(moduleUrl: string): string | null {
  try {
    return fileURLToPath(moduleUrl);
  } catch {
    return null;
  }
}

function readPackageName(packageRoot: string): string | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8"),
    ) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

function isOpenClawRuntimePackageRoot(packageRoot: string): boolean {
  return (
    readPackageName(packageRoot) === "openclaw" &&
    (fs.existsSync(path.join(packageRoot, CODEX_NATIVE_TASK_RUNTIME_SOURCE_FILE)) ||
      fs.existsSync(path.join(packageRoot, CODEX_NATIVE_TASK_RUNTIME_DIST_FILE)))
  );
}

function findOpenClawRuntimePackageRoot(startDir: string, maxDepth = 12): string | null {
  let cursor = path.resolve(startDir);
  for (let i = 0; i < maxDepth; i += 1) {
    if (isOpenClawRuntimePackageRoot(cursor)) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return null;
}

function listArgv1CandidateDirs(argv1: string): string[] {
  const normalized = path.resolve(argv1);
  const candidates = [path.dirname(normalized)];
  try {
    const real = fs.realpathSync(normalized);
    if (real !== normalized) {
      candidates.push(path.dirname(real));
    }
  } catch {
    // Keep the unresolved argv path if the executable is not readable.
  }
  const parts = normalized.split(path.sep);
  const binIndex = parts.lastIndexOf(".bin");
  if (binIndex > 0 && parts[binIndex - 1] === "node_modules") {
    candidates.push(path.join(parts.slice(0, binIndex).join(path.sep), path.basename(normalized)));
  }
  return candidates;
}

function dedupePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of paths) {
    const resolved = path.resolve(entry);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

function shouldPreferSourceRuntime(modulePath: string): boolean {
  const normalized = modulePath.replace(/\\/g, "/");
  return (
    normalized.includes("/extensions/codex/") &&
    !normalized.includes("/dist/extensions/codex/") &&
    !normalized.includes("/dist-runtime/extensions/codex/")
  );
}

function listRuntimePackageRoots(context: RuntimeResolutionContext): string[] {
  const modulePath = filePathFromModuleUrl(context.moduleUrl);
  const startDirs = [
    ...(modulePath ? [path.dirname(modulePath)] : []),
    ...(context.argv1 ? listArgv1CandidateDirs(context.argv1) : []),
  ];
  const roots = startDirs.flatMap((dir) => {
    const root = findOpenClawRuntimePackageRoot(dir);
    return root ? [root] : [];
  });
  return dedupePaths(roots);
}

function listRuntimeArtifactCandidates(context: RuntimeResolutionContext): RuntimeArtifactCandidate[] {
  const modulePath = filePathFromModuleUrl(context.moduleUrl);
  const relativeFiles =
    modulePath && shouldPreferSourceRuntime(modulePath)
      ? [CODEX_NATIVE_TASK_RUNTIME_SOURCE_FILE, CODEX_NATIVE_TASK_RUNTIME_DIST_FILE]
      : [CODEX_NATIVE_TASK_RUNTIME_DIST_FILE, CODEX_NATIVE_TASK_RUNTIME_SOURCE_FILE];
  return listRuntimePackageRoots(context).flatMap((packageRoot) =>
    relativeFiles.flatMap((relativeFile) => {
      const filePath = path.join(packageRoot, relativeFile);
      return fs.existsSync(filePath) ? [{ filePath, packageRoot }] : [];
    }),
  );
}

function loadCreateJiti(
  candidate: RuntimeArtifactCandidate,
  context: RuntimeResolutionContext,
): RuntimeModuleLoaderFactory | null {
  if (context.createJiti) {
    return context.createJiti;
  }
  try {
    const requireFromRoot = createRequire(path.join(candidate.packageRoot, "package.json"));
    const loaded = requireFromRoot("jiti") as { createJiti?: unknown };
    return typeof loaded.createJiti === "function"
      ? (loaded.createJiti as RuntimeModuleLoaderFactory)
      : null;
  } catch {
    return null;
  }
}

function loadRuntimeWithJiti(
  candidate: RuntimeArtifactCandidate,
  context: RuntimeResolutionContext,
): TaskLifecycleRuntime | null {
  const createJiti = loadCreateJiti(candidate, context);
  if (!createJiti) {
    return null;
  }
  const modulePath = filePathFromModuleUrl(context.moduleUrl) ?? context.moduleUrl;
  try {
    const loader = createJiti(modulePath, {
      interopDefault: true,
      tryNative: false,
      extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"],
    });
    return normalizeRuntimeModule(loader(candidate.filePath));
  } catch {
    return null;
  }
}

function loadRuntimeFromArtifact(
  candidate: RuntimeArtifactCandidate,
  context: RuntimeResolutionContext,
): TaskLifecycleRuntime | null {
  try {
    const runtime = normalizeRuntimeModule(context.requireModule(candidate.filePath));
    if (runtime) {
      return runtime;
    }
  } catch {
    // Source artifacts can contain .js specifiers that only the plugin loader can rewrite.
  }
  return loadRuntimeWithJiti(candidate, context);
}

function createRuntimeResolutionContext(params?: {
  moduleUrl?: string;
  argv1?: string;
  requireModule?: RuntimeModuleRequire;
  createJiti?: RuntimeModuleLoaderFactory;
}): RuntimeResolutionContext {
  const context: RuntimeResolutionContext = {
    moduleUrl: params?.moduleUrl ?? import.meta.url,
    requireModule: params?.requireModule ?? requireCodexAppServerTaskRuntime,
  };
  const argv1 = params?.argv1 ?? process.argv[1];
  if (argv1) {
    context.argv1 = argv1;
  }
  if (params?.createJiti) {
    context.createJiti = params.createJiti;
  }
  return context;
}

function resolveCodexNativeTaskRuntime(
  params?: Parameters<typeof createRuntimeResolutionContext>[0],
): TaskLifecycleRuntime | null {
  const context = createRuntimeResolutionContext(params);
  try {
    const runtime = normalizeRuntimeModule(
      context.requireModule(CODEX_NATIVE_TASK_RUNTIME_MODULE_ID),
    );
    if (runtime) {
      return runtime;
    }
  } catch {
    // The npm-installed Codex plugin may run without this private host-only helper.
  }
  // Source-loaded Codex gets this private subpath from the plugin loader alias
  // layer, which raw createRequire cannot see. Load the equivalent helper from
  // a trusted OpenClaw root before falling back to a no-op runtime.
  for (const candidate of listRuntimeArtifactCandidates(context)) {
    const runtime = loadRuntimeFromArtifact(candidate, context);
    if (runtime) {
      return runtime;
    }
  }
  return null;
}

function resolveDefaultRuntime(): TaskLifecycleRuntime {
  defaultRuntime ??= resolveCodexNativeTaskRuntime() ?? unavailableRuntime;
  return defaultRuntime;
}

export class CodexNativeSubagentTaskMirror {
  private readonly mirroredThreadIds = new Set<string>();
  private readonly terminalRunIds = new Set<string>();
  private readonly now: () => number;

  constructor(
    private readonly params: CodexNativeSubagentTaskMirrorParams,
    private readonly runtime: TaskLifecycleRuntime = resolveDefaultRuntime(),
  ) {
    this.now = params.now ?? Date.now;
  }

  handleNotification(notification: CodexServerNotification): void {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params) {
      return;
    }
    if (notification.method === "thread/started") {
      this.handleThreadStarted(params);
      return;
    }
    if (notification.method === "thread/status/changed") {
      this.handleThreadStatusChanged(params);
      return;
    }
    if (notification.method === "item/started" || notification.method === "item/completed") {
      this.handleCollabAgentItem(params);
    }
  }

  private handleThreadStarted(params: JsonObject): void {
    const notification = readThreadStartedNotification(params);
    if (!notification) {
      return;
    }
    const thread = notification.thread;
    const spawn = readSubagentThreadSpawnSource(thread.source, this.params.parentThreadId);
    if (!spawn) {
      return;
    }
    const threadId = thread.id.trim();
    if (!threadId || this.mirroredThreadIds.has(threadId)) {
      return;
    }
    this.mirroredThreadIds.add(threadId);
    const runId = codexNativeSubagentRunId(threadId);
    const label =
      trimOptional(spawn.agent_nickname) ??
      trimOptional(thread.agentNickname) ??
      trimOptional(spawn.agent_role) ??
      trimOptional(thread.agentRole) ??
      "Codex subagent";
    const task =
      trimOptional(thread.preview) ??
      `Codex native subagent${label === "Codex subagent" ? "" : ` ${label}`}`;
    const createdAt = secondsToMillis(thread.createdAt) ?? this.now();
    this.runtime.createRunningTaskRun({
      runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
      taskKind: CODEX_NATIVE_SUBAGENT_TASK_KIND,
      sourceId: runId,
      requesterSessionKey: this.params.requesterSessionKey,
      ...(this.params.requesterSessionKey
        ? {
            ownerKey: this.params.requesterSessionKey,
            scopeKind: "session" as const,
          }
        : {}),
      agentId: this.params.agentId,
      runId,
      label,
      task,
      notifyPolicy: "silent",
      deliveryStatus: "not_applicable",
      preferMetadata: true,
      startedAt: createdAt,
      lastEventAt: this.now(),
      progressSummary: "Codex native subagent started.",
    });
    this.applyStatus(threadId, thread.status);
  }

  private handleThreadStatusChanged(params: JsonObject): void {
    const notification = readThreadStatusChangedNotification(params);
    if (!notification) {
      return;
    }
    this.applyStatus(notification.threadId, notification.status);
  }

  private applyStatus(threadId: string, status: CodexThreadStatus | null | undefined): void {
    const statusType = status?.type;
    if (!statusType) {
      return;
    }
    const runId = codexNativeSubagentRunId(threadId);
    if (this.terminalRunIds.has(runId) && statusType !== "systemError") {
      return;
    }
    const eventAt = this.now();
    if (statusType === "active") {
      this.runtime.recordTaskRunProgressByRunId({
        runId,
        runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
        lastEventAt: eventAt,
        progressSummary: "Codex native subagent is active.",
      });
      return;
    }
    if (statusType === "idle") {
      this.terminalRunIds.add(runId);
      this.runtime.finalizeTaskRunByRunId({
        runId,
        runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
        status: "succeeded",
        endedAt: eventAt,
        lastEventAt: eventAt,
        progressSummary: "Codex native subagent is idle.",
        terminalSummary: "Codex native subagent finished.",
      });
      return;
    }
    if (statusType === "systemError") {
      this.terminalRunIds.add(runId);
      this.runtime.finalizeTaskRunByRunId({
        runId,
        runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
        status: "failed",
        endedAt: eventAt,
        lastEventAt: eventAt,
        error: "Codex app-server reported a system error for the native subagent thread.",
        progressSummary: "Codex native subagent hit a system error.",
        terminalSummary: "Codex native subagent failed.",
      });
      return;
    }
    if (statusType === "notLoaded") {
      this.runtime.recordTaskRunProgressByRunId({
        runId,
        runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
        lastEventAt: eventAt,
        progressSummary: "Codex native subagent is not loaded.",
      });
    }
  }

  private handleCollabAgentItem(params: JsonObject): void {
    const item = isJsonObject(params.item) ? params.item : undefined;
    if (!item || readString(item, "type") !== "collabAgentToolCall") {
      return;
    }
    if (readString(item, "senderThreadId") !== this.params.parentThreadId) {
      return;
    }
    const receiverThreadIds = readStringArray(item.receiverThreadIds);
    if (normalizeToolName(readString(item, "tool")) === "spawnagent") {
      for (const receiverThreadId of receiverThreadIds) {
        this.createTaskFromCollabSpawnItem(receiverThreadId, item);
      }
    }
    const agentsStates = readAgentsStates(item.agentsStates);
    for (const [threadId, state] of agentsStates) {
      this.applyCollabAgentStatus(threadId, state.status, state.message);
    }
  }

  private createTaskFromCollabSpawnItem(threadId: string, item: JsonObject): void {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId || this.mirroredThreadIds.has(normalizedThreadId)) {
      return;
    }
    this.mirroredThreadIds.add(normalizedThreadId);
    const prompt = trimOptional(readString(item, "prompt"));
    const runId = codexNativeSubagentRunId(normalizedThreadId);
    const createdAt = this.now();
    this.runtime.createRunningTaskRun({
      runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
      taskKind: CODEX_NATIVE_SUBAGENT_TASK_KIND,
      sourceId: runId,
      requesterSessionKey: this.params.requesterSessionKey,
      ...(this.params.requesterSessionKey
        ? {
            ownerKey: this.params.requesterSessionKey,
            scopeKind: "session" as const,
          }
        : {}),
      agentId: this.params.agentId,
      runId,
      label: "Codex subagent",
      task: prompt ?? "Codex native subagent",
      notifyPolicy: "silent",
      deliveryStatus: "not_applicable",
      preferMetadata: true,
      startedAt: createdAt,
      lastEventAt: createdAt,
      progressSummary: "Codex native subagent spawned.",
    });
  }

  private applyCollabAgentStatus(
    threadId: string,
    status: string | undefined,
    message: string | null | undefined,
  ): void {
    const normalizedStatus = normalizeAgentStateStatus(status);
    if (!normalizedStatus) {
      return;
    }
    const runId = codexNativeSubagentRunId(threadId);
    const eventAt = this.now();
    if (normalizedStatus === "pendingInit" || normalizedStatus === "running") {
      this.runtime.recordTaskRunProgressByRunId({
        runId,
        runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
        lastEventAt: eventAt,
        progressSummary:
          trimOptional(message) ??
          (normalizedStatus === "pendingInit"
            ? "Codex native subagent is initializing."
            : "Codex native subagent is running."),
      });
      return;
    }
    if (normalizedStatus === "completed") {
      this.terminalRunIds.add(runId);
      this.runtime.finalizeTaskRunByRunId({
        runId,
        runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
        status: "succeeded",
        endedAt: eventAt,
        lastEventAt: eventAt,
        progressSummary: trimOptional(message) ?? "Codex native subagent completed.",
        terminalSummary: trimOptional(message) ?? "Codex native subagent finished.",
      });
      return;
    }
    this.terminalRunIds.add(runId);
    this.runtime.finalizeTaskRunByRunId({
      runId,
      runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
      status:
        normalizedStatus === "interrupted" || normalizedStatus === "shutdown"
          ? "cancelled"
          : "failed",
      endedAt: eventAt,
      lastEventAt: eventAt,
      error: trimOptional(message) ?? `Codex native subagent status: ${normalizedStatus}`,
      progressSummary: trimOptional(message) ?? `Codex native subagent ${normalizedStatus}.`,
      terminalSummary: trimOptional(message) ?? "Codex native subagent did not complete.",
    });
  }
}

export function codexNativeSubagentRunId(threadId: string): string {
  return `codex-thread:${threadId.trim()}`;
}

export function readSubagentThreadSpawnSource(
  source: CodexSessionSource | null | undefined,
  parentThreadId: string,
): CodexSubAgentThreadSpawnSource | undefined {
  if (!source || typeof source !== "object" || !("subAgent" in source)) {
    return undefined;
  }
  const subAgent = source.subAgent;
  if (!subAgent || typeof subAgent !== "object" || !("thread_spawn" in subAgent)) {
    return undefined;
  }
  const spawn = subAgent.thread_spawn;
  if (!spawn || typeof spawn !== "object") {
    return undefined;
  }
  return spawn.parent_thread_id === parentThreadId ? spawn : undefined;
}

function readThreadStartedNotification(
  params: JsonObject,
): CodexThreadStartedNotification | undefined {
  const thread = params.thread;
  if (!isJsonObject(thread) || typeof thread.id !== "string") {
    return undefined;
  }
  return { thread: thread as CodexThread };
}

function readThreadStatusChangedNotification(
  params: JsonObject,
): CodexThreadStatusChangedNotification | undefined {
  if (typeof params.threadId !== "string") {
    return undefined;
  }
  const status = params.status;
  if (!isJsonObject(status) || !isCodexThreadStatusType(status.type)) {
    return undefined;
  }
  return {
    threadId: params.threadId,
    status: status as CodexThreadStatus,
  };
}

function isCodexThreadStatusType(value: unknown): value is CodexThreadStatus["type"] {
  return value === "notLoaded" || value === "idle" || value === "systemError" || value === "active";
}

function readAgentsStates(
  value: JsonValue | undefined,
): Map<string, { status?: string; message?: string | null }> {
  const states = new Map<string, { status?: string; message?: string | null }>();
  if (!isJsonObject(value)) {
    return states;
  }
  for (const [threadId, rawState] of Object.entries(value)) {
    if (!isJsonObject(rawState)) {
      continue;
    }
    const status = readString(rawState, "status");
    const message = readNullableString(rawState, "message");
    states.set(threadId, { status, message });
  }
  return states;
}

function readStringArray(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

function readString(value: JsonObject, key: string): string | undefined {
  const entry = value[key];
  return typeof entry === "string" ? entry : undefined;
}

function readNullableString(value: JsonObject, key: string): string | null | undefined {
  const entry = value[key];
  return typeof entry === "string" || entry === null ? entry : undefined;
}

function normalizeToolName(value: string | undefined): string | undefined {
  return value?.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function normalizeAgentStateStatus(value: string | undefined): string | undefined {
  const key = value?.replace(/[^a-z0-9]/giu, "").toLowerCase();
  if (!key) {
    return undefined;
  }
  if (key === "pendinginit") {
    return "pendingInit";
  }
  if (key === "inprogress" || key === "running") {
    return "running";
  }
  if (key === "completed" || key === "succeeded" || key === "success") {
    return "completed";
  }
  if (key === "interrupted" || key === "cancelled" || key === "canceled" || key === "shutdown") {
    return key === "shutdown" ? "shutdown" : "interrupted";
  }
  if (key === "failed" || key === "error" || key === "systemerror") {
    return "failed";
  }
  return value?.trim();
}

function secondsToMillis(value: number | null | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value * 1000;
}

function trimOptional(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resetCodexNativeTaskMirrorRuntimeForTests(): void {
  defaultRuntime = undefined;
}

export function resolveCodexNativeTaskRuntimeForTests(
  params?: Parameters<typeof resolveCodexNativeTaskRuntime>[0],
): TaskLifecycleRuntime {
  return resolveCodexNativeTaskRuntime(params) ?? unavailableRuntime;
}
