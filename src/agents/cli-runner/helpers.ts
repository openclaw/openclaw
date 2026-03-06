import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { CliBackendConfig } from "../../config/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { buildTtsSystemPromptHint } from "../../tts/tts.js";
import { isRecord } from "../../utils.js";

const log = createSubsystemLogger("agent/claude-cli/stream");
import { buildModelAliasLines } from "../model-alias-lines.js";
import { resolveDefaultModelForAgent } from "../model-selection.js";
import { resolveOwnerDisplaySetting } from "../owner-display.js";
import type { EmbeddedContextFile } from "../pi-embedded-helpers.js";
import { detectRuntimeShell } from "../shell-utils.js";
import { buildSystemPromptParams } from "../system-prompt-params.js";
import { buildAgentSystemPrompt } from "../system-prompt.js";
export { buildCliSupervisorScopeKey, resolveCliNoOutputTimeoutMs } from "./reliability.js";

const CLI_RUN_QUEUE = new KeyedAsyncQueue();
export function enqueueCliRun<T>(key: string, task: () => Promise<T>): Promise<T> {
  return CLI_RUN_QUEUE.enqueue(key, task);
}

type CliUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

export type CliOutput = {
  text: string;
  sessionId?: string;
  usage?: CliUsage;
};

export function buildSystemPrompt(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  defaultThinkLevel?: ThinkLevel;
  extraSystemPrompt?: string;
  skillsPrompt?: string;
  ownerNumbers?: string[];
  heartbeatPrompt?: string;
  docsPath?: string;
  tools: AgentTool[];
  contextFiles?: EmbeddedContextFile[];
  bootstrapTruncationWarningLines?: string[];
  modelDisplay: string;
  agentId?: string;
}) {
  const defaultModelRef = resolveDefaultModelForAgent({
    cfg: params.config ?? {},
    agentId: params.agentId,
  });
  const defaultModelLabel = `${defaultModelRef.provider}/${defaultModelRef.model}`;
  const { runtimeInfo, userTimezone, userTime, userTimeFormat } = buildSystemPromptParams({
    config: params.config,
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
    cwd: process.cwd(),
    runtime: {
      host: "openclaw",
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      node: process.version,
      model: params.modelDisplay,
      defaultModel: defaultModelLabel,
      shell: detectRuntimeShell(),
    },
  });
  const ttsHint = params.config ? buildTtsSystemPromptHint(params.config) : undefined;
  const ownerDisplay = resolveOwnerDisplaySetting(params.config);
  return buildAgentSystemPrompt({
    workspaceDir: params.workspaceDir,
    defaultThinkLevel: params.defaultThinkLevel,
    extraSystemPrompt: params.extraSystemPrompt,
    skillsPrompt: params.skillsPrompt,
    ownerNumbers: params.ownerNumbers,
    ownerDisplay: ownerDisplay.ownerDisplay,
    ownerDisplaySecret: ownerDisplay.ownerDisplaySecret,
    reasoningTagHint: false,
    heartbeatPrompt: params.heartbeatPrompt,
    docsPath: params.docsPath,
    acpEnabled: params.config?.acp?.enabled !== false,
    runtimeInfo,
    toolNames: params.tools.map((tool) => tool.name),
    modelAliasLines: buildModelAliasLines(params.config),
    userTimezone,
    userTime,
    userTimeFormat,
    contextFiles: params.contextFiles,
    bootstrapTruncationWarningLines: params.bootstrapTruncationWarningLines,
    ttsHint,
    memoryCitationsMode: params.config?.memory?.citations,
  });
}

export function normalizeCliModel(modelId: string, backend: CliBackendConfig): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return trimmed;
  }
  const direct = backend.modelAliases?.[trimmed];
  if (direct) {
    return direct;
  }
  const lower = trimmed.toLowerCase();
  const mapped = backend.modelAliases?.[lower];
  if (mapped) {
    return mapped;
  }
  return trimmed;
}

function toUsage(raw: Record<string, unknown>): CliUsage | undefined {
  const pick = (key: string) =>
    typeof raw[key] === "number" && raw[key] > 0 ? raw[key] : undefined;
  const input = pick("input_tokens") ?? pick("inputTokens");
  const output = pick("output_tokens") ?? pick("outputTokens");
  const cacheRead =
    pick("cache_read_input_tokens") ?? pick("cached_input_tokens") ?? pick("cacheRead");
  const cacheWrite = pick("cache_write_input_tokens") ?? pick("cacheWrite");
  const total = pick("total_tokens") ?? pick("total");
  if (!input && !output && !cacheRead && !cacheWrite && !total) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite, total };
}

function collectText(value: unknown): string {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => collectText(entry)).join("");
  }
  if (!isRecord(value)) {
    return "";
  }
  if (typeof value.text === "string") {
    return value.text;
  }
  if (typeof value.content === "string") {
    return value.content;
  }
  if (Array.isArray(value.content)) {
    return value.content.map((entry) => collectText(entry)).join("");
  }
  if (isRecord(value.message)) {
    return collectText(value.message);
  }
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
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function parseCliJson(raw: string, backend: CliBackendConfig): CliOutput | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const sessionId = pickSessionId(parsed, backend);
  const usage = isRecord(parsed.usage) ? toUsage(parsed.usage) : undefined;
  const text =
    collectText(parsed.message) ||
    collectText(parsed.content) ||
    collectText(parsed.result) ||
    collectText(parsed);
  return { text: text.trim(), sessionId, usage };
}

export function parseCliJsonl(raw: string, backend: CliBackendConfig): CliOutput | null {
  const lines = raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return null;
  }
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
    if (!isRecord(parsed)) {
      continue;
    }
    if (!sessionId) {
      sessionId = pickSessionId(parsed, backend);
    }
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
  if (!text) {
    return null;
  }
  return { text, sessionId, usage };
}

export type StreamJsonCallbacks = {
  onSystemInit?: (payload: { subtype: string; sessionId?: string }) => void;
  onAssistantTurn?: (text: string) => void;
  onToolUse?: (toolName: string) => void;
  onThinkingTurn?: (payload: { text: string; delta?: string }) => void;
  onToolUseEvent?: (payload: { name: string; toolUseId?: string; input?: unknown }) => void;
  onToolResult?: (payload: { toolUseId?: string; text?: string; isError?: boolean }) => void;
};

const MAX_STREAM_EVENT_DEDUPE_KEYS = 2_048;
const KNOWN_STREAM_TOP_LEVEL_TYPES = new Set([
  "assistant",
  "user",
  "system",
  "result",
  "rate_limit_event",
]);
const KNOWN_STREAM_CONTENT_BLOCK_TYPES = new Set([
  "text",
  "thinking",
  "tool_use",
  "tool_result",
  "tool_result_error",
]);

type StreamContentBlock = Record<string, unknown>;

function extractContentBlocks(message: unknown): StreamContentBlock[] {
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return [];
  }
  return message.content.filter((entry): entry is StreamContentBlock => isRecord(entry));
}

function extractToolUseNames(contentBlocks: StreamContentBlock[]): string[] {
  const names: string[] = [];
  for (const block of contentBlocks) {
    if (block.type === "tool_use" && typeof block.name === "string") {
      names.push(block.name);
    }
  }
  return names;
}

function extractAssistantTextFromBlocks(contentBlocks: StreamContentBlock[]): string {
  const parts: string[] = [];
  for (const block of contentBlocks) {
    if (block.type !== "text") {
      continue;
    }
    if (typeof block.text === "string" && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

function extractThinkingTextFromBlocks(contentBlocks: StreamContentBlock[]): string {
  const parts: string[] = [];
  for (const block of contentBlocks) {
    if (block.type !== "thinking") {
      continue;
    }
    if (typeof block.thinking === "string" && block.thinking) {
      parts.push(block.thinking);
    }
  }
  return parts.join("");
}

type ToolUseBlockEvent = {
  name: string;
  toolUseId?: string;
  input?: unknown;
};

function extractToolUseEvents(contentBlocks: StreamContentBlock[]): ToolUseBlockEvent[] {
  const events: ToolUseBlockEvent[] = [];
  for (const block of contentBlocks) {
    if (block.type !== "tool_use" || typeof block.name !== "string") {
      continue;
    }
    const toolUseId = typeof block.id === "string" ? block.id : undefined;
    events.push({
      name: block.name,
      toolUseId,
      input: block.input,
    });
  }
  return events;
}

type ToolResultBlockEvent = {
  toolUseId?: string;
  text?: string;
  isError?: boolean;
};

function extractToolResultEvents(contentBlocks: StreamContentBlock[]): ToolResultBlockEvent[] {
  const events: ToolResultBlockEvent[] = [];
  for (const block of contentBlocks) {
    const type = typeof block.type === "string" ? block.type : "";
    if (type !== "tool_result" && type !== "tool_result_error") {
      continue;
    }
    const text = collectText(block.content ?? block.result ?? block.text).trim();
    const toolUseId =
      typeof block.tool_use_id === "string"
        ? block.tool_use_id
        : typeof block.toolUseId === "string"
          ? block.toolUseId
          : undefined;
    const isError = block.is_error === true || type === "tool_result_error";
    events.push({
      toolUseId,
      text: text || undefined,
      isError,
    });
  }
  return events;
}

function resolveDelta(nextText: string, previousText: string): string | undefined {
  if (!nextText) {
    return undefined;
  }
  if (!previousText) {
    return nextText;
  }
  if (nextText.startsWith(previousText)) {
    const delta = nextText.slice(previousText.length);
    return delta || undefined;
  }
  // Non-append rewrites should not be treated as deltas.
  return undefined;
}

function addDedupeKey(bucket: Set<string>, order: string[], key: string): boolean {
  if (bucket.has(key)) {
    return false;
  }
  bucket.add(key);
  order.push(key);
  if (order.length > MAX_STREAM_EVENT_DEDUPE_KEYS) {
    const oldest = order.shift();
    if (oldest) {
      bucket.delete(oldest);
    }
  }
  return true;
}

function stringifyForDedupe(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
}

function buildAnonymousToolUseKey(event: ToolUseBlockEvent): string {
  return `${event.name}:${stringifyForDedupe(event.input)}`;
}

function buildToolResultDedupeKey(event: ToolResultBlockEvent): string | undefined {
  if (!event.toolUseId) {
    return undefined;
  }
  return `${event.toolUseId}:${event.isError === true ? "1" : "0"}:${event.text ?? ""}`;
}

function shouldEmitAnonymousToolUse(
  event: ToolUseBlockEvent,
  lastKey: string | undefined,
): { emit: boolean; key: string } {
  const key = buildAnonymousToolUseKey(event);
  return { emit: key !== lastKey, key };
}

function formatToolResultDedupeKey(event: ToolResultBlockEvent): string | undefined {
  return buildToolResultDedupeKey(event);
}

function trackToolResultDedupeKey(
  emittedToolResultKeys: Set<string>,
  emittedToolResultOrder: string[],
  event: ToolResultBlockEvent,
): boolean {
  const dedupeKey = formatToolResultDedupeKey(event);
  if (!dedupeKey) {
    return true;
  }
  return addDedupeKey(emittedToolResultKeys, emittedToolResultOrder, dedupeKey);
}

function trackToolUseDedupeKey(
  emittedToolUseKeys: Set<string>,
  emittedToolUseOrder: string[],
  event: ToolUseBlockEvent,
): boolean {
  if (!event.toolUseId) {
    return true;
  }
  return addDedupeKey(emittedToolUseKeys, emittedToolUseOrder, event.toolUseId);
}

function shouldEmitToolUse(
  emittedToolUseKeys: Set<string>,
  emittedToolUseOrder: string[],
  event: ToolUseBlockEvent,
  lastAnonymousToolUseKey: string | undefined,
): { emit: boolean; nextAnonymousToolUseKey?: string } {
  if (event.toolUseId) {
    return {
      emit: trackToolUseDedupeKey(emittedToolUseKeys, emittedToolUseOrder, event),
      nextAnonymousToolUseKey: undefined,
    };
  }
  const anonymous = shouldEmitAnonymousToolUse(event, lastAnonymousToolUseKey);
  return {
    emit: anonymous.emit,
    nextAnonymousToolUseKey: anonymous.key,
  };
}

function shouldEmitToolResult(
  emittedToolResultKeys: Set<string>,
  emittedToolResultOrder: string[],
  event: ToolResultBlockEvent,
): boolean {
  return trackToolResultDedupeKey(emittedToolResultKeys, emittedToolResultOrder, event);
}

function isToolResultAllowedEnvelope(params: {
  isAssistantEnvelope: boolean;
  type: string;
  messageRole: string;
}): boolean {
  if (params.isAssistantEnvelope) {
    return true;
  }
  return (
    params.type === "user" ||
    params.type === "tool" ||
    params.messageRole === "user" ||
    params.messageRole === "tool"
  );
}

function buildFallbackAssistantText(params: {
  isAssistantEnvelope: boolean;
  extractedText: string;
  rawMessage: unknown;
  message: Record<string, unknown>;
}): string {
  if (!params.isAssistantEnvelope || params.extractedText) {
    return params.extractedText;
  }
  return collectText(params.rawMessage) || collectText(params.message);
}

function logUnknownStreamTypeOnce(params: {
  seen: Set<string>;
  value: string;
  kind: "top-level" | "content-block";
}): void {
  const normalized = params.value.trim();
  if (!normalized || params.seen.has(normalized)) {
    return;
  }
  params.seen.add(normalized);
  log.debug(`stream-json unknown ${params.kind} type observed: ${normalized}`);
}

export function createStreamJsonProcessor(
  backend: CliBackendConfig,
  callbacks?: StreamJsonCallbacks,
): {
  feed: (chunk: string) => void;
  finish: () => CliOutput;
} {
  let buffer = "";
  let lastAssistantText = "";
  let lastThinkingText = "";
  let resultText: string | undefined;
  let sessionId: string | undefined;
  let usage: CliUsage | undefined;
  const emittedToolUseKeys = new Set<string>();
  const emittedToolUseOrder: string[] = [];
  const emittedToolResultKeys = new Set<string>();
  const emittedToolResultOrder: string[] = [];
  let lastAnonymousToolUseKey: string | undefined;
  const seenUnknownTopLevelTypes = new Set<string>();
  const seenUnknownContentBlockTypes = new Set<string>();

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!isRecord(parsed)) {
      return;
    }

    const type = typeof parsed.type === "string" ? parsed.type : "";
    if (type && !KNOWN_STREAM_TOP_LEVEL_TYPES.has(type)) {
      logUnknownStreamTypeOnce({
        seen: seenUnknownTopLevelTypes,
        value: type,
        kind: "top-level",
      });
    }

    if (!sessionId) {
      sessionId = pickSessionId(parsed, backend);
    }

    if (type === "result") {
      resultText =
        (typeof parsed.result === "string" ? parsed.result : undefined) ?? collectText(parsed);
      if (isRecord(parsed.usage)) {
        usage = toUsage(parsed.usage);
      }
      log.debug(
        `stream-json result: ${resultText?.length ?? 0} chars, sessionId=${sessionId ?? "none"}`,
      );
      return;
    }

    if (type === "system") {
      const subtype = typeof parsed.subtype === "string" ? parsed.subtype : "";
      log.debug(`stream-json system: subtype=${subtype} sessionId=${sessionId ?? "none"}`);
      if (subtype === "init") {
        callbacks?.onSystemInit?.({ subtype, sessionId });
      }
      return;
    }
    if (type === "rate_limit_event") {
      return;
    }

    const rawMessage = parsed.message;
    const message = isRecord(rawMessage) ? rawMessage : parsed;
    const messageRole = typeof message.role === "string" ? message.role : "";
    const isAssistantEnvelope = type === "assistant" || messageRole === "assistant";
    const contentBlocks = extractContentBlocks(message);
    if (contentBlocks.length > 0) {
      for (const block of contentBlocks) {
        const blockType = typeof block.type === "string" ? block.type : "";
        if (!blockType || KNOWN_STREAM_CONTENT_BLOCK_TYPES.has(blockType)) {
          continue;
        }
        logUnknownStreamTypeOnce({
          seen: seenUnknownContentBlockTypes,
          value: blockType,
          kind: "content-block",
        });
      }
      const blockTypes = contentBlocks
        .map((block) => (typeof block.type === "string" ? block.type : "?"))
        .join(",");
      const extractedText = isAssistantEnvelope
        ? extractAssistantTextFromBlocks(contentBlocks)
        : "";
      const text = buildFallbackAssistantText({
        isAssistantEnvelope,
        extractedText,
        rawMessage,
        message,
      });
      const thinkingText = isAssistantEnvelope ? extractThinkingTextFromBlocks(contentBlocks) : "";
      const toolUseEvents = isAssistantEnvelope ? extractToolUseEvents(contentBlocks) : [];
      const allowToolResultEvents = isToolResultAllowedEnvelope({
        isAssistantEnvelope,
        type,
        messageRole,
      });
      const toolResultEvents = allowToolResultEvents ? extractToolResultEvents(contentBlocks) : [];
      const toolNames = extractToolUseNames(contentBlocks);

      if (isAssistantEnvelope) {
        log.debug(
          `stream-json assistant: blocks=[${blockTypes}] text=${text.length} chars thinking=${thinkingText.length} chars tools=[${toolNames.join(",")}]${text ? ` content=${text.slice(0, 200)}` : ""}`,
        );
      }

      if (text && text !== lastAssistantText) {
        lastAssistantText = text;
        callbacks?.onAssistantTurn?.(lastAssistantText);
      }

      if (thinkingText && thinkingText !== lastThinkingText) {
        const delta = resolveDelta(thinkingText, lastThinkingText);
        lastThinkingText = thinkingText;
        callbacks?.onThinkingTurn?.({
          text: thinkingText,
          ...(delta ? { delta } : {}),
        });
      }

      for (const event of toolUseEvents) {
        const dedupe = shouldEmitToolUse(
          emittedToolUseKeys,
          emittedToolUseOrder,
          event,
          lastAnonymousToolUseKey,
        );
        if (!dedupe.emit) {
          continue;
        }
        if (!event.toolUseId) {
          lastAnonymousToolUseKey = dedupe.nextAnonymousToolUseKey;
        } else {
          lastAnonymousToolUseKey = undefined;
        }
        callbacks?.onToolUse?.(event.name);
        callbacks?.onToolUseEvent?.(event);
      }

      for (const event of toolResultEvents) {
        if (!shouldEmitToolResult(emittedToolResultKeys, emittedToolResultOrder, event)) {
          continue;
        }
        callbacks?.onToolResult?.(event);
      }
    } else if (isAssistantEnvelope) {
      // Backward compatibility for custom stream-json backends that emit
      // assistant content as a string/object instead of typed content blocks.
      const fallbackText = collectText(rawMessage) || collectText(message);
      if (fallbackText && fallbackText !== lastAssistantText) {
        lastAssistantText = fallbackText;
        callbacks?.onAssistantTurn?.(lastAssistantText);
      }
    }
  };

  const feed = (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    // Keep the last (possibly incomplete) segment in buffer
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      try {
        processLine(line);
      } catch (err) {
        log.warn(`stream-json processLine error: ${String(err)}`);
      }
    }
  };

  const finish = (): CliOutput => {
    // Process any remaining data in buffer
    if (buffer.trim()) {
      processLine(buffer);
      buffer = "";
    }
    const text = resultText ?? lastAssistantText;
    return { text: text.trim(), sessionId, usage };
  };

  return { feed, finish };
}

export function resolveSystemPromptUsage(params: {
  backend: CliBackendConfig;
  isNewSession: boolean;
  systemPrompt?: string;
}): string | null {
  const systemPrompt = params.systemPrompt?.trim();
  if (!systemPrompt) {
    return null;
  }
  const when = params.backend.systemPromptWhen ?? "always";
  if (when === "never") {
    return null;
  }
  if (when === "first" && !params.isNewSession) {
    return null;
  }
  if (!params.backend.systemPromptArg?.trim()) {
    return null;
  }
  return systemPrompt;
}

export function resolveSessionIdToSend(params: {
  backend: CliBackendConfig;
  cliSessionId?: string;
}): { sessionId?: string; isNew: boolean } {
  const mode = params.backend.sessionMode ?? "always";
  const existing = params.cliSessionId?.trim();
  if (mode === "none") {
    return { sessionId: undefined, isNew: !existing };
  }
  if (mode === "existing") {
    return { sessionId: existing, isNew: !existing };
  }
  if (existing) {
    return { sessionId: existing, isNew: false };
  }
  return { sessionId: crypto.randomUUID(), isNew: true };
}

export function resolvePromptInput(params: { backend: CliBackendConfig; prompt: string }): {
  argsPrompt?: string;
  stdin?: string;
} {
  const inputMode = params.backend.input ?? "arg";
  if (inputMode === "stdin") {
    return { stdin: params.prompt };
  }
  if (params.backend.maxPromptArgChars && params.prompt.length > params.backend.maxPromptArgChars) {
    return { stdin: params.prompt };
  }
  return { argsPrompt: params.prompt };
}

function resolveImageExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("png")) {
    return "png";
  }
  if (normalized.includes("jpeg") || normalized.includes("jpg")) {
    return "jpg";
  }
  if (normalized.includes("gif")) {
    return "gif";
  }
  if (normalized.includes("webp")) {
    return "webp";
  }
  return "bin";
}

export function appendImagePathsToPrompt(prompt: string, paths: string[]): string {
  if (!paths.length) {
    return prompt;
  }
  const trimmed = prompt.trimEnd();
  const separator = trimmed ? "\n\n" : "";
  return `${trimmed}${separator}${paths.join("\n")}`;
}

export async function writeCliImages(
  images: ImageContent[],
): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-images-"));
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

export function buildCliArgs(params: {
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
  if (params.backend.modelArg && params.modelId) {
    args.push(params.backend.modelArg, params.modelId);
  }
  if (params.systemPrompt && params.backend.systemPromptArg) {
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
