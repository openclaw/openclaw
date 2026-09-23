import { estimateStringChars } from "@openclaw/normalization-core/cjk-chars";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import { readTranscriptSenderIdentity } from "../chat/sender-identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ExecAutoReviewTranscript,
  ExecAutoReviewTranscriptEntry,
} from "../infra/exec-auto-review.js";
import { normalizeInputProvenance } from "../sessions/input-provenance.js";
import { redactTranscriptMessage } from "./transcript-redact.js";

const DEFAULT_LIMITS = {
  userAssistantChars: 4_000,
  toolChars: 1_000,
  nonUserEntries: 40,
  totalChars: 24_000,
} as const;

// Transcript metadata and binary payloads do not belong in reviewer evidence.
const OMITTED_FIELD =
  /^(?:details|media|(?:input_|output_)?(?:images?|image_url|audio|video)|(?:input_|output_)(?:file|document)|(?:image|audio|video|file|document)[_-]?(?:base64|bytes|data)|inline[_-]?data|base64|b64_json|blob|buffer|bytes|(?:source)?session[_-]?key|(?:origin)?session[_-]?id|(?:sender|peer|profile)[_-]?id)$/i;
function omitPayloads(key: string, value: unknown): unknown {
  if (OMITTED_FIELD.test(key)) {
    return undefined;
  }
  if (typeof value === "string" && /^data:[^\s,]*,/i.test(value.trimStart())) {
    return "[media omitted]";
  }
  const record = asOptionalRecord(value);
  return record &&
    (/^(?:(?:input_|output_)?(?:image|image_url|audio|video|file|document)|media|base64|buffer)$/i.test(
      String(record.type),
    ) ||
      record.encoding === "base64" ||
      (["mimeType", "mime_type", "mediaType", "media_type", "contentType", "content_type"].some(
        (field) => typeof record[field] === "string",
      ) &&
        (record.data !== undefined || record.content !== undefined)))
    ? undefined
    : value;
}

function textOnly(value: string): string {
  let text = value;
  if (/^\s*[[{]/.test(text)) {
    try {
      text = JSON.stringify(JSON.parse(text), omitPayloads) ?? "[media omitted]";
    } catch {
      // Ordinary prose and partial tool output stay text.
    }
  }
  return text.replace(/\bdata:[^\s,]*,[^\s"'<>]*/gi, "[media omitted]");
}

function userOrigin(message: AgentMessage): ExecAutoReviewTranscriptEntry["origin"] {
  const provenance = normalizeInputProvenance(Reflect.get(message, "provenance"));
  if (provenance?.kind === "inter_session" || provenance?.kind === "internal_system") {
    return provenance.kind;
  }
  const metadata = asOptionalRecord(Reflect.get(message, "__openclaw"));
  const identity = readTranscriptSenderIdentity(metadata?.senderIdentity);
  if (metadata?.senderIsOwner === true || identity?.type === "profile") {
    return "operator";
  }
  return identity?.type === "observation" ? "channel" : "unknown";
}

/** Projects current live messages into bounded, redacted reviewer evidence. */
export function buildExecAutoReviewTranscript(params: {
  messages: readonly AgentMessage[];
  config?: OpenClawConfig;
  userTurnOrigins?: ReadonlyMap<AgentMessage, AgentMessage>;
  limits?: Partial<Record<keyof typeof DEFAULT_LIMITS, number>>;
}): ExecAutoReviewTranscript {
  const limit = (key: keyof typeof DEFAULT_LIMITS, minimum = 0) => {
    const value = params.limits?.[key];
    return value === undefined || !Number.isFinite(value)
      ? DEFAULT_LIMITS[key]
      : Math.max(minimum, Math.min(DEFAULT_LIMITS[key], Math.floor(value)));
  };
  const limits = {
    userAssistantChars: limit("userAssistantChars"),
    toolChars: limit("toolChars"),
    nonUserEntries: limit("nonUserEntries"),
    // Two empty user anchors and the envelope must always fit.
    totalChars: limit("totalChars", 256),
  };
  const messages = params.messages.map((message) =>
    message.role === "user" ? (params.userTurnOrigins?.get(message) ?? message) : message,
  );
  const identifiers = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    const metadata = asOptionalRecord(Reflect.get(message, "__openclaw"));
    const identity = readTranscriptSenderIdentity(metadata?.senderIdentity);
    const provenance = normalizeInputProvenance(Reflect.get(message, "provenance"));
    for (const identifier of [
      metadata?.senderId,
      identity?.id,
      provenance?.sourceSessionKey,
      provenance?.originSessionId,
    ]) {
      if (typeof identifier === "string" && identifier) {
        identifiers.add(identifier);
        identifiers.add(JSON.stringify(identifier).slice(1, -1));
      }
    }
  }
  const privateIdentifiers = [...identifiers].toSorted((a, b) => b.length - a.length);
  const scrubIdentifiers = (text: string) =>
    privateIdentifiers.reduce(
      (result, identifier) => result.replaceAll(identifier, "[identity omitted]"),
      text,
    );
  const entries: ExecAutoReviewTranscriptEntry[] = [];
  const toolIds = new Map<string, string>();
  const add = (entry: ExecAutoReviewTranscriptEntry) => {
    const cap =
      entry.kind === "user" || entry.kind === "assistant"
        ? limits.userAssistantChars
        : limits.toolChars;
    const text = scrubIdentifiers(textOnly(entry.text));
    if (entry.toolCallId) {
      let alias = toolIds.get(entry.toolCallId);
      if (!alias) {
        alias = `tool-${toolIds.size + 1}`;
        toolIds.set(entry.toolCallId, alias);
      }
      entry.toolCallId = alias;
    }
    const toolName = entry.toolName && scrubIdentifiers(entry.toolName);
    entries.push({
      ...entry,
      text: truncateUtf16Safe(text, cap),
      ...(toolName === undefined ? {} : { toolName: truncateUtf16Safe(toolName, 256) }),
      ...(text.length > cap || (toolName?.length ?? 0) > 256 ? { truncated: true } : {}),
    });
  };
  for (const source of messages) {
    const message = redactTranscriptMessage(source, params.config);
    if (message.role === "user" || message.role === "toolResult") {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((block) => block.type === "text")
              .map((block) => textOnly(block.text))
              .join("\n");
      if (text) {
        add(
          message.role === "user"
            ? { kind: "user", text, origin: userOrigin(source) }
            : {
                kind: "tool_result",
                text,
                toolName: message.toolName,
                toolCallId: message.toolCallId,
              },
        );
      }
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "text" && block.text) {
          add({ kind: "assistant", text: block.text });
        } else if (block.type === "toolCall") {
          add({
            kind: "tool_call",
            text: JSON.stringify(block.arguments, omitPayloads) ?? "[media omitted]",
            toolName: block.name,
            toolCallId: block.id,
          });
        }
      }
    }
  }

  // Reserve the worst-case envelope, including omission-count digits, up front.
  const envelopeChars = estimateStringChars(
    JSON.stringify({
      entries: [],
      omittedEntries: entries.length,
      truncated: false,
    }),
  );
  const budget = Math.max(0, limits.totalChars - envelopeChars);
  const candidates = entries.map((entry) => ({
    entry,
    cost: estimateStringChars(JSON.stringify(entry)) + 1,
  }));
  type Candidate = (typeof candidates)[number];
  const selected = new Set<Candidate>();
  let used = 0;
  let nonUsers = 0;
  const anchors = [
    ...new Set([
      candidates.find(({ entry }) => entry.kind === "user"),
      candidates.findLast(({ entry }) => entry.kind === "user"),
    ]),
  ].filter((candidate) => candidate !== undefined);
  for (const candidate of anchors) {
    const { entry } = candidate;
    const allowance = Math.floor(budget / anchors.length);
    if (candidate.cost > allowance) {
      const original = entry.text;
      entry.truncated = true;
      let low = 0;
      let high = original.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        entry.text = truncateUtf16Safe(original, mid);
        if (estimateStringChars(JSON.stringify(entry)) + 1 <= allowance) {
          low = mid;
        } else {
          high = mid - 1;
        }
      }
      entry.text = truncateUtf16Safe(original, low);
      candidate.cost = estimateStringChars(JSON.stringify(entry)) + 1;
    }
    selected.add(candidate);
    used += candidate.cost;
  }

  const pendingCalls = new Map<string, Candidate>();
  const pairs = new Map<Candidate, Candidate>();
  for (const candidate of candidates) {
    const { entry } = candidate;
    if (entry.toolCallId && entry.kind === "tool_call") {
      pendingCalls.set(entry.toolCallId, candidate);
    } else if (entry.toolCallId && entry.kind === "tool_result") {
      const call = pendingCalls.get(entry.toolCallId);
      if (call !== undefined) {
        pairs.set(candidate, call);
        pairs.set(call, candidate);
        pendingCalls.delete(entry.toolCallId);
      }
    }
  }
  const visited = new Set<Candidate>();
  for (const candidate of candidates.toReversed()) {
    if (selected.has(candidate) || visited.has(candidate)) {
      continue;
    }
    const pair = pairs.get(candidate);
    const group = pair === undefined ? [candidate] : [candidate, pair];
    group.forEach((member) => visited.add(member));
    const nonUserCount = group.filter(({ entry }) => entry.kind !== "user").length;
    const cost = group.reduce((sum, member) => sum + member.cost, 0);
    if (used + cost > budget || nonUsers + nonUserCount > limits.nonUserEntries) {
      continue;
    }
    group.forEach((member) => selected.add(member));
    used += cost;
    nonUsers += nonUserCount;
  }
  const retained = candidates
    .filter((candidate) => selected.has(candidate))
    .map(({ entry }) => entry);
  const omittedEntries = entries.length - retained.length;
  return {
    entries: retained,
    omittedEntries,
    truncated: omittedEntries > 0 || retained.some((entry) => entry.truncated === true),
  };
}
