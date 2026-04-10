import fs from "node:fs/promises";
import path from "node:path";
import type { AgentContextInjection } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import { isPathWithinRoot } from "../shared/avatar-policy.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveUserPath } from "../utils.js";
import { resolveAgentConfig, resolveSessionAgentIds } from "./agent-scope.js";
import { getOrLoadBootstrapFiles } from "./bootstrap-cache.js";
import { applyBootstrapHookOverrides } from "./bootstrap-hooks.js";
import { shouldIncludeHeartbeatGuidanceForSystemPrompt } from "./heartbeat-system-prompt.js";
import { modelKey } from "./model-selection.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import {
  buildBootstrapContextFiles,
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "./pi-embedded-helpers.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  filterBootstrapFilesForSession,
  loadWorkspaceBootstrapFileFromPath,
  loadWorkspaceBootstrapFiles,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

export type BootstrapContextMode = "full" | "lightweight";
export type BootstrapContextRunKind = "default" | "heartbeat" | "cron";

const CONTINUATION_SCAN_MAX_TAIL_BYTES = 256 * 1024;
const CONTINUATION_SCAN_MAX_RECORDS = 500;
export const FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE = "openclaw:bootstrap-context:full";
const DEFAULT_BOOTSTRAP_SIGNATURE = `agents:${DEFAULT_AGENTS_FILENAME}`;

type AgentsBootstrapRunRole = "main" | "subagent";

export type ResolvedAgentsBootstrapFile = {
  bootstrapFile: WorkspaceBootstrapFile;
  bootstrapSignature: string;
  modelRefKey?: string;
  runRole: AgentsBootstrapRunRole;
};

export function resolveContextInjectionMode(config?: OpenClawConfig): AgentContextInjection {
  return config?.agents?.defaults?.contextInjection ?? "always";
}

function normalizeBootstrapSignature(value: string | undefined | null): string | undefined {
  const trimmed = normalizeOptionalString(value);
  return trimmed || undefined;
}

export async function hasCompletedBootstrapTurn(
  sessionFile: string,
  bootstrapSignature?: string,
): Promise<boolean> {
  const expectedSignature = normalizeBootstrapSignature(bootstrapSignature);
  try {
    const stat = await fs.lstat(sessionFile);
    if (stat.isSymbolicLink()) {
      return false;
    }

    const fh = await fs.open(sessionFile, "r");
    try {
      const bytesToRead = Math.min(stat.size, CONTINUATION_SCAN_MAX_TAIL_BYTES);
      if (bytesToRead <= 0) {
        return false;
      }
      const start = stat.size - bytesToRead;
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await fh.read(buffer, 0, bytesToRead, start);
      let text = buffer.toString("utf-8", 0, bytesRead);
      if (start > 0) {
        const firstNewline = text.indexOf("\n");
        if (firstNewline === -1) {
          return false;
        }
        text = text.slice(firstNewline + 1);
      }

      const records = text
        .split(/\r?\n/u)
        .filter((line) => line.trim().length > 0)
        .slice(-CONTINUATION_SCAN_MAX_RECORDS);
      let compactedAfterLatestAssistant = false;

      for (let i = records.length - 1; i >= 0; i--) {
        const line = records[i];
        if (!line) {
          continue;
        }
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const record = entry as
          | {
              type?: string;
              customType?: string;
              message?: { role?: string };
              data?: { bootstrapSignature?: unknown };
            }
          | null
          | undefined;
        if (record?.type === "compaction") {
          compactedAfterLatestAssistant = true;
          continue;
        }
        if (
          record?.type === "custom" &&
          record.customType === FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE
        ) {
          const recordedSignature =
            typeof record.data?.bootstrapSignature === "string"
              ? normalizeBootstrapSignature(record.data.bootstrapSignature)
              : undefined;
          if (expectedSignature && recordedSignature !== expectedSignature) {
            return false;
          }
          return !compactedAfterLatestAssistant;
        }
      }

      return false;
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

export function makeBootstrapWarn(params: {
  sessionLabel: string;
  warn?: (message: string) => void;
}): ((message: string) => void) | undefined {
  if (!params.warn) {
    return undefined;
  }
  return (message: string) => params.warn?.(`${message} (sessionKey=${params.sessionLabel})`);
}

function sanitizeBootstrapFiles(
  files: WorkspaceBootstrapFile[],
  warn?: (message: string) => void,
): WorkspaceBootstrapFile[] {
  const sanitized: WorkspaceBootstrapFile[] = [];
  for (const file of files) {
    const pathValue = normalizeOptionalString(file.path) ?? "";
    if (!pathValue) {
      warn?.(
        `skipping bootstrap file "${file.name}" — missing or invalid "path" field (hook may have used "filePath" instead)`,
      );
      continue;
    }
    sanitized.push({ ...file, path: pathValue });
  }
  return sanitized;
}

function applyContextModeFilter(params: {
  files: WorkspaceBootstrapFile[];
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
}): WorkspaceBootstrapFile[] {
  const contextMode = params.contextMode ?? "full";
  const runKind = params.runKind ?? "default";
  if (contextMode !== "lightweight") {
    return params.files;
  }
  if (runKind === "heartbeat") {
    return params.files.filter((file) => file.name === "HEARTBEAT.md");
  }
  // cron/default lightweight mode keeps bootstrap context empty on purpose.
  return [];
}

function shouldExcludeHeartbeatBootstrapFile(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  runKind?: BootstrapContextRunKind;
}): boolean {
  if (!params.config || params.runKind === "heartbeat") {
    return false;
  }
  const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey ?? params.sessionId,
    config: params.config,
    agentId: params.agentId,
  });
  if (sessionAgentId !== defaultAgentId) {
    return false;
  }
  return !shouldIncludeHeartbeatGuidanceForSystemPrompt({
    config: params.config,
    agentId: sessionAgentId,
    defaultAgentId,
  });
}

function filterHeartbeatBootstrapFile(
  files: WorkspaceBootstrapFile[],
  excludeHeartbeatBootstrapFile: boolean,
): WorkspaceBootstrapFile[] {
  if (!excludeHeartbeatBootstrapFile) {
    return files;
  }
  return files.filter((file) => file.name !== DEFAULT_HEARTBEAT_FILENAME);
}

function resolveAgentsBootstrapRunRole(params: {
  sessionKey?: string;
  sessionId?: string;
}): AgentsBootstrapRunRole {
  return isSubagentSessionKey(params.sessionKey ?? params.sessionId) ? "subagent" : "main";
}

function buildBootstrapSignature(filePath: string): string {
  const normalizedPath = normalizeOptionalString(filePath)?.replace(/\\/g, "/");
  return normalizedPath ? `agents:${normalizedPath}` : DEFAULT_BOOTSTRAP_SIGNATURE;
}

function formatUnavailableBootstrapFileReason(
  reason: WorkspaceBootstrapFile["unavailableReason"],
): string {
  switch (reason) {
    case "validation":
      return " (rejected by workspace validation)";
    case "io":
      return " (read failed)";
    case "path":
      return " (path was unavailable)";
    default:
      return "";
  }
}

function formatModelMapConfigLabel(baseLabel: string, modelRefKey: string): string {
  return `${baseLabel}[${JSON.stringify(modelRefKey)}]`;
}

function uniqueResolvedPathCandidates(
  candidates: Array<{ label: string; resolvedPath: string } | null>,
): Array<{ label: string; resolvedPath: string }> {
  const seen = new Set<string>();
  const resolved: Array<{ label: string; resolvedPath: string }> = [];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const key = `${candidate.label}|${candidate.resolvedPath}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    resolved.push(candidate);
  }
  return resolved;
}

function resolveConfiguredAgentsPath(params: {
  workspaceDir: string;
  configuredPath: string | undefined;
  label: string;
  warn?: (message: string) => void;
}): string | null {
  const configuredPath = normalizeOptionalString(params.configuredPath);
  if (!configuredPath) {
    return null;
  }
  const resolvedWorkspaceDir = resolveUserPath(params.workspaceDir);
  const resolvedPath = configuredPath.startsWith("~")
    ? resolveUserPath(configuredPath)
    : path.resolve(resolvedWorkspaceDir, configuredPath);
  if (!isPathWithinRoot(resolvedWorkspaceDir, resolvedPath)) {
    params.warn?.(
      `${params.label} must stay within the workspace root; ignoring ${JSON.stringify(configuredPath)}`,
    );
    return null;
  }
  return resolvedPath;
}

export async function resolveEffectiveAgentsBootstrapFileForRun(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  modelProviderId?: string;
  modelId?: string;
  warn?: (message: string) => void;
}): Promise<ResolvedAgentsBootstrapFile> {
  const resolvedWorkspaceDir = resolveUserPath(params.workspaceDir);
  const runRole = resolveAgentsBootstrapRunRole(params);
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey ?? params.sessionId,
    config: params.config,
    agentId: params.agentId,
  });
  const agentConfig =
    params.config && sessionAgentId ? resolveAgentConfig(params.config, sessionAgentId) : undefined;
  const defaultConfig = params.config?.agents?.defaults;
  const baseConfiguredPathLabel =
    runRole === "subagent"
      ? agentConfig?.subagents?.agentsFile !== undefined
        ? `agents.list.${sessionAgentId}.subagents.agentsFile`
        : "agents.defaults.subagents.agentsFile"
      : agentConfig?.agentsFile !== undefined
        ? `agents.list.${sessionAgentId}.agentsFile`
        : "agents.defaults.agentsFile";
  const agentBaseConfiguredPath =
    runRole === "subagent" ? agentConfig?.subagents?.agentsFile : agentConfig?.agentsFile;
  const defaultBaseConfiguredPath =
    runRole === "subagent" ? defaultConfig?.subagents?.agentsFile : defaultConfig?.agentsFile;
  const modelRefKey =
    params.modelProviderId && params.modelId
      ? modelKey(params.modelProviderId, params.modelId)
      : undefined;
  const agentModelConfiguredPath =
    modelRefKey && runRole === "subagent"
      ? agentConfig?.subagents?.agentsFilesByModel?.[modelRefKey]
      : modelRefKey
        ? agentConfig?.agentsFilesByModel?.[modelRefKey]
        : undefined;
  const defaultModelConfiguredPath =
    modelRefKey && runRole === "subagent"
      ? defaultConfig?.subagents?.agentsFilesByModel?.[modelRefKey]
      : modelRefKey
        ? defaultConfig?.agentsFilesByModel?.[modelRefKey]
        : undefined;
  const modelConfiguredPathLabel =
    modelRefKey === undefined
      ? undefined
      : runRole === "subagent"
        ? agentModelConfiguredPath !== undefined
          ? formatModelMapConfigLabel(
              `agents.list.${sessionAgentId}.subagents.agentsFilesByModel`,
              modelRefKey,
            )
          : formatModelMapConfigLabel("agents.defaults.subagents.agentsFilesByModel", modelRefKey)
        : agentModelConfiguredPath !== undefined
          ? formatModelMapConfigLabel(
              `agents.list.${sessionAgentId}.agentsFilesByModel`,
              modelRefKey,
            )
          : formatModelMapConfigLabel("agents.defaults.agentsFilesByModel", modelRefKey);
  const defaultAgentsPath = path.join(resolvedWorkspaceDir, DEFAULT_AGENTS_FILENAME);

  const loadSelectedFile = async (selectedPath: string) =>
    await loadWorkspaceBootstrapFileFromPath({
      workspaceDir: resolvedWorkspaceDir,
      filePath: selectedPath,
      name: DEFAULT_AGENTS_FILENAME,
    });

  const resolveCandidatePath = (
    configuredPath: string | undefined,
    label: string,
  ): { label: string; resolvedPath: string } | null => {
    const resolvedPath = resolveConfiguredAgentsPath({
      workspaceDir: resolvedWorkspaceDir,
      configuredPath,
      label,
      warn: params.warn,
    });
    return resolvedPath ? { label, resolvedPath } : null;
  };

  const baseCandidates = uniqueResolvedPathCandidates([
    resolveCandidatePath(agentBaseConfiguredPath, baseConfiguredPathLabel),
    resolveCandidatePath(
      defaultBaseConfiguredPath,
      runRole === "subagent"
        ? "agents.defaults.subagents.agentsFile"
        : "agents.defaults.agentsFile",
    ),
  ]);

  const tryLoadPath = async (
    candidate: { label: string; resolvedPath: string },
    warningMessage?: string,
  ): Promise<WorkspaceBootstrapFile | null> => {
    const loaded = await loadSelectedFile(candidate.resolvedPath);
    if (!loaded.missing) {
      return loaded;
    }
    if (warningMessage) {
      params.warn?.(
        `${warningMessage}${formatUnavailableBootstrapFileReason(loaded.unavailableReason)}`,
      );
    }
    return null;
  };

  let resolvedFile: WorkspaceBootstrapFile | null = null;
  const modelCandidates =
    modelRefKey === undefined
      ? []
      : uniqueResolvedPathCandidates([
          resolveCandidatePath(
            agentModelConfiguredPath,
            runRole === "subagent"
              ? formatModelMapConfigLabel(
                  `agents.list.${sessionAgentId}.subagents.agentsFilesByModel`,
                  modelRefKey,
                )
              : formatModelMapConfigLabel(
                  `agents.list.${sessionAgentId}.agentsFilesByModel`,
                  modelRefKey,
                ),
          ),
          agentModelConfiguredPath !== undefined
            ? resolveCandidatePath(
                defaultModelConfiguredPath,
                runRole === "subagent"
                  ? formatModelMapConfigLabel(
                      "agents.defaults.subagents.agentsFilesByModel",
                      modelRefKey,
                    )
                  : formatModelMapConfigLabel("agents.defaults.agentsFilesByModel", modelRefKey),
              )
            : resolveCandidatePath(defaultModelConfiguredPath, modelConfiguredPathLabel ?? ""),
        ]);

  for (const candidate of modelCandidates) {
    resolvedFile = await tryLoadPath(
      candidate,
      `configured AGENTS file from ${candidate.label} could not be loaded at ${candidate.resolvedPath}; falling back`,
    );
    if (resolvedFile) {
      break;
    }
  }

  if (!resolvedFile) {
    for (const candidate of baseCandidates) {
      resolvedFile = await tryLoadPath(
        candidate,
        candidate.resolvedPath !== defaultAgentsPath
          ? `configured AGENTS file from ${candidate.label} could not be loaded at ${candidate.resolvedPath}; falling back`
          : undefined,
      );
      if (resolvedFile) {
        break;
      }
    }
  }

  if (!resolvedFile) {
    resolvedFile = await loadSelectedFile(defaultAgentsPath);
  }

  return {
    bootstrapFile: resolvedFile,
    bootstrapSignature: buildBootstrapSignature(resolvedFile.path),
    modelRefKey,
    runRole,
  };
}

export async function resolveBootstrapFilesForRun(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  modelProviderId?: string;
  modelId?: string;
  warn?: (message: string) => void;
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
}): Promise<WorkspaceBootstrapFile[]> {
  const excludeHeartbeatBootstrapFile = shouldExcludeHeartbeatBootstrapFile(params);
  const sessionKey = params.sessionKey ?? params.sessionId;
  const rawFiles = params.sessionKey
    ? await getOrLoadBootstrapFiles({
        workspaceDir: params.workspaceDir,
        sessionKey: params.sessionKey,
      })
    : await loadWorkspaceBootstrapFiles(params.workspaceDir);
  const bootstrapFiles = applyContextModeFilter({
    files: filterBootstrapFilesForSession(rawFiles, sessionKey),
    contextMode: params.contextMode,
    runKind: params.runKind,
  });
  let bootstrapFilesWithAgentsOverride = bootstrapFiles;
  if (bootstrapFiles.some((file) => file.name === DEFAULT_AGENTS_FILENAME)) {
    const selectedAgentsFile = await resolveEffectiveAgentsBootstrapFileForRun(params);
    bootstrapFilesWithAgentsOverride = bootstrapFiles.map((file) =>
      file.name === DEFAULT_AGENTS_FILENAME ? selectedAgentsFile.bootstrapFile : file,
    );
  }

  const updated = await applyBootstrapHookOverrides({
    files: bootstrapFilesWithAgentsOverride,
    workspaceDir: params.workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
    modelProviderId: params.modelProviderId,
    modelId: params.modelId,
  });
  return sanitizeBootstrapFiles(
    filterHeartbeatBootstrapFile(updated, excludeHeartbeatBootstrapFile),
    params.warn,
  );
}

export async function resolveBootstrapContextForRun(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  modelProviderId?: string;
  modelId?: string;
  warn?: (message: string) => void;
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
}): Promise<{
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
  bootstrapSignature: string;
}> {
  const bootstrapFiles = await resolveBootstrapFilesForRun(params);
  const contextFiles = buildBootstrapContextFiles(bootstrapFiles, {
    maxChars: resolveBootstrapMaxChars(params.config),
    totalMaxChars: resolveBootstrapTotalMaxChars(params.config),
    warn: params.warn,
  });
  const selectedAgentsFile =
    bootstrapFiles.find((file) => file.name === DEFAULT_AGENTS_FILENAME)?.path ?? "";
  return {
    bootstrapFiles,
    contextFiles,
    bootstrapSignature: buildBootstrapSignature(selectedAgentsFile),
  };
}
