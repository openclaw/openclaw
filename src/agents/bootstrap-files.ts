import type { OpenClawConfig } from "../config/config.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { getOrLoadBootstrapFiles } from "./bootstrap-cache.js";
import { applyBootstrapHookOverrides } from "./bootstrap-hooks.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import {
  buildBootstrapContextFiles,
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "./pi-embedded-helpers.js";
import {
  filterBootstrapFilesForSession,
  loadWorkspaceBootstrapFiles,
  loadWorkspaceBootstrapFilesWithChannel,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

/**
 * Extract channel and accountId from sessionKey.
 * Session key format: {channel}:{accountId}:{...}
 */
function extractChannelInfoFromSessionKey(sessionKey?: string): {
  channel?: string;
  accountId?: string;
} {
  if (!sessionKey?.trim()) {
    return {};
  }
  const parsedAgentKey = parseAgentSessionKey(sessionKey);
  const parts = (parsedAgentKey?.rest ?? sessionKey).split(":").filter(Boolean);
  if (parts.length < 1) {
    return {};
  }
  const channel = parts[0]?.trim().toLowerCase();
  const accountIdCandidate = parts[1]?.trim().toLowerCase();
  // Validate channel is a known channel
  const validChannels = [
    "telegram",
    "discord",
    "slack",
    "whatsapp",
    "signal",
    "imessage",
    "matrix",
    "googlechat",
    "line",
    "msteams",
    "irc",
  ];
  if (!channel || !validChannels.includes(channel)) {
    return {};
  }
  const routeTokens = new Set(["main", "direct", "dm", "group", "channel", "thread", "topic"]);
  const accountId =
    accountIdCandidate && !routeTokens.has(accountIdCandidate) ? accountIdCandidate : undefined;
  return { channel, accountId };
}

/**
 * Resolve soulFile from config for a given channel/account.
 */
function resolveSoulFileFromConfig(params: {
  config?: OpenClawConfig;
  channel?: string;
  accountId?: string;
}): string | undefined {
  const { config, channel, accountId } = params;
  if (!config || !channel) {
    return undefined;
  }
  const channelConfig = config.channels?.[channel as keyof typeof config.channels] as
    | { soulFile?: string; accounts?: Record<string, { soulFile?: string }> }
    | undefined;
  if (!channelConfig) {
    return undefined;
  }
  const accountSoulFile = accountId
    ? (channelConfig.accounts as Record<string, { soulFile?: string }> | undefined)?.[accountId]
        ?.soulFile
    : undefined;
  if (accountSoulFile) {
    return accountSoulFile;
  }
  return channelConfig.soulFile;
}

export type BootstrapContextMode = "full" | "lightweight";
export type BootstrapContextRunKind = "default" | "heartbeat" | "cron";

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
    const pathValue = typeof file.path === "string" ? file.path.trim() : "";
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

export async function resolveBootstrapFilesForRun(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  channel?: string;
  accountId?: string;
  warn?: (message: string) => void;
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
}): Promise<WorkspaceBootstrapFile[]> {
  const sessionKey = params.sessionKey ?? params.sessionId;

  // Prefer explicit routing context from the inbound channel path.
  // Session keys may collapse to agent:main:main for DM/main-session flows,
  // which loses provider account identity.
  const sessionDerived = extractChannelInfoFromSessionKey(sessionKey);
  const channel = params.channel?.trim() || sessionDerived.channel;
  const accountId = params.accountId?.trim() || sessionDerived.accountId;
  const soulFile = resolveSoulFileFromConfig({
    config: params.config,
    channel,
    accountId,
  });

  // Load bootstrap files with channel-specific SOUL support
  const rawFiles = params.sessionKey
    ? await getOrLoadBootstrapFiles({
        workspaceDir: params.workspaceDir,
        sessionKey: params.sessionKey,
        channel,
        accountId,
        soulFile,
      })
    : channel || soulFile
      ? await loadWorkspaceBootstrapFilesWithChannel({
          dir: params.workspaceDir,
          channel,
          accountId,
          soulFile,
        })
      : await loadWorkspaceBootstrapFiles(params.workspaceDir);

  const bootstrapFiles = applyContextModeFilter({
    files: filterBootstrapFilesForSession(rawFiles, sessionKey),
    contextMode: params.contextMode,
    runKind: params.runKind,
  });

  const updated = await applyBootstrapHookOverrides({
    files: bootstrapFiles,
    workspaceDir: params.workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
  });
  return sanitizeBootstrapFiles(updated, params.warn);
}

export async function resolveBootstrapContextForRun(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  channel?: string;
  accountId?: string;
  warn?: (message: string) => void;
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
}): Promise<{
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
}> {
  const bootstrapFiles = await resolveBootstrapFilesForRun(params);
  const contextFiles = buildBootstrapContextFiles(bootstrapFiles, {
    maxChars: resolveBootstrapMaxChars(params.config),
    totalMaxChars: resolveBootstrapTotalMaxChars(params.config),
    warn: params.warn,
  });
  return { bootstrapFiles, contextFiles };
}
