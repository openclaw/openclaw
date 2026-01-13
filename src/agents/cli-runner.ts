import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import { resolveHeartbeatPrompt } from "../auto-reply/heartbeat.js";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { ClawdbotConfig } from "../config/config.js";
import type { CliBackendConfig } from "../config/types.js";
import { shouldLogVerbose } from "../globals.js";
import { createSubsystemLogger } from "../logging.js";
import { runCommandWithTimeout, runExec } from "../process/exec.js";
import { resolveUserPath } from "../utils.js";
import { resolveSessionAgentIds } from "./agent-scope.js";
import { resolveCliBackendConfig } from "./cli-backends.js";
import { FailoverError, resolveFailoverStatus } from "./failover-error.js";
import {
  buildBootstrapContextFiles,
  classifyFailoverReason,
  type EmbeddedContextFile,
  isFailoverErrorMessage,
  resolveBootstrapMaxChars,
} from "./pi-embedded-helpers.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";
import {
  filterBootstrapFilesForSession,
  loadWorkspaceBootstrapFiles,
} from "./workspace.js";

const log = createSubsystemLogger("agent/claude-cli");
const CLI_RUN_QUEUE = new Map<string, Promise<unknown>>();

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function cleanupResumeProcesses(
  backend: CliBackendConfig,
  sessionId: string,
): Promise<void> {
  if (process.platform === "win32") return;
  const resumeArgs = backend.resumeArgs ?? [];
  if (resumeArgs.length === 0) return;
  if (!resumeArgs.some((arg) => arg.includes("{sessionId}"))) return;
  const commandToken = path.basename(backend.command ?? "").trim();
  if (!commandToken) return;

  const resumeTokens = resumeArgs.map((arg) =>
    arg.replaceAll("{sessionId}", sessionId),
  );
  const pattern = [commandToken, ...resumeTokens]
    .filter(Boolean)
    .map((token) => escapeRegex(token))
    .join(".*");
  if (!pattern) return;

  try {
    await runExec("pkill", ["-f", pattern]);
  } catch {
    // ignore missing pkill or no matches
  }
}

function enqueueCliRun<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prior = CLI_RUN_QUEUE.get(key) ?? Promise.resolve();
  const chained = prior.catch(() => undefined).then(task);
  const tracked = chained.finally(() => {
    if (CLI_RUN_QUEUE.get(key) === tracked) {
      CLI_RUN_QUEUE.delete(key);
    }
  });
  CLI_RUN_QUEUE.set(key, tracked);
  return chained;
}

type CliUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

type CliOutput = {
  text: string;
  sessionId?: string;
  usage?: CliUsage;
};

function resolveUserTimezone(configured?: string): string {
  const trimmed = configured?.trim();
  if (trimmed) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(
        new Date(),
      );
      return trimmed;
    } catch {
      // ignore invalid timezone
    }
  }
  const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return host?.trim() || "UTC";
}

function formatUserTime(date: Date, timeZone: string): string | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const map: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== "literal") map[part.type] = part.value;
    }
    if (
      !map.weekday ||
      !map.year ||
      !map.month ||
      !map.day ||
      !map.hour ||
      !map.minute
    ) {
      return undefined;
    }
    return `${map.weekday} ${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}`;
  } catch {
    return undefined;
  }
}

function buildModelAliasLines(cfg?: ClawdbotConfig) {
  const models = cfg?.agents?.defaults?.models ?? {};
  const entries: Array<{ alias: string; model: string }> = [];
  for (const [keyRaw, entryRaw] of Object.entries(models)) {
    const model = String(keyRaw ?? "").trim();
    if (!model) continue;
    const alias = String(
      (entryRaw as { alias?: string } | undefined)?.alias ?? "",
    ).trim();
    if (!alias) continue;
    entries.push({ alias, model });
  }
  return entries
    .sort((a, b) => a.alias.localeCompare(b.alias))
    .map((entry) => `- ${entry.alias}: ${entry.model}`);
}

function buildSystemPrompt(params: {
  workspaceDir: string;
  config?: ClawdbotConfig;
  defaultThinkLevel?: ThinkLevel;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  heartbeatPrompt?: string;
  tools: AgentTool[];
  contextFiles?: EmbeddedContextFile[];
  modelDisplay: string;
}) {
  const userTimezone = resolveUserTimezone(
    params.config?.agents?.defaults?.userTimezone,
  );
  const userTime = formatUserTime(new Date(), userTimezone);
  return buildAgentSystemPrompt({
    workspaceDir: params.workspaceDir,
    defaultThinkLevel: params.defaultThinkLevel,
    extraSystemPrompt: params.extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    reasoningTagHint: false,
    heartbeatPrompt: params.heartbeatPrompt,
    runtimeInfo: {
      host: "clawdbot",
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      node: process.version,
      model: params.modelDisplay,
    },
    toolNames: params.tools.map((tool) => tool.name),
    modelAliasLines: buildModelAliasLines(params.config),
    userTimezone,
    userTime,
    contextFiles: params.contextFiles,
  });
}

function normalizeCliModel(modelId: string, backend: CliBackendConfig): string {
  const trimmed = modelId.trim();
  if (!trimmed) return trimmed;
  const direct = backend.modelAliases?.[trimmed];
  if (direct) return direct;
  const lower = trimmed.toLowerCase();
  const mapped = backend.modelAliases?.[lower];
  if (mapped) return mapped;
  return trimmed;
}

function toUsage(raw: Record<string, unknown>): CliUsage | undefined {
  const pick = (key: string) =>
    typeof raw[key] === "number" && raw[key] > 0
      ? (raw[key] as number)
      : undefined;
  const input = pick("input_tokens") ?? pick("inputTokens");
  const output = pick("output_tokens") ?? pick("outputTokens");
  const cacheRead =
    pick("cache_read_input_tokens") ??
    pick("cached_input_tokens") ??
    pick("cacheRead");
  const cacheWrite = pick("cache_write_input_tokens") ?? pick("cacheWrite");
  const total = pick("total_tokens") ?? pick("total");
  if (!input && !output && !cacheRead && !cacheWrite && !total)
    return undefined;
  return { input, output, cacheRead, cacheWrite, total };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function collectText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => collectText(entry)).join("");
  }
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) {
    return value.content.map((entry) => collectText(entry)).join("");
  }
  if (isRecord(value.message)) return collectText(value.message);
  return "";
}

function pickSessionId(
  parsed: Record<string, unknown>,
  backend: CliBackendConfig,
): string | undefined {
  const fields = backend.sessionIdFields ?? [
    "session_id",
    "sessionId",
    "conversation_id",
    "conversationId",
  ];
  for (const field of fields) {
    const value = parsed[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function parseCliJson(
  raw: string,
  backend: CliBackendConfig,
): CliOutput | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const sessionId = pickSessionId(parsed, backend);
  const usage = isRecord(parsed.usage) ? toUsage(parsed.usage) : undefined;
  const text =
    collectText(parsed.message) ||
    collectText(parsed.content) ||
    collectText(parsed.result) ||
    collectText(parsed);
  return { text: text.trim(), sessionId, usage };
}

function parseCliJsonl(
  raw: string,
  backend: CliBackendConfig,
): CliOutput | null {
  const lines = raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  let sessionId: string | undefined;
  let usage: CliUsage | undefined;
  const texts: string[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    if (!sessionId) sessionId = pickSessionId(parsed, backend);
    if (!sessionId && typeof parsed.thread_id === "string") {
      sessionId = parsed.thread_id.trim();
    }
    if (isRecord(parsed.usage)) {
      usage = toUsage(parsed.usage) ?? usage;
    }
    const item = isRecord(parsed.item) ? parsed.item : null;
    if (item && typeof item.text === "string") {
      const type = typeof item.type === "string" ? item.type.toLowerCase() : "";
      if (!type || type.includes("message")) {
        texts.push(item.text);
      }
    }
  }
  const text = texts.join("\n").trim();
  if (!text) return null;
  return { text, sessionId, usage };
}

function resolveSystemPromptUsage(params: {
  backend: CliBackendConfig;
  isNewSession: boolean;
  systemPrompt?: string;
}): string | null {
  const systemPrompt = params.systemPrompt?.trim();
  if (!systemPrompt) return null;
  const when = params.backend.systemPromptWhen ?? "first";
  if (when === "never") return null;
  if (when === "first" && !params.isNewSession) return null;
  if (!params.backend.systemPromptArg?.trim()) return null;
  return systemPrompt;
}

function resolveSessionIdToSend(params: {
  backend: CliBackendConfig;
  cliSessionId?: string;
}): { sessionId?: string; isNew: boolean } {
  const mode = params.backend.sessionMode ?? "always";
  const existing = params.cliSessionId?.trim();
  if (mode === "none") return { sessionId: undefined, isNew: !existing };
  if (mode === "existing") return { sessionId: existing, isNew: !existing };
  if (existing) return { sessionId: existing, isNew: false };
  return { sessionId: crypto.randomUUID(), isNew: true };
}

function resolvePromptInput(params: {
  backend: CliBackendConfig;
  prompt: string;
}): { argsPrompt?: string; stdin?: string } {
  const inputMode = params.backend.input ?? "arg";
  if (inputMode === "stdin") {
    return { stdin: params.prompt };
  }
  if (
    params.backend.maxPromptArgChars &&
    params.prompt.length > params.backend.maxPromptArgChars
  ) {
    return { stdin: params.prompt };
  }
  return { argsPrompt: params.prompt };
}

function resolveImageExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("png")) return "png";
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("gif")) return "gif";
  if (normalized.includes("webp")) return "webp";
  return "bin";
}

function appendImagePathsToPrompt(prompt: string, paths: string[]): string {
  if (!paths.length) return prompt;
  const trimmed = prompt.trimEnd();
  const separator = trimmed ? "\n\n" : "";
  return `${trimmed}${separator}${paths.join("\n")}`;
}

async function writeCliImages(
  images: ImageContent[],
): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "clawdbot-cli-images-"),
  );
  const paths: string[] = [];
  for (let i = 0; i < images.length; i += 1) {
    const image = images[i];
    const ext = resolveImageExtension(image.mimeType);
    const filePath = path.join(tempDir, `image-${i + 1}.${ext}`);
    const buffer = Buffer.from(image.data, "base64");
    await fs.writeFile(filePath, buffer, { mode: 0o600 });
    paths.push(filePath);
  }
  const cleanup = async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  };
  return { paths, cleanup };
}

function buildCliArgs(params: {
  backend: CliBackendConfig;
  baseArgs: string[];
  modelId: string;
  sessionId?: string;
  systemPrompt?: string | null;
  imagePaths?: string[];
  promptArg?: string;
  useResume: boolean;
}): string[] {
  const args: string[] = [...params.baseArgs];
  if (!params.useResume && params.backend.modelArg && params.modelId) {
    args.push(params.backend.modelArg, params.modelId);
  }
  if (
    !params.useResume &&
    params.systemPrompt &&
    params.backend.systemPromptArg
  ) {
    args.push(params.backend.systemPromptArg, params.systemPrompt);
  }
  if (!params.useResume && params.sessionId) {
    if (params.backend.sessionArgs && params.backend.sessionArgs.length > 0) {
      for (const entry of params.backend.sessionArgs) {
        args.push(entry.replaceAll("{sessionId}", params.sessionId));
      }
    } else if (params.backend.sessionArg) {
      args.push(params.backend.sessionArg, params.sessionId);
    }
  }
  if (params.imagePaths && params.imagePaths.length > 0) {
    const mode = params.backend.imageMode ?? "repeat";
    const imageArg = params.backend.imageArg;
    if (imageArg) {
      if (mode === "list") {
        args.push(imageArg, params.imagePaths.join(","));
      } else {
        for (const imagePath of params.imagePaths) {
          args.push(imageArg, imagePath);
        }
      }
    }
  }
  if (params.promptArg !== undefined) {
    args.push(params.promptArg);
  }
  return args;
}

export async function runCliAgent(params: {
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  workspaceDir: string;
  config?: ClawdbotConfig;
  prompt: string;
  provider: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  timeoutMs: number;
  runId: string;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  cliSessionId?: string;
  images?: ImageContent[];
}): Promise<EmbeddedPiRunResult> {
  const started = Date.now();
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  const workspaceDir = resolvedWorkspace;

  const backendResolved = resolveCliBackendConfig(
    params.provider,
    params.config,
  );
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

  const bootstrapFiles = filterBootstrapFilesForSession(
    await loadWorkspaceBootstrapFiles(workspaceDir),
    params.sessionKey ?? params.sessionId,
  );
  const sessionLabel = params.sessionKey ?? params.sessionId;
  const contextFiles = buildBootstrapContextFiles(bootstrapFiles, {
    maxChars: resolveBootstrapMaxChars(params.config),
    warn: (message) => log.warn(`${message} (sessionKey=${sessionLabel})`),
  });
  const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
  });
  const heartbeatPrompt =
    sessionAgentId === defaultAgentId
      ? resolveHeartbeatPrompt(
          params.config?.agents?.defaults?.heartbeat?.prompt,
        )
      : undefined;
  const systemPrompt = buildSystemPrompt({
    workspaceDir,
    config: params.config,
    defaultThinkLevel: params.thinkLevel,
    extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    heartbeatPrompt,
    tools: [],
    contextFiles,
    modelDisplay,
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
    ? useResume ||
      Boolean(backend.sessionArg) ||
      Boolean(backend.sessionArgs?.length)
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
  const baseArgs = useResume
    ? (backend.resumeArgs ?? backend.args ?? [])
    : (backend.args ?? []);
  const resolvedArgs = useResume
    ? baseArgs.map((entry) =>
        entry.replaceAll("{sessionId}", cliSessionIdToSend ?? ""),
      )
    : baseArgs;
  const args = buildCliArgs({
    backend,
    baseArgs: resolvedArgs,
    modelId: normalizedModel,
    sessionId: cliSessionIdToSend,
    systemPrompt: systemPromptArg,
    imagePaths,
    promptArg: argsPrompt,
    useResume,
  });

  const serialize = backend.serialize ?? true;
  const queueKey = serialize
    ? backendResolved.id
    : `${backendResolved.id}:${params.runId}`;

  try {
    const output = await enqueueCliRun(queueKey, async () => {
      log.info(
        `cli exec: provider=${params.provider} model=${normalizedModel} promptChars=${params.prompt.length}`,
      );
      const logOutputText = process.env.CLAWDBOT_CLAUDE_CLI_LOG_OUTPUT === "1";
      if (logOutputText) {
        const logArgs: string[] = [];
        for (let i = 0; i < args.length; i += 1) {
          const arg = args[i] ?? "";
          if (arg === backend.systemPromptArg) {
            const systemPromptValue = args[i + 1] ?? "";
            logArgs.push(
              arg,
              `<systemPrompt:${systemPromptValue.length} chars>`,
            );
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

      if (useResume && cliSessionIdToSend) {
        await cleanupResumeProcesses(backend, cliSessionIdToSend);
      }

      const result = await runCommandWithTimeout([backend.command, ...args], {
        timeoutMs: params.timeoutMs,
        cwd: workspaceDir,
        env,
        input: stdinPayload,
      });

      const stdout = result.stdout.trim();
      const stderr = result.stderr.trim();
      if (logOutputText) {
        if (stdout) log.info(`cli stdout:\n${stdout}`);
        if (stderr) log.info(`cli stderr:\n${stderr}`);
      }
      if (shouldLogVerbose()) {
        if (stdout) log.debug(`cli stdout:\n${stdout}`);
        if (stderr) log.debug(`cli stderr:\n${stderr}`);
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

      const outputMode = useResume
        ? (backend.resumeOutput ?? backend.output)
        : backend.output;

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
          sessionId:
            output.sessionId ?? sessionIdSent ?? params.sessionId ?? "",
          provider: params.provider,
          model: modelId,
          usage: output.usage,
        },
      },
    };
  } catch (err) {
    if (err instanceof FailoverError) throw err;
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
  }
}

export async function runClaudeCliAgent(params: {
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  workspaceDir: string;
  config?: ClawdbotConfig;
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
    cliSessionId: params.claudeSessionId,
    images: params.images,
  });
}
