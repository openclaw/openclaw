import type { ImageContent } from "@mariozechner/pi-ai";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { AgentStreamEvent } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner.js";
import { resolveHeartbeatPrompt } from "../auto-reply/heartbeat.js";
import { shouldLogVerbose } from "../globals.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolveUserPath } from "../utils.js";
import { resolveSessionAgentIds } from "./agent-scope.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "./bootstrap-files.js";
import { resolveCliBackendConfig } from "./cli-backends.js";
import {
  appendImagePathsToPrompt,
  buildCliArgs,
  buildSystemPrompt,
  cleanupSuspendedCliProcesses,
  enqueueCliRun,
  normalizeCliModel,
  parseCliJson,
  parseCliJsonl,
  resolvePromptInput,
  resolveSystemPromptUsage,
  writeCliImages,
} from "./cli-runner/helpers.js";
import { formatToolStatusLabel, runStreamingCli } from "./cli-runner/streaming.js";
import { resolveOpenClawDocsPath } from "./docs-path.js";
import { FailoverError, resolveFailoverStatus } from "./failover-error.js";
import { classifyFailoverReason, isFailoverErrorMessage } from "./pi-embedded-helpers.js";

export type CliToolStatusCallback = (info: {
  toolName: string;
  toolCallId: string;
  input?: Record<string, unknown>;
}) => void;

const log = createSubsystemLogger("agent/claude-cli");

const AGENT_RUNS_DIR = path.join(os.homedir(), ".openclaw", "agent-runs");
const AGENT_RUNS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Create an ephemeral run directory to isolate CLI backends from
 * workspace-specific project memory. Returns the directory path
 * and a cleanup function.
 */
async function createEphemeralRunDir(sessionId: string): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  await fs.mkdir(AGENT_RUNS_DIR, { recursive: true });
  const dirName = `${sessionId}-${Date.now()}`;
  const dir = path.join(AGENT_RUNS_DIR, dirName);
  await fs.mkdir(dir, { recursive: true });
  return {
    dir,
    cleanup: async () => {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    },
  };
}

/**
 * Remove ephemeral run directories older than AGENT_RUNS_MAX_AGE_MS.
 * Called on a best-effort basis; failures are silently ignored.
 */
async function cleanupOldRunDirs(): Promise<void> {
  try {
    const entries = await fs.readdir(AGENT_RUNS_DIR, { withFileTypes: true });
    const now = Date.now();
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const entryPath = path.join(AGENT_RUNS_DIR, entry.name);
          try {
            const stat = await fs.stat(entryPath);
            if (now - stat.mtimeMs > AGENT_RUNS_MAX_AGE_MS) {
              await fs.rm(entryPath, { recursive: true, force: true });
            }
          } catch {
            // Ignore individual cleanup failures
          }
        }),
    );
  } catch {
    // Ignore if directory doesn't exist yet
  }
}

export async function runCliAgent(params: {
  sessionId: string;
  sessionKey?: string;
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
  images?: ImageContent[];
  /** Callback for tool execution status (enables streaming mode). */
  onToolStatus?: CliToolStatusCallback;
  /** Called with non-terminal streaming events for status tracking. */
  onStreamEvent?: (event: AgentStreamEvent) => void;
  /** Reasoning display level ("off" suppresses thinking events). */
  reasoningLevel?: "off" | "on" | "stream";
}): Promise<EmbeddedPiRunResult> {
  const started = Date.now();
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  const workspaceDir = resolvedWorkspace;

  const backendResolved = resolveCliBackendConfig(params.provider, params.config);
  if (!backendResolved) {
    throw new Error(`Unknown CLI backend: ${params.provider}`);
  }
  const backend = backendResolved.config;
  const modelId = (params.model ?? "default").trim() || "default";
  const normalizedModel = normalizeCliModel(modelId, backend);
  const modelDisplay = `${params.provider}/${modelId}`;

  // Streaming mode enables native CLI tools for tool feedback display;
  // non-streaming mode disables tools (handled by the embedded runner instead).
  const useStreaming = Boolean(params.onToolStatus || params.onStreamEvent);
  const extraSystemPrompt = [
    params.extraSystemPrompt?.trim(),
    useStreaming ? undefined : "Tools are disabled in this session. Do not call tools.",
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

  // Stateless: every invocation is fresh (no session resume).
  // System prompt is always injected so the CLI behaves like the API.
  const systemPromptArg = resolveSystemPromptUsage({
    backend,
    isNewSession: true,
    systemPrompt,
  });

  let imagePaths: string[] | undefined;
  let cleanupImages: (() => Promise<void>) | undefined;
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
  const args = buildCliArgs({
    backend,
    baseArgs: backend.args ?? [],
    modelId: normalizedModel,
    systemPrompt: systemPromptArg,
    imagePaths,
    promptArg: argsPrompt,
    useResume: false,
  });

  // When streaming is enabled:
  // 1. Replace --output-format json → stream-json
  // 2. Add --verbose (required by claude CLI for stream-json with -p)
  // 3. Remove --tools "" so native CLI tools (Read, Bash, Glob) are available
  // 4. Disallow MCP wrapper tool so the model uses native tools directly
  //    — this produces clean tool feedback like "📖 Read: /path" instead of
  //    the verbose MCP wrapper prompt from claude_code.
  const streamArgs = (() => {
    if (!useStreaming) {
      return args;
    }
    const out: string[] = [];
    let skip = false;
    for (let i = 0; i < args.length; i++) {
      if (skip) {
        skip = false;
        continue;
      }
      // Strip --tools "" pair to enable native tools in streaming mode
      if (args[i] === "--tools") {
        skip = true;
        continue;
      }
      // Replace json → stream-json for streaming output
      if (args[i] === "json" && i > 0 && args[i - 1] === "--output-format") {
        out.push("stream-json");
        continue;
      }
      out.push(args[i]);
    }
    out.push("--verbose");
    // Block the MCP wrapper tool so the model must use native tools (Read,
    // Bash, Glob, etc.) whose names produce clean tool feedback in Discord.
    out.push("--disallowedTools", "mcp__claude-code-mcp__claude_code");
    return out;
  })();

  const serialize = backend.serialize ?? true;
  const queueKey = serialize ? backendResolved.id : `${backendResolved.id}:${params.runId}`;

  // Always use an ephemeral CWD to prevent the CLI backend from
  // loading project-level context (.claude/, CLAUDE.md, auto-memory)
  // based on the workspace directory. This strips all Claude Code
  // project awareness so it behaves like a plain API call. Native
  // tools (Read, Bash, Glob) work with absolute paths and don't
  // depend on CWD.
  let ephemeralRun: { dir: string; cleanup: () => Promise<void> } | undefined;
  try {
    ephemeralRun = await createEphemeralRunDir(params.sessionId);
  } catch {
    log.warn("failed to create ephemeral run directory, using workspace CWD");
  }

  // Schedule old run directory cleanup (best-effort, non-blocking)
  void cleanupOldRunDirs();

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

      // Cleanup suspended processes that have accumulated
      await cleanupSuspendedCliProcesses(backend);

      // Use streaming execution when tool status or stream event callbacks are provided
      if (useStreaming) {
        log.info("cli streaming mode enabled");
        const toolNameById = new Map<string, string>();
        const streamResult = await runStreamingCli({
          command: backend.command,
          args: streamArgs,
          cwd: ephemeralRun?.dir ?? workspaceDir,
          env,
          timeoutMs: params.timeoutMs,
          onEvent: (event) => {
            if (event.type === "tool_start") {
              toolNameById.set(event.toolCallId, event.toolName);
              if (params.onToolStatus) {
                log.debug(`cli tool start: ${event.toolName}`);
                params.onToolStatus({
                  toolName: event.toolName,
                  toolCallId: event.toolCallId,
                  input: event.input,
                });
              }
            }
            // Forward non-terminal events to stream event callback for
            // status tracking. Suppress thinking events unless reasoning
            // display is enabled (/reasoning on|stream), mirroring the
            // pi-embedded-runner's default reasoningMode:"off" behavior.
            const suppressThinking =
              event.type === "thinking" && (params.reasoningLevel ?? "off") === "off";
            if (
              params.onStreamEvent &&
              event.type !== "result" &&
              event.type !== "error" &&
              !suppressThinking
            ) {
              if (event.type === "tool_result") {
                const toolName = toolNameById.get(event.toolCallId) ?? "";
                toolNameById.delete(event.toolCallId);
                params.onStreamEvent({ ...event, toolName });
              } else {
                params.onStreamEvent(event);
              }
            }
          },
        });

        if (streamResult.exitCode !== 0 && !streamResult.text) {
          const errMsg = streamResult.stderr
            ? `CLI streaming failed: ${streamResult.stderr.slice(0, 200)}`
            : "CLI streaming failed";
          const reason = classifyFailoverReason(errMsg) ?? "unknown";
          const status = resolveFailoverStatus(reason);
          throw new FailoverError(errMsg, {
            reason,
            provider: params.provider,
            model: modelId,
            status,
          });
        }

        return {
          text: streamResult.text,
          sessionId: streamResult.sessionId,
          usage: streamResult.usage,
        };
      }

      const result = await runCommandWithTimeout([backend.command, ...args], {
        timeoutMs: params.timeoutMs,
        cwd: ephemeralRun?.dir ?? workspaceDir,
        env,
        input: stdinPayload,
      });

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

      if (result.code !== 0) {
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

      const outputMode = backend.output;

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
          sessionId: params.sessionId ?? "",
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
    if (cleanupImages) {
      await cleanupImages();
    }
    if (ephemeralRun) {
      await ephemeralRun.cleanup();
    }
  }
}

export async function runClaudeCliAgent(params: {
  sessionId: string;
  sessionKey?: string;
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
  images?: ImageContent[];
  /** Callback for tool execution status (enables streaming mode). */
  onToolStatus?: CliToolStatusCallback;
  /** Called with non-terminal streaming events for status tracking. */
  onStreamEvent?: (event: AgentStreamEvent) => void;
}): Promise<EmbeddedPiRunResult> {
  return runCliAgent({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
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
    images: params.images,
    onToolStatus: params.onToolStatus,
    onStreamEvent: params.onStreamEvent,
  });
}

export { formatToolStatusLabel } from "./cli-runner/streaming.js";
