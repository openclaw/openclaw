import type { ImageContent } from "@mariozechner/pi-ai";
import { resolveHeartbeatPrompt } from "../auto-reply/heartbeat.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/config.js";
import { shouldLogVerbose } from "../globals.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { resolveSessionAgentIds } from "./agent-scope.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "./bootstrap-files.js";
import { resolveCliBackendConfig } from "./cli-backends.js";
import { isRecord, parseMcpServers, type McpServerConfig } from "./mcp-common.js";
import {
  appendImagePathsToPrompt,
  buildCliSupervisorScopeKey,
  buildCliArgs,
  buildSystemPrompt,
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
import { classifyFailoverReason, isFailoverErrorMessage } from "./pi-embedded-helpers.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner.js";
import { redactRunIdentifier, resolveRunWorkspaceDir } from "./workspace-run.js";

const log = createSubsystemLogger("agent/claude-cli");


function readMcpConfigArg(args: string[]): { path: string; index: number; inline: boolean } | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--mcp-config") {
      const pathValue = args[i + 1];
      if (typeof pathValue === "string" && pathValue.trim()) {
        return {
          path: pathValue,
          index: i,
          inline: false,
        };
      }
      continue;
    }
    if (arg.startsWith("--mcp-config=")) {
      const pathValue = arg.slice("--mcp-config=".length).trim();
      if (!pathValue) {
        continue;
      }
      return {
        path: pathValue,
        index: i,
        inline: true,
      };
    }
  }
  return null;
}

async function readExistingMcpServers(
  configPath: string,
): Promise<Record<string, McpServerConfig>> {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
      return {};
    }
    const out: Record<string, McpServerConfig> = {};
    for (const [name, value] of Object.entries(parsed.mcpServers)) {
      if (!isRecord(value) || !name.trim()) {
        continue;
      }
      const type = typeof value.type === "string" ? value.type.trim().toLowerCase() : "";
      if (type === "http" || type === "sse") {
        const url = typeof value.url === "string" ? value.url.trim() : "";
        if (!url) {
          continue;
        }
        const headers = isRecord(value.headers)
          ? Object.fromEntries(
              Object.entries(value.headers).filter(
                (entry): entry is [string, string] =>
                  typeof entry[0] === "string" && typeof entry[1] === "string",
              ),
            )
          : undefined;
        out[name] = {
          type,
          url,
          ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
        };
        continue;
      }

      const command = typeof value.command === "string" ? value.command.trim() : "";
      if (!command) {
        continue;
      }
      const args = Array.isArray(value.args)
        ? value.args.filter((entry): entry is string => typeof entry === "string")
        : undefined;
      const env = isRecord(value.env)
        ? Object.fromEntries(
            Object.entries(value.env).filter(
              (entry): entry is [string, string] =>
                typeof entry[0] === "string" && typeof entry[1] === "string",
            ),
          )
        : undefined;
      out[name] = {
        type: "stdio",
        command,
        ...(args && args.length > 0 ? { args } : {}),
        ...(env && Object.keys(env).length > 0 ? { env } : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

function withMcpConfigArgs(args: string[], configPath: string): string[] {
  const next = [...args];
  const existing = readMcpConfigArg(next);
  if (existing) {
    if (existing.inline) {
      next[existing.index] = `--mcp-config=${configPath}`;
    } else if (existing.index + 1 < next.length) {
      next[existing.index + 1] = configPath;
    }
  } else {
    next.push("--mcp-config", configPath);
  }

  if (!next.includes("--strict-mcp-config")) {
    next.push("--strict-mcp-config");
  }
  return next;
}

async function prepareCliMcpConfig(params: {
  backendId: string;
  args: string[];
  mcpServers?: unknown[];
}): Promise<{ args: string[]; cleanup?: () => Promise<void> }> {
  if (params.backendId !== "claude-cli") {
    return { args: params.args };
  }

  const incoming = parseMcpServers(params.mcpServers);
  if (Object.keys(incoming).length === 0) {
    return { args: params.args };
  }

  const existingConfig = readMcpConfigArg(params.args);
  let mergedServers = incoming;
  if (existingConfig) {
    const existingServers = await readExistingMcpServers(existingConfig.path);
    if (Object.keys(existingServers).length > 0) {
      mergedServers = {
        ...existingServers,
        ...incoming,
      };
    }
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-mcp-"));
  const configPath = path.join(tempDir, "mcp-config.json");
  await fs.writeFile(configPath, `${JSON.stringify({ mcpServers: mergedServers }, null, 2)}\n`, {
    mode: 0o600,
  });

  log.info(`cli mcp config: servers=${Object.keys(mergedServers).length} backend=${params.backendId}`);

  return {
    args: withMcpConfigArgs(params.args, configPath),
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
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
  streamParams?: import("../commands/agent/types.js").AgentStreamParams;
  ownerNumbers?: string[];
  cliSessionId?: string;
  images?: ImageContent[];
  mcpServers?: unknown[];
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

  const extraSystemPrompt = [
    params.extraSystemPrompt?.trim(),
    "Tools are disabled in this session. Do not call tools.",
  ]
    .filter(Boolean)
    .join("\n");

  const sessionLabel = params.sessionKey ?? params.sessionId;
  const { contextFiles } = await resolveBootstrapContextForRun({
    workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    warn: makeBootstrapWarn({ sessionLabel, warn: (message) => log.warn(message) }),
  });
  const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
  });
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
  const systemPrompt = buildSystemPrompt({
    workspaceDir,
    config: params.config,
    defaultThinkLevel: params.thinkLevel,
    extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    heartbeatPrompt,
    docsPath: docsPath ?? undefined,
    tools: [],
    contextFiles,
    modelDisplay,
    agentId: sessionAgentId,
  });

  const { sessionId: cliSessionIdToSend, isNew } = resolveSessionIdToSend({
    backend,
    cliSessionId: params.cliSessionId,
  });
  const useResume = Boolean(
    params.cliSessionId &&
      cliSessionIdToSend &&
      backend.resumeArgs &&
      backend.resumeArgs.length > 0,
  );
  const sessionIdSent = cliSessionIdToSend
    ? useResume || Boolean(backend.sessionArg) || Boolean(backend.sessionArgs?.length)
      ? cliSessionIdToSend
      : undefined
    : undefined;
  const systemPromptArg = resolveSystemPromptUsage({
    backend,
    isNewSession: isNew,
    systemPrompt,
  });

  let imagePaths: string[] | undefined;
  let cleanupImages: (() => Promise<void>) | undefined;
  let cleanupMcpConfig: (() => Promise<void>) | undefined;
  let prompt = params.prompt;
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
    ? baseArgs.map((entry) => entry.replaceAll("{sessionId}", cliSessionIdToSend ?? ""))
    : baseArgs;
  let args = buildCliArgs({
    backend,
    baseArgs: resolvedArgs,
    modelId: normalizedModel,
    sessionId: cliSessionIdToSend,
    systemPrompt: systemPromptArg,
    imagePaths,
    promptArg: argsPrompt,
    useResume,
  });

  const mcpConfig = await prepareCliMcpConfig({
    backendId: backendResolved.id,
    args,
    mcpServers: params.mcpServers,
  });
  args = mcpConfig.args;
  cleanupMcpConfig = mcpConfig.cleanup;

  const serialize = backend.serialize ?? true;
  const queueKey = serialize ? backendResolved.id : `${backendResolved.id}:${params.runId}`;

  try {
    const output = await enqueueCliRun(queueKey, async () => {
      log.info(
        `cli exec: provider=${params.provider} model=${normalizedModel} promptChars=${params.prompt.length}`,
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
        cliSessionId: useResume ? cliSessionIdToSend : undefined,
      });

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
      });
      const result = await managedRun.wait();

      const stdout = result.stdout.trim();
      const stderr = result.stderr.trim();
      if (logOutputText) {
        if (stdout) {
          log.info(`cli stdout:\n${stdout}`);
        }
        if (stderr) {
          log.info(`cli stderr:\n${stderr}`);
        }
      }
      if (shouldLogVerbose()) {
        if (stdout) {
          log.debug(`cli stdout:\n${stdout}`);
        }
        if (stderr) {
          log.debug(`cli stderr:\n${stderr}`);
        }
      }

      if (result.exitCode !== 0 || result.reason !== "exit") {
        if (result.reason === "no-output-timeout" || result.noOutputTimedOut) {
          const timeoutReason = `CLI produced no output for ${Math.round(noOutputTimeoutMs / 1000)}s and was terminated.`;
          log.warn(
            `cli watchdog timeout: provider=${params.provider} model=${modelId} session=${cliSessionIdToSend ?? params.sessionId} noOutputTimeoutMs=${noOutputTimeoutMs} pid=${managedRun.pid ?? "unknown"}`,
          );
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

      const outputMode = useResume ? (backend.resumeOutput ?? backend.output) : backend.output;

      if (outputMode === "text") {
        return { text: stdout, sessionId: undefined };
      }
      if (outputMode === "jsonl") {
        const parsed = parseCliJsonl(stdout, backend);
        return parsed ?? { text: stdout };
      }

      const parsed = parseCliJson(stdout, backend);
      return parsed ?? { text: stdout };
    });

    const text = output.text?.trim();
    const payloads = text ? [{ text }] : undefined;

    return {
      payloads,
      meta: {
        durationMs: Date.now() - started,
        agentMeta: {
          sessionId: output.sessionId ?? sessionIdSent ?? params.sessionId ?? "",
          provider: params.provider,
          model: modelId,
          usage: output.usage,
        },
      },
    };
  } catch (err) {
    if (err instanceof FailoverError) {
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
  } finally {
    try {
      if (cleanupMcpConfig) {
        await cleanupMcpConfig();
      }
    } finally {
      if (cleanupImages) {
        await cleanupImages();
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
  ownerNumbers?: string[];
  claudeSessionId?: string;
  images?: ImageContent[];
  mcpServers?: unknown[];
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
    ownerNumbers: params.ownerNumbers,
    cliSessionId: params.claudeSessionId,
    images: params.images,
    mcpServers: params.mcpServers,
  });
}
