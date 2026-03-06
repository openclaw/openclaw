import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ImageContent } from "@mariozechner/pi-ai";
import { resolveHeartbeatPrompt } from "../auto-reply/heartbeat.js";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/config.js";
import { appendCliTurnToSessionTranscript } from "../config/sessions.js";
import type { CliBackendConfig } from "../config/types.js";
import { MCP_PORT_OFFSET, ensureMcpConfigFile } from "../gateway/mcp-http.js";
import { shouldLogVerbose } from "../globals.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { PluginHookAgentContext } from "../plugins/types.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { scopedHeartbeatWakeOptions } from "../routing/session-key.js";
import { sliceUtf16Safe, resolveUserPath } from "../utils.js";
import { resolveSessionAgentIds } from "./agent-scope.js";
import {
  analyzeBootstrapBudget,
  buildBootstrapInjectionStats,
  buildBootstrapPromptWarning,
  buildBootstrapTruncationReportMeta,
} from "./bootstrap-budget.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "./bootstrap-files.js";
import { resolveCliBackendConfig } from "./cli-backends.js";
import {
  appendImagePathsToPrompt,
  buildCliSupervisorScopeKey,
  buildCliArgs,
  buildSystemPrompt,
  createStreamJsonProcessor,
  enqueueCliRun,
  normalizeCliModel,
  parseCliJson,
  parseCliJsonl,
  resolveCliNoOutputTimeoutMs,
  resolvePromptInput,
  resolveSessionIdToSend,
  resolveSystemPromptUsage,
  writeCliImages,
} from "./cli-runner/helpers.js";
import { resolveOpenClawDocsPath } from "./docs-path.js";
import { FailoverError, resolveFailoverStatus } from "./failover-error.js";
import {
  classifyFailoverReason,
  isFailoverErrorMessage,
  resolveBootstrapMaxChars,
  resolveBootstrapPromptTruncationWarningMode,
  resolveBootstrapTotalMaxChars,
} from "./pi-embedded-helpers.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
  loadWorkspaceSkillEntries,
  resolveSkillsPromptForRun,
  type SkillSnapshot,
} from "./skills.js";
import { buildSystemPromptReport } from "./system-prompt-report.js";
import { redactRunIdentifier, resolveRunWorkspaceDir } from "./workspace-run.js";

const log = createSubsystemLogger("agent/claude-cli");

type McpServers = Record<string, unknown>;
const MERGED_MCP_CONFIG_BASENAME_RE = /^mcp\.cli-merged\.[a-f0-9]{16}\.json$/;
const MERGED_MCP_CONFIG_MAX_FILES = 20;
const MERGED_MCP_CONFIG_MIN_AGE_MS = 60 * 60 * 1000;
const CLI_OUTPUT_LOG_HEAD_CHARS = 240;
const CLI_OUTPUT_LOG_TAIL_CHARS = 160;
const CLI_OUTPUT_LOG_PREVIEW_MAX_CHARS = CLI_OUTPUT_LOG_HEAD_CHARS + CLI_OUTPUT_LOG_TAIL_CHARS;

function formatCliOutputForLog(channel: "stdout" | "stderr", text: string): string {
  if (!text) {
    return `cli ${channel}: <empty>`;
  }
  const totalChars = text.length;
  if (totalChars <= CLI_OUTPUT_LOG_PREVIEW_MAX_CHARS) {
    return `cli ${channel} (${totalChars} chars):\n${text}`;
  }
  const head = sliceUtf16Safe(text, 0, CLI_OUTPUT_LOG_HEAD_CHARS);
  const tailStart = Math.max(0, totalChars - CLI_OUTPUT_LOG_TAIL_CHARS);
  const tail = sliceUtf16Safe(text, tailStart);
  const truncatedChars = Math.max(0, totalChars - head.length - tail.length);
  return [
    `cli ${channel} (${totalChars} chars):`,
    head,
    `[truncated ${truncatedChars} chars]`,
    tail,
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resolveConfiguredPath(rawPath: string | undefined): string | undefined {
  const trimmed = rawPath?.trim();
  if (!trimmed) {
    return undefined;
  }
  return resolveUserPath(trimmed);
}

async function readMcpServers(filePath: string): Promise<McpServers | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    const serversRaw = parsed.mcpServers;
    if (!isRecord(serversRaw)) {
      return {};
    }
    return { ...serversRaw };
  } catch {
    return null;
  }
}

async function writeMcpConfigIfChanged(filePath: string, content: string): Promise<void> {
  try {
    const existing = await fs.readFile(filePath, "utf-8");
    if (existing === content) {
      return;
    }
  } catch {
    // file may not exist yet
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, { mode: 0o600 });
}

async function cleanupMergedMcpConfigs(params: {
  dir: string;
  keepFilePath: string;
}): Promise<void> {
  const keepName = path.basename(params.keepFilePath);
  const now = Date.now();
  const entries = await fs.readdir(params.dir, { withFileTypes: true }).catch(() => []);
  const candidates: Array<{ name: string; filePath: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !MERGED_MCP_CONFIG_BASENAME_RE.test(entry.name)) {
      continue;
    }
    const filePath = path.join(params.dir, entry.name);
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) {
      continue;
    }
    candidates.push({
      name: entry.name,
      filePath,
      mtimeMs: stat.mtimeMs,
    });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const keepNames = new Set<string>([keepName]);
  for (const candidate of candidates) {
    if (keepNames.size >= MERGED_MCP_CONFIG_MAX_FILES) {
      break;
    }
    keepNames.add(candidate.name);
  }

  for (const candidate of candidates) {
    if (keepNames.has(candidate.name)) {
      continue;
    }
    if (now - candidate.mtimeMs < MERGED_MCP_CONFIG_MIN_AGE_MS) {
      continue;
    }
    await fs.unlink(candidate.filePath).catch(() => undefined);
  }
}

async function resolveClaudeMcpConfigForRun(params: {
  backend: CliBackendConfig;
  config?: OpenClawConfig;
}): Promise<{ mcpConfigPath?: string; useStrictMcp: boolean }> {
  const mcpCfg = params.backend.mcp;
  if (mcpCfg?.enabled === false) {
    return { mcpConfigPath: undefined, useStrictMcp: false };
  }

  const useStrictMcp = mcpCfg?.strict !== false;
  const gatewayPort = params.config?.gateway?.port ?? 18789;
  const mcpPort = gatewayPort + MCP_PORT_OFFSET;
  const openclawDir = path.join(os.homedir(), ".openclaw");
  const defaultMcpConfigPath = ensureMcpConfigFile(openclawDir, mcpPort);

  const configuredMcpPath = resolveConfiguredPath(mcpCfg?.configPath);
  const mergeMcpPath = resolveConfiguredPath(mcpCfg?.mergeConfigPath);
  const inlineServers = isRecord(mcpCfg?.servers) ? { ...mcpCfg.servers } : {};
  const hasInlineServers = Object.keys(inlineServers).length > 0;
  const needsMerge = Boolean(
    mergeMcpPath ||
    hasInlineServers ||
    (configuredMcpPath && configuredMcpPath !== defaultMcpConfigPath),
  );
  if (!needsMerge) {
    return {
      mcpConfigPath: configuredMcpPath ?? defaultMcpConfigPath,
      useStrictMcp,
    };
  }

  const openclawServers = await readMcpServers(defaultMcpConfigPath);
  if (openclawServers === null) {
    log.warn(`MCP default config read failed, skipping merge: ${defaultMcpConfigPath}`);
    return {
      mcpConfigPath: defaultMcpConfigPath,
      useStrictMcp,
    };
  }
  const configuredServers = configuredMcpPath
    ? await readMcpServers(configuredMcpPath)
    : openclawServers;
  if (configuredMcpPath && configuredServers === null) {
    log.warn(`MCP primary config read failed: ${configuredMcpPath}`);
  }
  const mergeServers = mergeMcpPath ? await readMcpServers(mergeMcpPath) : {};
  if (mergeMcpPath && mergeServers === null) {
    log.warn(`MCP merge config read failed: ${mergeMcpPath}`);
  }

  const mergedServers: McpServers = {
    ...(configuredServers ?? openclawServers),
    ...mergeServers,
    ...inlineServers,
  };
  const openclawServer = openclawServers.openclaw;
  if (isRecord(openclawServer)) {
    // Keep OpenClaw MCP server authoritative so tool routing cannot be shadowed.
    mergedServers.openclaw = openclawServer;
  }

  const mergedContent = `${JSON.stringify({ mcpServers: mergedServers }, null, 2)}\n`;
  const mergedHash = crypto.createHash("sha256").update(mergedContent).digest("hex").slice(0, 16);
  const mergedPath = path.join(
    path.dirname(defaultMcpConfigPath),
    `mcp.cli-merged.${mergedHash}.json`,
  );
  await writeMcpConfigIfChanged(mergedPath, mergedContent);
  await cleanupMergedMcpConfigs({
    dir: path.dirname(defaultMcpConfigPath),
    keepFilePath: mergedPath,
  }).catch((err) => {
    log.debug(`MCP merged config cleanup skipped: ${String(err)}`);
  });
  return { mcpConfigPath: mergedPath, useStrictMcp };
}

function createAbortError(signal?: AbortSignal): Error {
  const reason = signal && "reason" in signal ? (signal as { reason?: unknown }).reason : undefined;
  const err = reason ? new Error("aborted", { cause: reason }) : new Error("aborted");
  err.name = "AbortError";
  return err;
}

async function readCliHookMessages(sessionFile: string): Promise<unknown[]> {
  const trimmed = sessionFile.trim();
  if (!trimmed) {
    return [];
  }
  try {
    const raw = await fs.readFile(path.resolve(trimmed), "utf-8");
    const lines = raw.split(/\r?\n/g);
    const messages: unknown[] = [];
    for (const line of lines) {
      const value = line.trim();
      if (!value) {
        continue;
      }
      try {
        const parsed = JSON.parse(value) as unknown;
        if (isRecord(parsed) && parsed.type === "message" && "message" in parsed) {
          messages.push(parsed.message);
        }
      } catch {
        // ignore malformed lines
      }
    }
    return messages;
  } catch {
    return [];
  }
}

async function resolveCliPromptBuildHookResult(params: {
  hookRunner: ReturnType<typeof getGlobalHookRunner>;
  prompt: string;
  messages: unknown[];
  hookCtx: PluginHookAgentContext;
}): Promise<{ systemPrompt?: string; prependContext?: string } | undefined> {
  const hookRunner = params.hookRunner;
  if (!hookRunner) {
    return undefined;
  }
  const promptBuildResult = hookRunner.hasHooks("before_prompt_build")
    ? await hookRunner
        .runBeforePromptBuild(
          {
            prompt: params.prompt,
            messages: params.messages,
          },
          params.hookCtx,
        )
        .catch((hookErr: unknown) => {
          log.warn(`before_prompt_build hook failed: ${String(hookErr)}`);
          return undefined;
        })
    : undefined;
  const legacyResult = hookRunner.hasHooks("before_agent_start")
    ? await hookRunner
        .runBeforeAgentStart(
          {
            prompt: params.prompt,
            messages: params.messages,
          },
          params.hookCtx,
        )
        .catch((hookErr: unknown) => {
          log.warn(`before_agent_start hook (CLI path) failed: ${String(hookErr)}`);
          return undefined;
        })
    : undefined;
  return {
    systemPrompt: promptBuildResult?.systemPrompt ?? legacyResult?.systemPrompt,
    prependContext: [promptBuildResult?.prependContext, legacyResult?.prependContext]
      .filter((value): value is string => Boolean(value))
      .join("\n\n"),
  };
}

function emitCliLlmOutputHook(params: {
  hookRunner: ReturnType<typeof getGlobalHookRunner>;
  hookCtx: PluginHookAgentContext;
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  output: {
    text: string;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
    };
  };
}) {
  const hookRunner = params.hookRunner;
  if (!hookRunner?.hasHooks("llm_output")) {
    return;
  }
  const text = params.output.text.trim();
  hookRunner
    .runLlmOutput(
      {
        runId: params.runId,
        sessionId: params.sessionId,
        provider: params.provider,
        model: params.model,
        assistantTexts: text ? [text] : [],
        lastAssistant: text ? { role: "assistant", content: text } : undefined,
        usage: params.output.usage,
      },
      params.hookCtx,
    )
    .catch((hookErr) => {
      log.warn(`llm_output hook failed (CLI path): ${String(hookErr)}`);
    });
}

export async function runCliAgent(params: {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  sessionFile: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  prompt: string;
  provider: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  timeoutMs: number;
  runId: string;
  extraSystemPrompt?: string;
  skillsSnapshot?: SkillSnapshot;
  streamParams?: import("../commands/agent/types.js").AgentStreamParams;
  ownerNumbers?: string[];
  cliSessionId?: string;
  bootstrapPromptWarningSignaturesSeen?: string[];
  /** Backward-compat fallback when only the previous signature is available. */
  bootstrapPromptWarningSignature?: string;
  images?: ImageContent[];
  onAssistantTurn?: (text: string) => void;
  onSystemInit?: (payload: { subtype: string; sessionId?: string }) => void;
  onToolUse?: (toolName: string) => void;
  onThinkingTurn?: (payload: { text: string; delta?: string }) => void;
  onToolUseEvent?: (payload: { name: string; toolUseId?: string; input?: unknown }) => void;
  onToolResult?: (payload: { toolUseId?: string; text?: string; isError?: boolean }) => void;
  abortSignal?: AbortSignal;
  trigger?: PluginHookAgentContext["trigger"];
  messageChannel?: string;
  messageAccountId?: string;
  messageTo?: string;
  messageThreadId?: string | number;
}): Promise<EmbeddedPiRunResult> {
  const started = Date.now();
  const workspaceResolution = resolveRunWorkspaceDir({
    workspaceDir: params.workspaceDir,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
  const resolvedWorkspace = workspaceResolution.workspaceDir;
  const redactedSessionId = redactRunIdentifier(params.sessionId);
  const redactedSessionKey = redactRunIdentifier(params.sessionKey);
  const redactedWorkspace = redactRunIdentifier(resolvedWorkspace);
  if (workspaceResolution.usedFallback) {
    log.warn(
      `[workspace-fallback] caller=runCliAgent reason=${workspaceResolution.fallbackReason} run=${params.runId} session=${redactedSessionId} sessionKey=${redactedSessionKey} agent=${workspaceResolution.agentId} workspace=${redactedWorkspace}`,
    );
  }
  const workspaceDir = resolvedWorkspace;

  const backendResolved = resolveCliBackendConfig(params.provider, params.config);
  if (!backendResolved) {
    throw new Error(`Unknown CLI backend: ${params.provider}`);
  }
  const backend = backendResolved.config;
  const modelId = (params.model ?? "default").trim() || "default";
  const normalizedModel = normalizeCliModel(modelId, backend);
  const modelDisplay = `${params.provider}/${modelId}`;

  const isClaude = backendResolved.id === "claude-cli";

  // MCP tool access only for Claude CLI; other backends get a "tools disabled" hint.
  let mcpConfigPath: string | undefined;
  let useStrictMcp = true;
  if (isClaude) {
    try {
      const mcpResolved = await resolveClaudeMcpConfigForRun({
        backend,
        config: params.config,
      });
      mcpConfigPath = mcpResolved.mcpConfigPath;
      useStrictMcp = mcpResolved.useStrictMcp;
    } catch (err) {
      log.warn(`mcp config setup failed: ${String(err)}`);
    }
  }

  const extraSystemPrompt = isClaude
    ? params.extraSystemPrompt?.trim() || undefined
    : [params.extraSystemPrompt?.trim(), "Tools are disabled in this session. Do not call tools."]
        .filter(Boolean)
        .join("\n");

  const sessionLabel = params.sessionKey ?? params.sessionId;
  const { bootstrapFiles, contextFiles } = await resolveBootstrapContextForRun({
    workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    warn: makeBootstrapWarn({ sessionLabel, warn: (message) => log.warn(message) }),
  });
  const bootstrapMaxChars = resolveBootstrapMaxChars(params.config);
  const bootstrapTotalMaxChars = resolveBootstrapTotalMaxChars(params.config);
  const bootstrapAnalysis = analyzeBootstrapBudget({
    files: buildBootstrapInjectionStats({
      bootstrapFiles,
      injectedFiles: contextFiles,
    }),
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
  });
  const bootstrapPromptWarningMode = resolveBootstrapPromptTruncationWarningMode(params.config);
  const bootstrapPromptWarning = buildBootstrapPromptWarning({
    analysis: bootstrapAnalysis,
    mode: bootstrapPromptWarningMode,
    seenSignatures: params.bootstrapPromptWarningSignaturesSeen,
    previousSignature: params.bootstrapPromptWarningSignature,
  });
  const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const hookCtx: PluginHookAgentContext = {
    agentId: sessionAgentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    workspaceDir,
    messageProvider: params.messageChannel,
    trigger: params.trigger,
    channelId: params.messageChannel,
  };
  const hookRunner = getGlobalHookRunner();
  const hasPromptBuildHooks = Boolean(
    hookRunner?.hasHooks("before_prompt_build") || hookRunner?.hasHooks("before_agent_start"),
  );
  let promptForRun = params.prompt;
  const hookMessages = hasPromptBuildHooks ? await readCliHookMessages(params.sessionFile) : [];
  const promptBuildHookResult = hasPromptBuildHooks
    ? await resolveCliPromptBuildHookResult({
        hookRunner,
        prompt: params.prompt,
        messages: hookMessages,
        hookCtx,
      })
    : undefined;
  const prependContext = promptBuildHookResult?.prependContext;
  if (prependContext?.trim()) {
    promptForRun = `${prependContext}\n\n${params.prompt}`;
    log.debug(`hooks: prepended context to CLI prompt (${prependContext.length} chars)`);
  }
  const hookSystemPromptOverride = promptBuildHookResult?.systemPrompt?.trim() || undefined;
  if (hookSystemPromptOverride) {
    log.debug(
      `hooks: applied CLI systemPrompt override (${hookSystemPromptOverride.length} chars)`,
    );
  }
  const heartbeatPrompt =
    sessionAgentId === defaultAgentId
      ? resolveHeartbeatPrompt(params.config?.agents?.defaults?.heartbeat?.prompt)
      : undefined;
  const docsPath = await resolveOpenClawDocsPath({
    workspaceDir,
    argv1: process.argv[1],
    cwd: process.cwd(),
    moduleUrl: import.meta.url,
  });
  let skillsPrompt: string | undefined;
  let restoreSkillEnv: (() => void) | undefined;
  if (isClaude) {
    const shouldLoadSkillEntries = !params.skillsSnapshot || !params.skillsSnapshot.resolvedSkills;
    const skillEntries = shouldLoadSkillEntries
      ? loadWorkspaceSkillEntries(workspaceDir, { config: params.config })
      : undefined;
    restoreSkillEnv = params.skillsSnapshot
      ? applySkillEnvOverridesFromSnapshot({
          snapshot: params.skillsSnapshot,
          config: params.config,
        })
      : applySkillEnvOverrides({
          skills: skillEntries ?? [],
          config: params.config,
        });
    skillsPrompt = resolveSkillsPromptForRun({
      skillsSnapshot: params.skillsSnapshot,
      entries: shouldLoadSkillEntries ? skillEntries : undefined,
      config: params.config,
      workspaceDir,
    });
  }
  const builtSystemPrompt = buildSystemPrompt({
    workspaceDir,
    config: params.config,
    defaultThinkLevel: params.thinkLevel,
    extraSystemPrompt,
    skillsPrompt,
    ownerNumbers: params.ownerNumbers,
    heartbeatPrompt,
    docsPath: docsPath ?? undefined,
    tools: [],
    contextFiles,
    bootstrapTruncationWarningLines: bootstrapPromptWarning.lines,
    modelDisplay,
    agentId: sessionAgentId,
  });
  const systemPrompt = hookSystemPromptOverride ?? builtSystemPrompt;
  const systemPromptReport = buildSystemPromptReport({
    source: "run",
    generatedAt: Date.now(),
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    model: modelId,
    workspaceDir,
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
    bootstrapTruncation: buildBootstrapTruncationReportMeta({
      analysis: bootstrapAnalysis,
      warningMode: bootstrapPromptWarningMode,
      warning: bootstrapPromptWarning,
    }),
    sandbox: { mode: "off", sandboxed: false },
    systemPrompt,
    bootstrapFiles,
    injectedFiles: contextFiles,
    skillsPrompt: "",
    tools: [],
  });

  // Helper function to execute CLI with given session ID
  const executeCliWithSession = async (
    cliSessionIdToUse?: string,
  ): Promise<{
    text: string;
    sessionId?: string;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
    };
  }> => {
    if (params.abortSignal?.aborted) {
      throw createAbortError(params.abortSignal);
    }
    const { sessionId: resolvedSessionId, isNew } = resolveSessionIdToSend({
      backend,
      cliSessionId: cliSessionIdToUse,
    });
    const useResume = Boolean(
      cliSessionIdToUse && resolvedSessionId && backend.resumeArgs && backend.resumeArgs.length > 0,
    );
    const systemPromptArg = resolveSystemPromptUsage({
      backend,
      isNewSession: isNew,
      systemPrompt,
    });

    let imagePaths: string[] | undefined;
    let cleanupImages: (() => Promise<void>) | undefined;
    let prompt = promptForRun;
    if (params.images && params.images.length > 0) {
      const imagePayload = await writeCliImages(params.images);
      imagePaths = imagePayload.paths;
      cleanupImages = imagePayload.cleanup;
      if (!backend.imageArg) {
        prompt = appendImagePathsToPrompt(prompt, imagePaths);
      }
    }

    const { argsPrompt, stdin } = resolvePromptInput({
      backend,
      prompt,
    });
    const stdinPayload = stdin ?? "";
    const baseArgs = useResume ? (backend.resumeArgs ?? backend.args ?? []) : (backend.args ?? []);
    const resolvedArgs = useResume
      ? baseArgs.map((entry) => entry.replaceAll("{sessionId}", resolvedSessionId ?? ""))
      : baseArgs;
    const args = buildCliArgs({
      backend,
      baseArgs: resolvedArgs,
      modelId: normalizedModel,
      sessionId: resolvedSessionId,
      systemPrompt: systemPromptArg,
      imagePaths,
      promptArg: argsPrompt,
      useResume,
    });
    // --mcp-config is a Claude Code specific flag.
    if (mcpConfigPath && backendResolved.id === "claude-cli") {
      if (useStrictMcp && !args.includes("--strict-mcp-config")) {
        args.push("--strict-mcp-config");
      }
      args.push("--mcp-config", mcpConfigPath);
    }

    const serialize = backend.serialize ?? true;
    const queueKey = serialize ? backendResolved.id : `${backendResolved.id}:${params.runId}`;

    try {
      const output = await enqueueCliRun(queueKey, async () => {
        log.info(
          `cli exec: provider=${params.provider} model=${normalizedModel} promptChars=${promptForRun.length}`,
        );
        const logOutputText = isTruthyEnvValue(process.env.OPENCLAW_CLAUDE_CLI_LOG_OUTPUT);
        if (logOutputText) {
          const logArgs: string[] = [];
          for (let i = 0; i < args.length; i += 1) {
            const arg = args[i] ?? "";
            if (arg === backend.systemPromptArg) {
              const systemPromptValue = args[i + 1] ?? "";
              logArgs.push(arg, `<systemPrompt:${systemPromptValue.length} chars>`);
              i += 1;
              continue;
            }
            if (arg === backend.sessionArg) {
              logArgs.push(arg, args[i + 1] ?? "");
              i += 1;
              continue;
            }
            if (arg === backend.modelArg) {
              logArgs.push(arg, args[i + 1] ?? "");
              i += 1;
              continue;
            }
            if (arg === backend.imageArg) {
              logArgs.push(arg, "<image>");
              i += 1;
              continue;
            }
            logArgs.push(arg);
          }
          if (argsPrompt) {
            const promptIndex = logArgs.indexOf(argsPrompt);
            if (promptIndex >= 0) {
              logArgs[promptIndex] = `<prompt:${argsPrompt.length} chars>`;
            }
          }
          log.info(`cli argv: ${backend.command} ${logArgs.join(" ")}`);
        }

        const env = (() => {
          const next = { ...process.env, ...backend.env };
          for (const key of backend.clearEnv ?? []) {
            delete next[key];
          }
          if (mcpConfigPath) {
            next.OPENCLAW_MCP_AGENT_ID = sessionAgentId ?? "";
            next.OPENCLAW_MCP_ACCOUNT_ID = params.messageAccountId ?? "";
            next.OPENCLAW_MCP_SESSION_KEY = params.sessionKey ?? "";
            next.OPENCLAW_MCP_MESSAGE_CHANNEL = params.messageChannel ?? "";
            next.OPENCLAW_MCP_TO = params.messageTo ?? "";
            next.OPENCLAW_MCP_THREAD_ID =
              params.messageThreadId != null ? String(params.messageThreadId) : "";
          }
          return next;
        })();
        const noOutputTimeoutMs = resolveCliNoOutputTimeoutMs({
          backend,
          timeoutMs: params.timeoutMs,
          useResume,
        });
        const supervisor = getProcessSupervisor();
        const scopeKey = buildCliSupervisorScopeKey({
          backend,
          backendId: backendResolved.id,
          cliSessionId: useResume ? resolvedSessionId : undefined,
        });

        const outputMode = useResume ? (backend.resumeOutput ?? backend.output) : backend.output;

        // Stream-json mode: process NDJSON lines as they arrive via onStdout
        const streamProcessor =
          outputMode === "stream-json"
            ? createStreamJsonProcessor(backend, {
                onSystemInit: params.onSystemInit,
                onAssistantTurn: params.onAssistantTurn,
                onToolUse: params.onToolUse,
                onThinkingTurn: params.onThinkingTurn,
                onToolUseEvent: params.onToolUseEvent,
                onToolResult: params.onToolResult,
              })
            : undefined;

        const managedRun = await supervisor.spawn({
          sessionId: params.sessionId,
          backendId: backendResolved.id,
          scopeKey,
          replaceExistingScope: Boolean(useResume && scopeKey),
          mode: "child",
          argv: [backend.command, ...args],
          timeoutMs: params.timeoutMs,
          noOutputTimeoutMs,
          cwd: workspaceDir,
          env,
          input: stdinPayload,
          ...(streamProcessor ? { onStdout: streamProcessor.feed } : {}),
        });
        const onAbort = () => {
          managedRun.cancel("manual-cancel");
        };
        if (params.abortSignal) {
          if (params.abortSignal.aborted) {
            onAbort();
          } else {
            params.abortSignal.addEventListener("abort", onAbort, { once: true });
          }
        }
        let result;
        try {
          result = await managedRun.wait();
        } finally {
          params.abortSignal?.removeEventListener("abort", onAbort);
        }
        if (result.reason === "manual-cancel" && params.abortSignal?.aborted) {
          throw createAbortError(params.abortSignal);
        }

        const stdout = result.stdout.trim();
        const stderr = result.stderr.trim();
        if (logOutputText) {
          if (stdout) {
            log.info(formatCliOutputForLog("stdout", stdout));
          }
          if (stderr) {
            log.info(formatCliOutputForLog("stderr", stderr));
          }
        }
        if (shouldLogVerbose()) {
          if (stdout) {
            log.debug(formatCliOutputForLog("stdout", stdout));
          }
          if (stderr) {
            log.debug(formatCliOutputForLog("stderr", stderr));
          }
        }

        if (result.exitCode !== 0 || result.reason !== "exit") {
          if (result.reason === "no-output-timeout" || result.noOutputTimedOut) {
            const timeoutReason = `CLI produced no output for ${Math.round(noOutputTimeoutMs / 1000)}s and was terminated.`;
            log.warn(
              `cli watchdog timeout: provider=${params.provider} model=${modelId} session=${resolvedSessionId ?? params.sessionId} noOutputTimeoutMs=${noOutputTimeoutMs} pid=${managedRun.pid ?? "unknown"}`,
            );
            if (params.sessionKey) {
              const stallNotice = [
                `CLI agent (${params.provider}) produced no output for ${Math.round(noOutputTimeoutMs / 1000)}s and was terminated.`,
                "It may have been waiting for interactive input or an approval prompt.",
                "For Claude Code, prefer --permission-mode bypassPermissions --print.",
              ].join(" ");
              enqueueSystemEvent(stallNotice, { sessionKey: params.sessionKey });
              requestHeartbeatNow(
                scopedHeartbeatWakeOptions(params.sessionKey, { reason: "cli:watchdog:stall" }),
              );
            }
            throw new FailoverError(timeoutReason, {
              reason: "timeout",
              provider: params.provider,
              model: modelId,
              status: resolveFailoverStatus("timeout"),
            });
          }
          if (result.reason === "overall-timeout") {
            const timeoutReason = `CLI exceeded timeout (${Math.round(params.timeoutMs / 1000)}s) and was terminated.`;
            throw new FailoverError(timeoutReason, {
              reason: "timeout",
              provider: params.provider,
              model: modelId,
              status: resolveFailoverStatus("timeout"),
            });
          }
          const err = stderr || stdout || "CLI failed.";
          const reason = classifyFailoverReason(err) ?? "unknown";
          const status = resolveFailoverStatus(reason);
          throw new FailoverError(err, {
            reason,
            provider: params.provider,
            model: modelId,
            status,
          });
        }

        let output: {
          text: string;
          sessionId?: string;
          usage?: {
            input?: number;
            output?: number;
            cacheRead?: number;
            cacheWrite?: number;
            total?: number;
          };
        };
        if (streamProcessor) {
          output = streamProcessor.finish();
        } else if (outputMode === "text") {
          output = { text: stdout, sessionId: undefined };
        } else if (outputMode === "jsonl") {
          const parsed = parseCliJsonl(stdout, backend);
          output = parsed ?? { text: stdout };
        } else {
          const parsed = parseCliJson(stdout, backend);
          output = parsed ?? { text: stdout };
        }
        try {
          const appendResult = await appendCliTurnToSessionTranscript({
            sessionFile: params.sessionFile,
            sessionId: params.sessionId,
            userText: params.prompt,
            assistantText: output.text,
            provider: params.provider,
            model: normalizedModel,
            usage: output.usage,
          });
          if (!appendResult.ok) {
            log.debug(`cli transcript append skipped: ${appendResult.reason}`);
          }
        } catch (err) {
          log.warn(`cli transcript append failed: ${String(err)}`);
        }
        emitCliLlmOutputHook({
          hookRunner,
          hookCtx,
          runId: params.runId,
          sessionId: output.sessionId ?? resolvedSessionId ?? params.sessionId,
          provider: params.provider,
          model: normalizedModel,
          output,
        });
        return output;
      });

      return output;
    } finally {
      if (cleanupImages) {
        await cleanupImages();
      }
    }
  };

  // Try with the provided CLI session ID first
  try {
    try {
      const output = await executeCliWithSession(params.cliSessionId);
      const text = output.text?.trim();
      const payloads = text ? [{ text }] : undefined;

      return {
        payloads,
        meta: {
          durationMs: Date.now() - started,
          systemPromptReport,
          agentMeta: {
            sessionId: output.sessionId ?? params.cliSessionId ?? params.sessionId ?? "",
            provider: params.provider,
            model: modelId,
            usage: output.usage,
          },
        },
      };
    } catch (err) {
      if (err instanceof FailoverError) {
        // Check if this is a session expired error and we have a session to clear
        if (err.reason === "session_expired" && params.cliSessionId && params.sessionKey) {
          log.warn(
            `CLI session expired, clearing session ID and retrying: provider=${params.provider} session=${redactRunIdentifier(params.cliSessionId)}`,
          );

          // Clear the expired session ID from the session entry
          // This requires access to the session store, which we don't have here
          // We'll need to modify the caller to handle this case

          // For now, retry without the session ID to create a new session
          const output = await executeCliWithSession(undefined);
          const text = output.text?.trim();
          const payloads = text ? [{ text }] : undefined;

          return {
            payloads,
            meta: {
              durationMs: Date.now() - started,
              systemPromptReport,
              agentMeta: {
                sessionId: output.sessionId ?? params.sessionId ?? "",
                provider: params.provider,
                model: modelId,
                usage: output.usage,
              },
            },
          };
        }
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (isFailoverErrorMessage(message)) {
        const reason = classifyFailoverReason(message) ?? "unknown";
        const status = resolveFailoverStatus(reason);
        throw new FailoverError(message, {
          reason,
          provider: params.provider,
          model: modelId,
          status,
        });
      }
      throw err;
    }
  } finally {
    if (restoreSkillEnv) {
      try {
        restoreSkillEnv();
      } catch (error) {
        log.warn(`failed to restore skill env overrides: ${String(error)}`);
      }
    }
  }
}

export async function runClaudeCliAgent(params: {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  sessionFile: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  prompt: string;
  provider?: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  timeoutMs: number;
  runId: string;
  extraSystemPrompt?: string;
  skillsSnapshot?: SkillSnapshot;
  ownerNumbers?: string[];
  claudeSessionId?: string;
  images?: ImageContent[];
  onAssistantTurn?: (text: string) => void;
  onSystemInit?: (payload: { subtype: string; sessionId?: string }) => void;
  onToolUse?: (toolName: string) => void;
  onThinkingTurn?: (payload: { text: string; delta?: string }) => void;
  onToolUseEvent?: (payload: { name: string; toolUseId?: string; input?: unknown }) => void;
  onToolResult?: (payload: { toolUseId?: string; text?: string; isError?: boolean }) => void;
  abortSignal?: AbortSignal;
  trigger?: PluginHookAgentContext["trigger"];
  messageChannel?: string;
  messageAccountId?: string;
  messageTo?: string;
  messageThreadId?: string | number;
}): Promise<EmbeddedPiRunResult> {
  return runCliAgent({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    config: params.config,
    prompt: params.prompt,
    provider: params.provider ?? "claude-cli",
    model: params.model ?? "opus",
    thinkLevel: params.thinkLevel,
    timeoutMs: params.timeoutMs,
    runId: params.runId,
    extraSystemPrompt: params.extraSystemPrompt,
    skillsSnapshot: params.skillsSnapshot,
    ownerNumbers: params.ownerNumbers,
    cliSessionId: params.claudeSessionId,
    images: params.images,
    onAssistantTurn: params.onAssistantTurn,
    onSystemInit: params.onSystemInit,
    onToolUse: params.onToolUse,
    onThinkingTurn: params.onThinkingTurn,
    onToolUseEvent: params.onToolUseEvent,
    onToolResult: params.onToolResult,
    abortSignal: params.abortSignal,
    trigger: params.trigger,
    messageChannel: params.messageChannel,
    messageAccountId: params.messageAccountId,
    messageTo: params.messageTo,
    messageThreadId: params.messageThreadId,
  });
}
