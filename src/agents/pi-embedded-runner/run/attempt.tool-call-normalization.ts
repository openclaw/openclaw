import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { normalizeLowercaseStringOrEmpty } from "../../../shared/string-coerce.js";
import { validateAnthropicTurns, validateGeminiTurns } from "../../pi-embedded-helpers.js";
import {
  isRedactedSessionsSpawnAttachment,
  sanitizeToolUseResultPairing,
} from "../../session-transcript-repair.js";
import { extractToolCallsFromAssistant } from "../../tool-call-id.js";
import { normalizeToolName } from "../../tool-policy.js";
import { shouldAllowProviderOwnedThinkingReplay } from "../../transcript-policy.js";
import type { TranscriptPolicy } from "../../transcript-policy.js";

type UnknownToolLoopGuardState = {
  lastUnknownToolName?: string;
  count: number;
  countedMessages: WeakSet<object>;
};

type ClawCodeAliasResolution = {
  toolName: string;
  action?: string;
};

const CLAW_CODE_TOOL_ALIAS_MAP: Readonly<Record<string, ClawCodeAliasResolution>> = {
  bash: { toolName: "exec" },
  readfile: { toolName: "read" },
  writefile: { toolName: "write" },
  editfile: { toolName: "edit" },
  globsearch: { toolName: "glob" },
  grepsearch: { toolName: "grep" },
  webfetch: { toolName: "web_fetch" },
  websearch: { toolName: "web_search" },
  taskcreate: { toolName: "task", action: "create" },
  runtaskpacket: { toolName: "task", action: "create" },
  taskget: { toolName: "task", action: "get" },
  tasklist: { toolName: "task", action: "list" },
  taskstop: { toolName: "task", action: "stop" },
  taskupdate: { toolName: "task", action: "update" },
  taskoutput: { toolName: "task", action: "output" },
  teamcreate: { toolName: "team", action: "create" },
  teamdelete: { toolName: "team", action: "delete" },
  croncreate: { toolName: "cron", action: "add" },
  crondelete: { toolName: "cron", action: "remove" },
  cronlist: { toolName: "cron", action: "list" },
  listmcpresources: { toolName: "mcp", action: "list_resources" },
  readmcpresource: { toolName: "mcp", action: "read_resource" },
  mcpauth: { toolName: "mcp", action: "auth" },
  workercreate: { toolName: "sessions_spawn" },
  workersendprompt: { toolName: "sessions_send" },
  workerget: { toolName: "session_status" },
  workerobserve: { toolName: "session_status" },
  workerawaitready: { toolName: "session_status" },
  workerobservecompletion: { toolName: "session_status" },
  workerresolvetrust: { toolName: "session_status" },
  workerrestart: { toolName: "sessions_spawn" },
  workerterminate: { toolName: "subagents", action: "kill" },
  todowrite: { toolName: "todo_write" },
  skill: { toolName: "tool_search" },
  agent: { toolName: "sessions_spawn" },
  toolsearch: { toolName: "tool_search" },
  notebookedit: { toolName: "edit" },
  sleep: { toolName: "sleep" },
  sendusermessage: { toolName: "send_user_message" },
  config: { toolName: "config_compat" },
  enterplanmode: { toolName: "enter_plan_mode" },
  exitplanmode: { toolName: "exit_plan_mode" },
  structuredoutput: { toolName: "structured_output" },
  repl: { toolName: "exec" },
  powershell: { toolName: "exec" },
  askuserquestion: { toolName: "ask_user_question" },
  remotetrigger: { toolName: "remote_trigger" },
  testingpermission: { toolName: "testing_permission" },
  lsp: { toolName: "lsp" },
  mcpdemoecho: { toolName: "mcp" },
  memoryreflect: { toolName: "hermes", action: "memory_reflect" },
  skillsuggest: { toolName: "hermes", action: "skill_suggest" },
  longplan: { toolName: "hermes", action: "long_plan" },
  conversationslist: { toolName: "hermes", action: "conversations_list" },
  conversationget: { toolName: "hermes", action: "conversation_get" },
  messagesread: { toolName: "hermes", action: "messages_read" },
  attachmentsfetch: { toolName: "hermes", action: "attachments_fetch" },
  eventspoll: { toolName: "hermes", action: "events_poll" },
  eventswait: { toolName: "hermes", action: "events_wait" },
  messagessend: { toolName: "hermes", action: "messages_send" },
  channelslist: { toolName: "hermes", action: "channels_list" },
  permissionslistopen: { toolName: "hermes", action: "permissions_list_open" },
  permissionsrespond: { toolName: "hermes", action: "permissions_respond" },
};

function canonicalizeToolName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function resolveClawCodeAlias(
  rawName: string,
  allowedToolNames?: Set<string>,
): ClawCodeAliasResolution | null {
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return null;
  }
  const alias = CLAW_CODE_TOOL_ALIAS_MAP[canonicalizeToolName(rawName)];
  if (!alias) {
    return null;
  }
  if (!resolveExactAllowedToolName(alias.toolName, allowedToolNames)) {
    return null;
  }
  return alias;
}

function injectAliasActionIntoToolCallBlock(block: { input?: unknown; arguments?: unknown }, action: string) {
  const input =
    block.input && typeof block.input === "object" && !Array.isArray(block.input)
      ? (block.input as Record<string, unknown>)
      : null;
  if (input) {
    const existing = input.action;
    if (typeof existing !== "string" || !existing.trim()) {
      input.action = action;
    }
    return;
  }

  const argumentsPayload =
    block.arguments && typeof block.arguments === "object" && !Array.isArray(block.arguments)
      ? (block.arguments as Record<string, unknown>)
      : null;
  if (argumentsPayload) {
    const existing = argumentsPayload.action;
    if (typeof existing !== "string" || !existing.trim()) {
      argumentsPayload.action = action;
    }
    return;
  }

  block.arguments = { action };
}

function resolveToolCallPayloadRecord(block: { input?: unknown; arguments?: unknown }): Record<string, unknown> {
  if (block.input && typeof block.input === "object" && !Array.isArray(block.input)) {
    return block.input as Record<string, unknown>;
  }
  if (block.arguments && typeof block.arguments === "object" && !Array.isArray(block.arguments)) {
    return block.arguments as Record<string, unknown>;
  }
  block.arguments = {};
  return block.arguments as Record<string, unknown>;
}

function injectClawCodeAliasArgumentShims(
  rawName: string,
  block: { input?: unknown; arguments?: unknown },
): void {
  const aliasKey = canonicalizeToolName(rawName);
  const payload = resolveToolCallPayloadRecord(block);

  if (aliasKey === "workercreate") {
    const task = payload.task;
    if (typeof task !== "string" || !task.trim()) {
      const prompt = payload.prompt;
      const message = payload.message;
      if (typeof prompt === "string" && prompt.trim()) {
        payload.task = prompt;
      } else if (typeof message === "string" && message.trim()) {
        payload.task = message;
      } else {
        payload.task = "Start worker session";
      }
    }
    return;
  }

  if (aliasKey === "workersendprompt") {
    const message = payload.message;
    if (typeof message !== "string" || !message.trim()) {
      const prompt = payload.prompt;
      if (typeof prompt === "string" && prompt.trim()) {
        payload.message = prompt;
      }
    }
    const sessionKey = payload.sessionKey;
    if (typeof sessionKey !== "string" || !sessionKey.trim()) {
      const workerId = payload.workerId;
      const workerIdSnake = payload.worker_id;
      if (typeof workerId === "string" && workerId.trim()) {
        payload.sessionKey = workerId;
      } else if (typeof workerIdSnake === "string" && workerIdSnake.trim()) {
        payload.sessionKey = workerIdSnake;
      }
    }
    return;
  }

  if (
    aliasKey === "workerget" ||
    aliasKey === "workerobserve" ||
    aliasKey === "workerresolvetrust" ||
    aliasKey === "workerawaitready" ||
    aliasKey === "workerobservecompletion"
  ) {
    const sessionKey = payload.sessionKey;
    if (typeof sessionKey !== "string" || !sessionKey.trim()) {
      const workerId = payload.workerId;
      const workerIdSnake = payload.worker_id;
      if (typeof workerId === "string" && workerId.trim()) {
        payload.sessionKey = workerId;
      } else if (typeof workerIdSnake === "string" && workerIdSnake.trim()) {
        payload.sessionKey = workerIdSnake;
      }
    }
    return;
  }

  if (aliasKey === "workerrestart") {
    const sessionKey = payload.sessionKey;
    if (typeof sessionKey !== "string" || !sessionKey.trim()) {
      const workerId = payload.workerId;
      const workerIdSnake = payload.worker_id;
      if (typeof workerId === "string" && workerId.trim()) {
        payload.sessionKey = workerId;
      } else if (typeof workerIdSnake === "string" && workerIdSnake.trim()) {
        payload.sessionKey = workerIdSnake;
      }
    }
    const task = payload.task;
    if (typeof task !== "string" || !task.trim()) {
      const prompt = payload.prompt;
      const message = payload.message;
      if (typeof prompt === "string" && prompt.trim()) {
        payload.task = prompt;
      } else if (typeof message === "string" && message.trim()) {
        payload.task = message;
      } else {
        payload.task = "Restart worker";
      }
    }
    return;
  }

  if (aliasKey === "workerterminate") {
    const target = payload.target;
    if (typeof target !== "string" || !target.trim()) {
      const workerId = payload.workerId;
      const workerIdSnake = payload.worker_id;
      if (typeof workerId === "string" && workerId.trim()) {
        payload.target = workerId;
      } else if (typeof workerIdSnake === "string" && workerIdSnake.trim()) {
        payload.target = workerIdSnake;
      }
    }
    return;
  }

  if (aliasKey === "agent") {
    const task = payload.task;
    if (typeof task !== "string" || !task.trim()) {
      const prompt = payload.prompt;
      const message = payload.message;
      if (typeof prompt === "string" && prompt.trim()) {
        payload.task = prompt;
      } else if (typeof message === "string" && message.trim()) {
        payload.task = message;
      }
    }
    return;
  }

  if (aliasKey === "sendusermessage") {
    const message = payload.message;
    if (typeof message !== "string" || !message.trim()) {
      const text = payload.text;
      if (typeof text === "string" && text.trim()) {
        payload.message = text;
      }
    }
    return;
  }

  if (aliasKey === "toolsearch" || aliasKey === "skill") {
    const query = payload.query;
    if (typeof query !== "string" || !query.trim()) {
      const q = payload.q;
      if (typeof q === "string" && q.trim()) {
        payload.query = q;
      }
    }
    const maxResults = payload.max_results;
    if (
      (payload.max_results === undefined || payload.max_results === null) &&
      payload.maxResults === undefined &&
      typeof payload.limit === "number" &&
      Number.isFinite(payload.limit)
    ) {
      payload.max_results = Math.floor(payload.limit);
    } else if (typeof maxResults === "number" && Number.isFinite(maxResults)) {
      payload.max_results = Math.floor(maxResults);
    }
    return;
  }

  if (aliasKey === "mcpdemoecho") {
    const name = payload.name;
    if (typeof name !== "string" || !name.trim()) {
      payload.name = "demo__echo";
    }
    if (!payload.arguments || typeof payload.arguments !== "object" || Array.isArray(payload.arguments)) {
      const text = payload.text;
      payload.arguments =
        typeof text === "string" && text.trim()
          ? { text }
          : {};
    }
    const action = payload.action;
    if (typeof action !== "string" || !action.trim()) {
      payload.action = "call";
    }
    return;
  }

  if (aliasKey === "notebookedit") {
    const oldStr = payload.oldStr;
    if (typeof oldStr === "string" && oldStr.trim()) {
      const oldText = payload.oldText;
      if (typeof oldText !== "string" || !oldText.trim()) {
        payload.oldText = oldStr;
      }
    }
    const newStr = payload.newStr;
    if (typeof newStr === "string" && newStr.trim()) {
      const newText = payload.newText;
      if (typeof newText !== "string" || !newText.trim()) {
        payload.newText = newStr;
      }
    }
  }

  if (aliasKey === "taskcreate" || aliasKey === "runtaskpacket") {
    const task = payload.task;
    if (typeof task !== "string" || !task.trim()) {
      const prompt = payload.prompt;
      const objective = payload.objective;
      if (typeof prompt === "string" && prompt.trim()) {
        payload.task = prompt;
      } else if (typeof objective === "string" && objective.trim()) {
        payload.task = objective;
      }
    }
    return;
  }

  if (aliasKey === "croncreate") {
    const schedule = payload.schedule;
    if (typeof schedule === "string" && schedule.trim()) {
      payload.schedule = { kind: "cron", expr: schedule.trim() };
    }
    const prompt = payload.prompt;
    const text = payload.text;
    if (
      (!payload.payload || typeof payload.payload !== "object" || Array.isArray(payload.payload)) &&
      ((typeof prompt === "string" && prompt.trim()) || (typeof text === "string" && text.trim()))
    ) {
      payload.payload = {
        kind: "agentTurn",
        message:
          typeof prompt === "string" && prompt.trim()
            ? prompt.trim()
            : typeof text === "string" && text.trim()
              ? text.trim()
              : undefined,
      };
    }
    return;
  }

  if (aliasKey === "crondelete") {
    const jobId = payload.jobId;
    if (typeof jobId !== "string" || !jobId.trim()) {
      const cronId = payload.cronId;
      const cronIdSnake = payload.cron_id;
      if (typeof cronId === "string" && cronId.trim()) {
        payload.jobId = cronId;
      } else if (typeof cronIdSnake === "string" && cronIdSnake.trim()) {
        payload.jobId = cronIdSnake;
      }
    }
    return;
  }

  if (aliasKey === "sleep") {
    const durationMs = payload.duration_ms;
    if (
      (payload.ms === undefined || payload.ms === null) &&
      typeof durationMs === "number" &&
      Number.isFinite(durationMs)
    ) {
      payload.ms = Math.floor(durationMs);
    }
    return;
  }

  if (aliasKey === "config") {
    const path = payload.path;
    if ((typeof path !== "string" || !path.trim()) && typeof payload.setting === "string") {
      payload.path = payload.setting;
    }
    return;
  }

  if (aliasKey === "lsp") {
    const uri = payload.uri;
    if ((typeof uri !== "string" || !uri.trim()) && typeof payload.path === "string" && payload.path.trim()) {
      payload.uri = payload.path.trim();
    }
    return;
  }
}
function resolveCaseInsensitiveAllowedToolName(
  rawName: string,
  allowedToolNames?: Set<string>,
): string | null {
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return null;
  }
  const folded = normalizeLowercaseStringOrEmpty(rawName);
  let caseInsensitiveMatch: string | null = null;
  for (const name of allowedToolNames) {
    if (normalizeLowercaseStringOrEmpty(name) !== folded) {
      continue;
    }
    if (caseInsensitiveMatch && caseInsensitiveMatch !== name) {
      return null;
    }
    caseInsensitiveMatch = name;
  }
  return caseInsensitiveMatch;
}

function resolveExactAllowedToolName(
  rawName: string,
  allowedToolNames?: Set<string>,
): string | null {
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return null;
  }
  if (allowedToolNames.has(rawName)) {
    return rawName;
  }
  const normalized = normalizeToolName(rawName);
  if (allowedToolNames.has(normalized)) {
    return normalized;
  }
  return (
    resolveCaseInsensitiveAllowedToolName(rawName, allowedToolNames) ??
    resolveCaseInsensitiveAllowedToolName(normalized, allowedToolNames)
  );
}

function buildStructuredToolNameCandidates(rawName: string): string[] {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return [];
  }

  const candidates: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (value: string) => {
    const candidate = value.trim();
    if (!candidate || seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    candidates.push(candidate);
  };

  addCandidate(trimmed);
  addCandidate(normalizeToolName(trimmed));

  const normalizedDelimiter = trimmed.replace(/\//g, ".");
  addCandidate(normalizedDelimiter);
  addCandidate(normalizeToolName(normalizedDelimiter));

  const segments = normalizedDelimiter
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length > 1) {
    for (let index = 1; index < segments.length; index += 1) {
      const suffix = segments.slice(index).join(".");
      addCandidate(suffix);
      addCandidate(normalizeToolName(suffix));
    }
  }

  return candidates;
}

function resolveStructuredAllowedToolName(
  rawName: string,
  allowedToolNames?: Set<string>,
): string | null {
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return null;
  }

  const candidateNames = buildStructuredToolNameCandidates(rawName);
  for (const candidate of candidateNames) {
    if (allowedToolNames.has(candidate)) {
      return candidate;
    }
  }

  for (const candidate of candidateNames) {
    const caseInsensitiveMatch = resolveCaseInsensitiveAllowedToolName(candidate, allowedToolNames);
    if (caseInsensitiveMatch) {
      return caseInsensitiveMatch;
    }
  }

  return null;
}

function inferToolNameFromToolCallId(
  rawId: string | undefined,
  allowedToolNames?: Set<string>,
): string | null {
  if (!rawId || !allowedToolNames || allowedToolNames.size === 0) {
    return null;
  }
  const id = rawId.trim();
  if (!id) {
    return null;
  }

  const candidateTokens = new Set<string>();
  const addToken = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    candidateTokens.add(trimmed);
    candidateTokens.add(trimmed.replace(/[:._/-]\d+$/, ""));
    candidateTokens.add(trimmed.replace(/\d+$/, ""));

    const normalizedDelimiter = trimmed.replace(/\//g, ".");
    candidateTokens.add(normalizedDelimiter);
    candidateTokens.add(normalizedDelimiter.replace(/[:._-]\d+$/, ""));
    candidateTokens.add(normalizedDelimiter.replace(/\d+$/, ""));

    for (const prefixPattern of [/^functions?[._-]?/i, /^tools?[._-]?/i]) {
      const stripped = normalizedDelimiter.replace(prefixPattern, "");
      if (stripped !== normalizedDelimiter) {
        candidateTokens.add(stripped);
        candidateTokens.add(stripped.replace(/[:._-]\d+$/, ""));
        candidateTokens.add(stripped.replace(/\d+$/, ""));
      }
    }
  };

  const preColon = id.split(":")[0] ?? id;
  for (const seed of [id, preColon]) {
    addToken(seed);
  }

  let singleMatch: string | null = null;
  for (const candidate of candidateTokens) {
    const matched = resolveStructuredAllowedToolName(candidate, allowedToolNames);
    if (!matched) {
      continue;
    }
    if (singleMatch && singleMatch !== matched) {
      return null;
    }
    singleMatch = matched;
  }

  return singleMatch;
}

function looksLikeMalformedToolNameCounter(rawName: string): boolean {
  const normalizedDelimiter = rawName.trim().replace(/\//g, ".");
  return (
    /^(?:functions?|tools?)[._-]?/i.test(normalizedDelimiter) &&
    /(?:[:._-]\d+|\d+)$/.test(normalizedDelimiter)
  );
}

function normalizeToolCallNameForDispatch(
  rawName: string,
  allowedToolNames?: Set<string>,
  rawToolCallId?: string,
): string {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return inferToolNameFromToolCallId(rawToolCallId, allowedToolNames) ?? rawName;
  }
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return trimmed;
  }

  const clawAlias = resolveClawCodeAlias(trimmed, allowedToolNames);
  if (clawAlias) {
    return clawAlias.toolName;
  }

  const exact = resolveExactAllowedToolName(trimmed, allowedToolNames);
  if (exact) {
    return exact;
  }
  const inferredFromName = inferToolNameFromToolCallId(trimmed, allowedToolNames);
  if (inferredFromName) {
    return inferredFromName;
  }

  if (looksLikeMalformedToolNameCounter(trimmed)) {
    return trimmed;
  }

  return resolveStructuredAllowedToolName(trimmed, allowedToolNames) ?? trimmed;
}

function isToolCallBlockType(type: unknown): boolean {
  return type === "toolCall" || type === "toolUse" || type === "functionCall";
}

const REPLAY_TOOL_CALL_NAME_MAX_CHARS = 64;

type ReplayToolCallBlock = {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  arguments?: unknown;
};

type ReplayToolCallSanitizeReport = {
  messages: AgentMessage[];
  droppedAssistantMessages: number;
};

type AnthropicToolResultContentBlock = {
  type?: unknown;
  toolUseId?: unknown;
  toolCallId?: unknown;
  tool_use_id?: unknown;
  tool_call_id?: unknown;
};

function isThinkingLikeReplayBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") {
    return false;
  }
  const type = (block as { type?: unknown }).type;
  return type === "thinking" || type === "redacted_thinking";
}

function hasUnredactedSessionsSpawnAttachments(block: ReplayToolCallBlock): boolean {
  const rawName = typeof block.name === "string" ? block.name.trim() : "";
  if (normalizeLowercaseStringOrEmpty(rawName) !== "sessions_spawn") {
    return false;
  }
  for (const payload of [block.arguments, block.input]) {
    if (!payload || typeof payload !== "object") {
      continue;
    }
    const attachments = (payload as { attachments?: unknown }).attachments;
    if (!Array.isArray(attachments)) {
      continue;
    }
    for (const attachment of attachments) {
      if (!isRedactedSessionsSpawnAttachment(attachment)) {
        return true;
      }
    }
  }
  return false;
}

function isReplaySafeThinkingTurn(content: unknown[], allowedToolNames?: Set<string>): boolean {
  const seenToolCallIds = new Set<string>();
  for (const block of content) {
    if (!isReplayToolCallBlock(block)) {
      continue;
    }
    const replayBlock = block;
    const toolCallId = typeof replayBlock.id === "string" ? replayBlock.id.trim() : "";
    if (
      !replayToolCallHasInput(replayBlock) ||
      !toolCallId ||
      seenToolCallIds.has(toolCallId) ||
      hasUnredactedSessionsSpawnAttachments(replayBlock)
    ) {
      return false;
    }
    seenToolCallIds.add(toolCallId);
    const rawName = typeof replayBlock.name === "string" ? replayBlock.name : "";
    const resolvedName = resolveReplayToolCallName(rawName, toolCallId, allowedToolNames);
    if (!resolvedName || replayBlock.name !== resolvedName) {
      return false;
    }
  }
  return true;
}

function isReplayToolCallBlock(block: unknown): block is ReplayToolCallBlock {
  if (!block || typeof block !== "object") {
    return false;
  }
  return isToolCallBlockType((block as { type?: unknown }).type);
}

function replayToolCallHasInput(block: ReplayToolCallBlock): boolean {
  const hasInput = "input" in block ? block.input !== undefined && block.input !== null : false;
  const hasArguments =
    "arguments" in block ? block.arguments !== undefined && block.arguments !== null : false;
  return hasInput || hasArguments;
}

function replayToolCallNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveReplayToolCallName(
  rawName: string,
  rawId: string,
  allowedToolNames?: Set<string>,
): string | null {
  if (rawName.length > REPLAY_TOOL_CALL_NAME_MAX_CHARS * 2) {
    return null;
  }
  const normalized = normalizeToolCallNameForDispatch(rawName, allowedToolNames, rawId);
  const trimmed = normalized.trim();
  if (!trimmed || trimmed.length > REPLAY_TOOL_CALL_NAME_MAX_CHARS || /\s/.test(trimmed)) {
    return null;
  }
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return trimmed;
  }
  return resolveExactAllowedToolName(trimmed, allowedToolNames);
}

function sanitizeReplayToolCallInputs(
  messages: AgentMessage[],
  allowedToolNames?: Set<string>,
  allowProviderOwnedThinkingReplay?: boolean,
): ReplayToolCallSanitizeReport {
  let changed = false;
  let droppedAssistantMessages = 0;
  const out: AgentMessage[] = [];
  const claimedReplaySafeToolCallIds = new Set<string>();

  for (const message of messages) {
    if (!message || typeof message !== "object" || message.role !== "assistant") {
      out.push(message);
      continue;
    }
    if (!Array.isArray(message.content)) {
      out.push(message);
      continue;
    }
    if (
      allowProviderOwnedThinkingReplay &&
      message.content.some((block) => isThinkingLikeReplayBlock(block)) &&
      message.content.some((block) => isReplayToolCallBlock(block))
    ) {
      const replaySafeToolCalls = extractToolCallsFromAssistant(message);
      if (
        isReplaySafeThinkingTurn(message.content, allowedToolNames) &&
        replaySafeToolCalls.every((toolCall) => !claimedReplaySafeToolCallIds.has(toolCall.id))
      ) {
        for (const toolCall of replaySafeToolCalls) {
          claimedReplaySafeToolCallIds.add(toolCall.id);
        }
        out.push(message);
      } else {
        changed = true;
        droppedAssistantMessages += 1;
      }
      continue;
    }

    const nextContent: typeof message.content = [];
    let messageChanged = false;

    for (const block of message.content) {
      if (!isReplayToolCallBlock(block)) {
        nextContent.push(block);
        continue;
      }
      const replayBlock = block as ReplayToolCallBlock;

      if (!replayToolCallHasInput(replayBlock) || !replayToolCallNonEmptyString(replayBlock.id)) {
        changed = true;
        messageChanged = true;
        continue;
      }

      const rawName = typeof replayBlock.name === "string" ? replayBlock.name : "";
      injectClawCodeAliasArgumentShims(rawName, replayBlock);
      const resolvedName = resolveReplayToolCallName(rawName, replayBlock.id, allowedToolNames);
      if (!resolvedName) {
        changed = true;
        messageChanged = true;
        continue;
      }
      const clawAlias = resolveClawCodeAlias(rawName, allowedToolNames);

      if (replayBlock.name !== resolvedName) {
        const nextBlock = { ...(block as object), name: resolvedName } as ReplayToolCallBlock;
        if (clawAlias?.action) {
          injectAliasActionIntoToolCallBlock(nextBlock, clawAlias.action);
        }
        nextContent.push(nextBlock as typeof block);
        changed = true;
        messageChanged = true;
        continue;
      }
      if (clawAlias?.action) {
        injectAliasActionIntoToolCallBlock(replayBlock, clawAlias.action);
      }
      nextContent.push(block);
    }

    if (messageChanged) {
      changed = true;
      if (nextContent.length > 0) {
        out.push({ ...message, content: nextContent });
      } else {
        droppedAssistantMessages += 1;
      }
      continue;
    }

    out.push(message);
  }

  return {
    messages: changed ? out : messages,
    droppedAssistantMessages,
  };
}

function extractAnthropicReplayToolResultIds(block: AnthropicToolResultContentBlock): string[] {
  const ids: string[] = [];
  for (const value of [block.toolUseId, block.toolCallId, block.tool_use_id, block.tool_call_id]) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || ids.includes(trimmed)) {
      continue;
    }
    ids.push(trimmed);
  }
  return ids;
}

function isSignedThinkingReplayAssistantSpan(message: AgentMessage | undefined): boolean {
  if (!message || typeof message !== "object" || message.role !== "assistant") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  return (
    content.some((block) => isThinkingLikeReplayBlock(block)) &&
    content.some((block) => isReplayToolCallBlock(block))
  );
}

function sanitizeAnthropicReplayToolResults(
  messages: AgentMessage[],
  options?: {
    disallowEmbeddedUserToolResultsForSignedThinkingReplay?: boolean;
  },
): AgentMessage[] {
  let changed = false;
  const out: AgentMessage[] = [];
  const disallowEmbeddedUserToolResultsForSignedThinkingReplay =
    options?.disallowEmbeddedUserToolResultsForSignedThinkingReplay === true;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || message.role !== "user") {
      out.push(message);
      continue;
    }
    if (!Array.isArray(message.content)) {
      out.push(message);
      continue;
    }

    const previous = messages[index - 1];
    const shouldStripEmbeddedToolResults =
      disallowEmbeddedUserToolResultsForSignedThinkingReplay &&
      isSignedThinkingReplayAssistantSpan(previous);
    const validToolUseIds = new Set<string>();
    if (previous && typeof previous === "object" && previous.role === "assistant") {
      const previousContent = (previous as { content?: unknown }).content;
      if (Array.isArray(previousContent)) {
        for (const block of previousContent) {
          if (!block || typeof block !== "object") {
            continue;
          }
          const typedBlock = block as { type?: unknown; id?: unknown };
          if (!isToolCallBlockType(typedBlock.type) || typeof typedBlock.id !== "string") {
            continue;
          }
          const trimmedId = typedBlock.id.trim();
          if (trimmedId) {
            validToolUseIds.add(trimmedId);
          }
        }
      }
    }

    const nextContent = message.content.filter((block) => {
      if (!block || typeof block !== "object") {
        return true;
      }
      const typedBlock = block as AnthropicToolResultContentBlock;
      if (typedBlock.type !== "toolResult" && typedBlock.type !== "tool") {
        return true;
      }
      if (shouldStripEmbeddedToolResults) {
        changed = true;
        return false;
      }
      const resultIds = extractAnthropicReplayToolResultIds(typedBlock);
      if (resultIds.length === 0) {
        changed = true;
        return false;
      }
      return validToolUseIds.size > 0 && resultIds.some((id) => validToolUseIds.has(id));
    });

    if (nextContent.length === message.content.length) {
      out.push(message);
      continue;
    }

    changed = true;
    if (nextContent.length > 0) {
      out.push({ ...message, content: nextContent });
      continue;
    }

    out.push({
      ...message,
      content: [{ type: "text", text: "[tool results omitted]" }],
    } as AgentMessage);
  }

  return changed ? out : messages;
}

function normalizeToolCallIdsInMessage(message: unknown): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }

  const usedIds = new Set<string>();
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; id?: unknown };
    if (!isToolCallBlockType(typedBlock.type) || typeof typedBlock.id !== "string") {
      continue;
    }
    const trimmedId = typedBlock.id.trim();
    if (!trimmedId) {
      continue;
    }
    usedIds.add(trimmedId);
  }

  let fallbackIndex = 1;
  const assignedIds = new Set<string>();
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; id?: unknown };
    if (!isToolCallBlockType(typedBlock.type)) {
      continue;
    }
    if (typeof typedBlock.id === "string") {
      const trimmedId = typedBlock.id.trim();
      if (trimmedId) {
        if (!assignedIds.has(trimmedId)) {
          if (typedBlock.id !== trimmedId) {
            typedBlock.id = trimmedId;
          }
          assignedIds.add(trimmedId);
          continue;
        }
      }
    }

    let fallbackId = "";
    while (!fallbackId || usedIds.has(fallbackId) || assignedIds.has(fallbackId)) {
      fallbackId = `call_auto_${fallbackIndex++}`;
    }
    typedBlock.id = fallbackId;
    usedIds.add(fallbackId);
    assignedIds.add(fallbackId);
  }
}

function trimWhitespaceFromToolCallNamesInMessage(
  message: unknown,
  allowedToolNames?: Set<string>,
): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; name?: unknown; id?: unknown };
    if (!isToolCallBlockType(typedBlock.type)) {
      continue;
    }
    const rawId = typeof typedBlock.id === "string" ? typedBlock.id : undefined;
    if (typeof typedBlock.name === "string") {
      injectClawCodeAliasArgumentShims(typedBlock.name, typedBlock);
      const clawAlias = resolveClawCodeAlias(typedBlock.name, allowedToolNames);
      if (clawAlias?.action) {
        injectAliasActionIntoToolCallBlock(typedBlock, clawAlias.action);
      }
      const normalized = normalizeToolCallNameForDispatch(typedBlock.name, allowedToolNames, rawId);
      if (normalized !== typedBlock.name) {
        typedBlock.name = normalized;
      }
      continue;
    }
    const inferred = inferToolNameFromToolCallId(rawId, allowedToolNames);
    if (inferred) {
      typedBlock.name = inferred;
    }
  }
  normalizeToolCallIdsInMessage(message);
}

function classifyToolCallMessage(
  message: unknown,
  allowedToolNames?: Set<string>,
):
  | { kind: "none" }
  | { kind: "allowed" }
  | { kind: "incomplete" }
  | { kind: "unknown"; toolName: string } {
  if (!message || typeof message !== "object" || !allowedToolNames || allowedToolNames.size === 0) {
    return { kind: "none" };
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return { kind: "none" };
  }

  let unknownToolName: string | undefined;
  let sawToolCall = false;
  let sawAllowedToolCall = false;
  let sawIncompleteToolCall = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; name?: unknown };
    if (!isToolCallBlockType(typedBlock.type)) {
      continue;
    }
    sawToolCall = true;
    const rawName = typeof typedBlock.name === "string" ? typedBlock.name.trim() : "";
    if (!rawName) {
      sawIncompleteToolCall = true;
      continue;
    }
    if (resolveExactAllowedToolName(rawName, allowedToolNames)) {
      sawAllowedToolCall = true;
      continue;
    }
    const normalizedUnknownToolName = normalizeToolName(rawName);
    if (!unknownToolName) {
      unknownToolName = normalizedUnknownToolName;
      continue;
    }
    if (unknownToolName !== normalizedUnknownToolName) {
      sawIncompleteToolCall = true;
    }
  }

  if (!sawToolCall) {
    return { kind: "none" };
  }
  if (sawAllowedToolCall) {
    return { kind: "allowed" };
  }
  if (sawIncompleteToolCall) {
    return { kind: "incomplete" };
  }
  return unknownToolName ? { kind: "unknown", toolName: unknownToolName } : { kind: "incomplete" };
}

function rewriteUnknownToolLoopMessage(message: unknown, toolName: string): void {
  if (!message || typeof message !== "object") {
    return;
  }
  (message as { content?: unknown }).content = [
    {
      type: "text",
      text: `I can't use the tool "${toolName}" here because it isn't available. I need to stop retrying it and answer without that tool.`,
    },
  ];
}

function guardUnknownToolLoopInMessage(
  message: unknown,
  state: UnknownToolLoopGuardState,
  params: {
    allowedToolNames?: Set<string>;
    threshold?: number;
    countAttempt: boolean;
    resetOnAllowedTool?: boolean;
    resetOnMissingUnknownTool?: boolean;
  },
): boolean {
  const threshold = params.threshold;
  if (threshold === undefined || threshold <= 0) {
    return false;
  }

  const toolCallState = classifyToolCallMessage(message, params.allowedToolNames);
  if (toolCallState.kind === "allowed") {
    if (params.resetOnAllowedTool === true) {
      state.lastUnknownToolName = undefined;
      state.count = 0;
    }
    return false;
  }
  if (toolCallState.kind !== "unknown") {
    if (params.countAttempt && params.resetOnMissingUnknownTool !== false) {
      state.lastUnknownToolName = undefined;
      state.count = 0;
    }
    return false;
  }
  const unknownToolName = toolCallState.toolName;

  if (!params.countAttempt) {
    if (state.lastUnknownToolName === unknownToolName && state.count > threshold) {
      rewriteUnknownToolLoopMessage(message, unknownToolName);
    }
    return false;
  }

  if (message && typeof message === "object") {
    if (state.countedMessages.has(message)) {
      if (state.lastUnknownToolName === unknownToolName && state.count > threshold) {
        rewriteUnknownToolLoopMessage(message, unknownToolName);
      }
      return true;
    }
    state.countedMessages.add(message);
  }

  if (state.lastUnknownToolName === unknownToolName) {
    state.count += 1;
  } else {
    state.lastUnknownToolName = unknownToolName;
    state.count = 1;
  }

  if (state.count > threshold) {
    rewriteUnknownToolLoopMessage(message, unknownToolName);
  }
  return true;
}

function wrapStreamTrimToolCallNames(
  stream: ReturnType<typeof streamSimple>,
  allowedToolNames?: Set<string>,
  options?: { unknownToolThreshold?: number; state?: UnknownToolLoopGuardState },
): ReturnType<typeof streamSimple> {
  const unknownToolGuardState = options?.state ?? {
    count: 0,
    countedMessages: new WeakSet<object>(),
  };
  let streamAttemptAlreadyCounted = false;
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    trimWhitespaceFromToolCallNamesInMessage(message, allowedToolNames);
    guardUnknownToolLoopInMessage(message, unknownToolGuardState, {
      allowedToolNames,
      threshold: options?.unknownToolThreshold,
      countAttempt: !streamAttemptAlreadyCounted,
      resetOnAllowedTool: true,
    });
    return message;
  };

  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  (stream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[Symbol.asyncIterator] =
    function () {
      const iterator = originalAsyncIterator();
      return {
        async next() {
          const result = await iterator.next();
          if (!result.done && result.value && typeof result.value === "object") {
            const event = result.value as {
              partial?: unknown;
              message?: unknown;
            };
            trimWhitespaceFromToolCallNamesInMessage(event.partial, allowedToolNames);
            trimWhitespaceFromToolCallNamesInMessage(event.message, allowedToolNames);
            if (event.message && typeof event.message === "object") {
              const countedStreamAttempt = guardUnknownToolLoopInMessage(
                event.message,
                unknownToolGuardState,
                {
                  allowedToolNames,
                  threshold: options?.unknownToolThreshold,
                  countAttempt: !streamAttemptAlreadyCounted,
                  resetOnAllowedTool: true,
                  resetOnMissingUnknownTool: false,
                },
              );
              streamAttemptAlreadyCounted ||= countedStreamAttempt;
            }
            guardUnknownToolLoopInMessage(event.partial, unknownToolGuardState, {
              allowedToolNames,
              threshold: options?.unknownToolThreshold,
              countAttempt: false,
            });
          }
          return result;
        },
        async return(value?: unknown) {
          return iterator.return?.(value) ?? { done: true as const, value: undefined };
        },
        async throw(error?: unknown) {
          return iterator.throw?.(error) ?? { done: true as const, value: undefined };
        },
      };
    };

  return stream;
}

export function wrapStreamFnTrimToolCallNames(
  baseFn: StreamFn,
  allowedToolNames?: Set<string>,
  guardOptions?: { unknownToolThreshold?: number },
): StreamFn {
  const unknownToolGuardState: UnknownToolLoopGuardState = {
    count: 0,
    countedMessages: new WeakSet<object>(),
  };
  return (model, context, streamOptions) => {
    const maybeStream = baseFn(model, context, streamOptions);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamTrimToolCallNames(stream, allowedToolNames, {
          unknownToolThreshold: guardOptions?.unknownToolThreshold,
          state: unknownToolGuardState,
        }),
      );
    }
    return wrapStreamTrimToolCallNames(maybeStream, allowedToolNames, {
      unknownToolThreshold: guardOptions?.unknownToolThreshold,
      state: unknownToolGuardState,
    });
  };
}

export function wrapStreamFnSanitizeMalformedToolCalls(
  baseFn: StreamFn,
  allowedToolNames?: Set<string>,
  transcriptPolicy?: Pick<
    TranscriptPolicy,
    "validateGeminiTurns" | "validateAnthropicTurns" | "preserveSignatures" | "dropThinkingBlocks"
  >,
): StreamFn {
  return (model, context, options) => {
    const ctx = context as unknown as { messages?: unknown };
    const messages = ctx?.messages;
    if (!Array.isArray(messages)) {
      return baseFn(model, context, options);
    }
    const allowProviderOwnedThinkingReplay = shouldAllowProviderOwnedThinkingReplay({
      modelApi: (model as { api?: unknown })?.api as string | null | undefined,
      policy: {
        validateAnthropicTurns: transcriptPolicy?.validateAnthropicTurns === true,
        preserveSignatures: transcriptPolicy?.preserveSignatures === true,
        dropThinkingBlocks: transcriptPolicy?.dropThinkingBlocks === true,
      },
    });
    const sanitized = sanitizeReplayToolCallInputs(
      messages as AgentMessage[],
      allowedToolNames,
      allowProviderOwnedThinkingReplay,
    );
    const replayInputsChanged = sanitized.messages !== messages;
    let nextMessages = replayInputsChanged
      ? sanitizeToolUseResultPairing(sanitized.messages)
      : sanitized.messages;
    if (transcriptPolicy?.validateAnthropicTurns) {
      nextMessages = sanitizeAnthropicReplayToolResults(nextMessages, {
        disallowEmbeddedUserToolResultsForSignedThinkingReplay: allowProviderOwnedThinkingReplay,
      });
    }
    if (nextMessages === messages) {
      return baseFn(model, context, options);
    }
    if (sanitized.droppedAssistantMessages > 0 || transcriptPolicy?.validateAnthropicTurns) {
      if (transcriptPolicy?.validateGeminiTurns) {
        nextMessages = validateGeminiTurns(nextMessages);
      }
      if (transcriptPolicy?.validateAnthropicTurns) {
        nextMessages = validateAnthropicTurns(nextMessages);
      }
    }
    const nextContext = {
      ...(context as unknown as Record<string, unknown>),
      messages: nextMessages,
    } as unknown;
    return baseFn(model, nextContext as typeof context, options);
  };
}
