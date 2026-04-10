import fs from "node:fs/promises";
import path from "node:path";
import type { AgentContextInjection } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import { isPathWithinRoot } from "../shared/avatar-policy.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
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
          if (expectedSignature && recordedSignature && recordedSignature !== expectedSignature) {
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
  const resolvedWorkspaceDir = path.resolve(params.workspaceDir);
  const resolvedPath = path.resolve(resolvedWorkspaceDir, configuredPath);
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
  const resolvedWorkspaceDir = path.resolve(params.workspaceDir);
  const runRole = resolveAgentsBootstrapRunRole(params);
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey ?? params.sessionId,
    config: params.config,
    agentId: params.agentId,
  });
  const agentConfig =
    params.config && sessionAgentId ? resolveAgentConfig(params.config, sessionAgentId) : undefined;
  const defaultConfig = params.config?.agents?.defaults;
  const baseConfiguredPath =
    runRole === "subagent"
      ? (agentConfig?.subagents?.agentsFile ?? defaultConfig?.subagents?.agentsFile)
      : (agentConfig?.agentsFile ?? defaultConfig?.agentsFile);
  const mergedModelMap =
    runRole === "subagent"
      ? {
          ...defaultConfig?.subagents?.agentsFilesByModel,
          ...agentConfig?.subagents?.agentsFilesByModel,
        }
      : {
          ...defaultConfig?.agentsFilesByModel,
          ...agentConfig?.agentsFilesByModel,
        };
  const modelRefKey =
    params.modelProviderId && params.modelId
      ? modelKey(params.modelProviderId, params.modelId)
      : undefined;
  const modelConfiguredPath = modelRefKey ? mergedModelMap[modelRefKey] : undefined;
  const defaultAgentsPath = path.join(resolvedWorkspaceDir, DEFAULT_AGENTS_FILENAME);

  const loadSelectedFile = async (selectedPath: string) =>
    await loadWorkspaceBootstrapFileFromPath({
      workspaceDir: resolvedWorkspaceDir,
      filePath: selectedPath,
      name: DEFAULT_AGENTS_FILENAME,
    });

  const resolvedBasePath =
    resolveConfiguredAgentsPath({
      workspaceDir: resolvedWorkspaceDir,
      configuredPath: baseConfiguredPath,
      label:
        runRole === "subagent"
          ? "agents.defaults.subagents.agentsFile"
          : "agents.defaults.agentsFile",
      warn: params.warn,
    }) ?? defaultAgentsPath;

  const tryLoadPath = async (
    selectedPath: string,
    warningMessage?: string,
  ): Promise<WorkspaceBootstrapFile | null> => {
    const loaded = await loadSelectedFile(selectedPath);
    if (!loaded.missing) {
      return loaded;
    }
    if (warningMessage) {
      params.warn?.(warningMessage);
    }
    return null;
  };

  let resolvedFile: WorkspaceBootstrapFile | null = null;
  if (modelConfiguredPath && modelRefKey) {
    const resolvedModelPath = resolveConfiguredAgentsPath({
      workspaceDir: resolvedWorkspaceDir,
      configuredPath: modelConfiguredPath,
      label:
        runRole === "subagent"
          ? `agents.defaults.subagents.agentsFilesByModel.${modelRefKey}`
          : `agents.defaults.agentsFilesByModel.${modelRefKey}`,
      warn: params.warn,
    });
    if (resolvedModelPath) {
      resolvedFile = await tryLoadPath(
        resolvedModelPath,
        `configured AGENTS file for model ${modelRefKey} was not found at ${resolvedModelPath}; falling back`,
      );
    }
  }

  if (!resolvedFile) {
    resolvedFile =
      (await tryLoadPath(
        resolvedBasePath,
        resolvedBasePath !== defaultAgentsPath
          ? `configured AGENTS file was not found at ${resolvedBasePath}; falling back to ${DEFAULT_AGENTS_FILENAME}`
          : undefined,
      )) ?? (await loadSelectedFile(defaultAgentsPath));
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
  const selectedAgentsFile = await resolveEffectiveAgentsBootstrapFileForRun(params);
  const bootstrapFilesWithAgentsOverride = bootstrapFiles.map((file) =>
    file.name === DEFAULT_AGENTS_FILENAME ? selectedAgentsFile.bootstrapFile : file,
  );

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
