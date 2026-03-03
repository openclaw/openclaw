/**
 * Claude SDK Session Adapter
 *
 * Creates a session object that implements the same duck-typed AgentSession interface
 * used by Pi, but drives the Claude Agent SDK query() loop under the hood.
 *
 * Key design points:
 * - Server-side sessions: NEVER concatenates message history into prompts.
 *   The resume parameter with persisted session_id is the sole multi-turn mechanism.
 * - In-process MCP: OpenClaw tools are exposed via createSdkMcpServer() so the
 *   Agent SDK agentic loop can call them. before_tool_call hooks fire automatically
 *   through the wrapped .execute() methods.
 * - enforceFinalTag must be false: Claude uses structured thinking, not XML tags.
 *   This is enforced in attempt.ts at the subscribeEmbeddedPiSession call.
 *
 * Per implementation-plan.md Section 4.1 and 4.4.
 */

import { createHash } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import { emitDiagnosticEvent } from "../../infra/diagnostic-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { estimateBase64DecodedBytes } from "../../media/base64.js";
import { resolveClaudeSubprocessEnv } from "./config.js";
import { mapSdkError } from "./error-mapping.js";
import { translateSdkMessageToEvents } from "./event-adapter.js";
import { createClaudeSdkMcpToolServer } from "./mcp-tool-server.js";
import { buildProviderEnv } from "./provider-env.js";
import {
  CLAUDE_SDK_STDERR_TAIL_MAX_CHARS,
  CLAUDE_SDK_STDOUT_TAIL_MAX_CHARS,
  createClaudeSdkSpawnWithStdoutTailLogging,
  type ClaudeSdkSpawnProcess,
} from "./spawn-stdout-logging.js";
import type {
  AgentRuntimeHints,
  ClaudeSdkEventAdapterState,
  ClaudeSdkSession,
  ClaudeSdkSessionParams,
} from "./types.js";

// ---------------------------------------------------------------------------
// ThinkLevel → maxThinkingTokens mapping
// OpenClaw runtime targets:
// - Default/basic thinking: ~4k tokens
// - Medium/deep thinking: ~10k tokens
// - Highest/extended thinking (ultrathink): ~40k tokens
// ---------------------------------------------------------------------------

function resolveThinkingTokenBudget(thinkLevel?: string): number | null {
  const level = thinkLevel?.toLowerCase();
  switch (level) {
    case "off":
    case "none":
      return null;
    case "low":
      return 4000;
    case "medium":
      return 10000;
    case "high":
      return 40000;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Query options builder
// ---------------------------------------------------------------------------

// Stream params from Pi that have no meaningful equivalent in the Claude SDK
// query API. Passing them through would either be silently ignored or cause
// unexpected behavior (e.g. temperature/maxTokens conflict with SDK defaults).
// "env" is blocked to prevent extraParams from accidentally overriding the
// provider env built by buildProviderEnv() — an empty or partial env causes
// the subprocess to fail auth (the SDK replaces process.env entirely).
const SDK_BLOCKED_EXTRA_PARAMS = new Set([
  "mcpServers",
  "permissionMode",
  "temperature",
  "maxTokens",
  "env",
]);
const log = createSubsystemLogger("agent/claude-sdk");
const THREAD_CONTEXT_MARKERS = [
  "[Thread history - for context]",
  "[Thread starter - for context]",
] as const;
const THREAD_CONTEXT_SCAN_LIMIT_CHARS = 16_384;
const MEDIA_PERSISTENCE_RETRY_BASE_MS = 15_000;
const MEDIA_PERSISTENCE_RETRY_MAX_MS = 10 * 60_000;
const MAX_REFERENCE_URL_CHARS = 2048;
const CLAUDE_SDK_MEDIA_REF_CUSTOM_TYPE = "openclaw:claude-sdk-media-ref";
const CLAUDE_SDK_MEDIA_PERSIST_FAILURE_CUSTOM_TYPE = "openclaw:claude-sdk-media-persist-failure";
const MEDIA_STATE_HYDRATE_SCAN_LIMIT_ENTRIES = 2000;

/**
 * Strips [Thread history - for context] / [Thread starter - for context] from
 * resumed prompts while preserving any preamble before the marker and the full
 * user body after the marker block.
 *
 * Conservative behavior:
 * - marker must appear near the prompt top segment and at a line boundary
 * - malformed formats fall back to no-op to avoid dropping user content
 */
function stripThreadContextPrefix(prompt: string): {
  prompt: string;
  stripped: boolean;
  removedChars: number;
  marker?: (typeof THREAD_CONTEXT_MARKERS)[number];
} {
  if (!prompt) {
    return { prompt, stripped: false, removedChars: 0 };
  }

  const scanWindow = prompt.slice(0, THREAD_CONTEXT_SCAN_LIMIT_CHARS);
  let selectedMarker: (typeof THREAD_CONTEXT_MARKERS)[number] | undefined;
  let markerIdx = -1;
  for (const marker of THREAD_CONTEXT_MARKERS) {
    const idx = scanWindow.indexOf(marker);
    if (idx === -1) {
      continue;
    }
    if (markerIdx === -1 || idx < markerIdx) {
      markerIdx = idx;
      selectedMarker = marker;
    }
  }
  if (markerIdx === -1 || !selectedMarker) {
    return { prompt, stripped: false, removedChars: 0 };
  }

  if (markerIdx > 0 && prompt[markerIdx - 1] !== "\n") {
    return { prompt, stripped: false, removedChars: 0 };
  }

  const markerEnd = markerIdx + selectedMarker.length;
  if (prompt[markerEnd] !== "\n") {
    return { prompt, stripped: false, removedChars: 0 };
  }
  const separatorIdx = prompt.indexOf("\n\n", markerEnd + 1);
  if (separatorIdx === -1) {
    return { prompt, stripped: false, removedChars: 0 };
  }

  const strippedPrompt = `${prompt.slice(0, markerIdx)}${prompt.slice(separatorIdx + 2)}`;
  const removedChars = separatorIdx + 2 - markerIdx;
  if (removedChars <= 0) {
    return { prompt, stripped: false, removedChars: 0 };
  }
  return {
    prompt: strippedPrompt,
    stripped: true,
    removedChars,
    marker: selectedMarker,
  };
}

function resolveTranscriptMetadata(provider?: string): {
  transcriptProvider: string;
  transcriptApi: string;
} {
  const normalized = provider ?? "claude-sdk";
  if (normalized === "claude-sdk" || normalized === "anthropic") {
    return {
      transcriptProvider: "anthropic",
      transcriptApi: "anthropic-messages",
    };
  }
  return {
    transcriptProvider: normalized,
    transcriptApi: "claude-sdk",
  };
}

function appendTail(currentTail: string | undefined, chunk: string, maxChars: number): string {
  if (!chunk) {
    return currentTail ?? "";
  }
  const next = `${currentTail ?? ""}${chunk}`;
  if (next.length <= maxChars) {
    return next;
  }
  return next.slice(-maxChars);
}

function emitClaudeSdkMetric(
  metric: string,
  params: Pick<
    ClaudeSdkSessionParams,
    "runId" | "sessionId" | "sessionKey" | "provider" | "modelId" | "attemptNumber"
  >,
  fields: Record<string, unknown>,
  diagnosticsEnabled = false,
): void {
  const payload = {
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider ?? "claude-sdk",
    model: params.modelId,
    attempt: params.attemptNumber,
    ...fields,
  };
  log.info(`[claude-sdk-metric] ${metric} ${JSON.stringify(payload)}`);
  if (!diagnosticsEnabled) {
    return;
  }
  emitDiagnosticEvent({
    type: "runtime.metric",
    metric,
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider ?? "claude-sdk",
    model: params.modelId,
    attempt: params.attemptNumber,
    fields,
  });
}

type AnthropicBase64ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
type RuntimePromptImage = ImageContent & { media_type?: string; url?: string };
type NormalizedPromptImage = {
  mimeType: string;
  base64Data?: string;
  url?: string;
};
type PreparedPromptImage =
  | {
      mimeType: string;
      filename: string;
      hash?: string;
      referenceType: "inline_base64";
      source: {
        type: "base64";
        media_type: AnthropicBase64ImageMediaType;
        data: string;
      };
      inlineBytes: number;
    }
  | {
      mimeType: string;
      filename: string;
      hash?: string;
      referenceType: "url";
      source: { type: "url"; url: string };
      inlineBytes: 0;
    }
  | {
      mimeType: string;
      filename: string;
      hash: string;
      referenceType: "file";
      source: { type: "file"; file_id: string };
      inlineBytes: 0;
    };
type PersistedUserContent = string | Array<{ type: "text"; text: string } | ImageContent>;
type ClaudePromptInput = string | AsyncIterable<SDKUserMessage>;
type PersistedMediaReference = {
  fileId: string;
  filename: string;
  sessionId?: string;
  provider?: string;
  modelId?: string;
  updatedAt: number;
};

const ANTHROPIC_BASE64_IMAGE_MEDIA_TYPES: ReadonlySet<AnthropicBase64ImageMediaType> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asTimestamp(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function hydratePersistedMediaStateFromSessionEntries(params: {
  state: ClaudeSdkEventAdapterState;
}): {
  restoredByHash: number;
  restoredByFilename: number;
  restoredFailures: number;
} {
  const entries = params.state.sessionManager?.getEntries?.();
  if (!Array.isArray(entries) || entries.length === 0) {
    return { restoredByHash: 0, restoredByFilename: 0, restoredFailures: 0 };
  }

  const hydratedByHash = params.state.mediaReferencesByHash ?? new Map();
  const hydratedByFilename = params.state.mediaReferencesByFilename ?? new Map();
  const hydratedFailures = params.state.mediaPersistenceFailuresByHash ?? new Map();
  const hydratedPersistedByName = params.state.persistedFileIdsByName ?? new Map();
  let restoredByHash = 0;
  let restoredByFilename = 0;
  let restoredFailures = 0;

  const start = Math.max(0, entries.length - MEDIA_STATE_HYDRATE_SCAN_LIMIT_ENTRIES);
  for (let i = entries.length - 1; i >= start; i -= 1) {
    const entry = entries[i];
    if (!entry || entry.type !== "custom") {
      continue;
    }
    if (entry.customType === CLAUDE_SDK_MEDIA_REF_CUSTOM_TYPE) {
      const data = asRecord(entry.data);
      if (!data) {
        continue;
      }
      const fileId = asString(data.fileId);
      if (!fileId) {
        continue;
      }
      const filename = asString(data.filename);
      const sessionId = asString(data.sessionId);
      const provider = asString(data.provider);
      const modelId = asString(data.modelId);
      const updatedAt = asTimestamp(data.updatedAt) ?? Date.now();
      const hash = asString(data.hash);

      if (filename && !hydratedByFilename.has(filename)) {
        hydratedByFilename.set(filename, {
          fileId,
          sessionId,
          provider,
          modelId,
          updatedAt,
        });
        hydratedPersistedByName.set(filename, fileId);
        restoredByFilename += 1;
      }

      if (hash && filename && !hydratedByHash.has(hash)) {
        hydratedByHash.set(hash, {
          fileId,
          filename,
          sessionId,
          provider,
          modelId,
          updatedAt,
        });
        restoredByHash += 1;
      }
      continue;
    }

    if (entry.customType === CLAUDE_SDK_MEDIA_PERSIST_FAILURE_CUSTOM_TYPE) {
      const data = asRecord(entry.data);
      if (!data) {
        continue;
      }
      const hash = asString(data.hash);
      const filename = asString(data.filename);
      if (!hash || !filename || hydratedFailures.has(hash)) {
        continue;
      }
      const reason = asString(data.reason) ?? "unknown";
      const failureCountRaw = data.failureCount;
      const failureCount =
        typeof failureCountRaw === "number" &&
        Number.isFinite(failureCountRaw) &&
        failureCountRaw > 0
          ? Math.floor(failureCountRaw)
          : 1;
      const lastFailureAt = asTimestamp(data.lastFailureAt) ?? Date.now();
      const retryAfter = asTimestamp(data.retryAfter) ?? lastFailureAt;
      hydratedFailures.set(hash, {
        filename,
        reason,
        failureCount,
        lastFailureAt,
        retryAfter,
      });
      restoredFailures += 1;
    }
  }

  params.state.mediaReferencesByHash = hydratedByHash;
  params.state.mediaReferencesByFilename = hydratedByFilename;
  params.state.mediaPersistenceFailuresByHash = hydratedFailures;
  params.state.persistedFileIdsByName = hydratedPersistedByName;

  return {
    restoredByHash,
    restoredByFilename,
    restoredFailures,
  };
}

function normalizePromptImageMimeType(image: RuntimePromptImage): string {
  const runtimeMimeType = typeof image.mimeType === "string" ? image.mimeType.trim() : "";
  if (runtimeMimeType.length > 0) {
    return runtimeMimeType;
  }
  const legacyMimeType = typeof image.media_type === "string" ? image.media_type.trim() : "";
  if (legacyMimeType.length > 0) {
    return legacyMimeType;
  }
  return "image/png";
}

function isHttpsUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return /^https?:\/\//i.test(value.trim());
}

function normalizePromptImages(images: RuntimePromptImage[] | undefined): NormalizedPromptImage[] {
  if (!Array.isArray(images) || images.length === 0) {
    return [];
  }
  const normalized: NormalizedPromptImage[] = [];
  for (const image of images) {
    if (!image) {
      continue;
    }
    const mimeType = normalizePromptImageMimeType(image);
    const directUrl = typeof image.url === "string" ? image.url.trim() : "";
    if (isHttpsUrl(directUrl)) {
      normalized.push({ mimeType, url: directUrl });
      continue;
    }
    const rawData = typeof image.data === "string" ? image.data.trim() : "";
    if (!rawData) {
      continue;
    }
    if (isHttpsUrl(rawData)) {
      normalized.push({ mimeType, url: rawData });
      continue;
    }
    const dataUriMatch = rawData.match(/^data:([^;,]+)?;base64,(.+)$/i);
    if (dataUriMatch) {
      normalized.push({
        mimeType: (dataUriMatch[1] ?? mimeType).trim(),
        base64Data: dataUriMatch[2].trim(),
      });
      continue;
    }
    normalized.push({ mimeType, base64Data: rawData });
  }
  return normalized;
}

function toAnthropicImageMediaType(mimeType: string): AnthropicBase64ImageMediaType {
  const normalized = mimeType.trim().toLowerCase();
  if (normalized === "image/jpg") {
    return "image/jpeg";
  }
  if (ANTHROPIC_BASE64_IMAGE_MEDIA_TYPES.has(normalized as AnthropicBase64ImageMediaType)) {
    return normalized as AnthropicBase64ImageMediaType;
  }
  return "image/png";
}

function resolveMimeExtension(mimeType: string): string {
  switch (toAnthropicImageMediaType(mimeType)) {
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/png":
    default:
      return "png";
  }
}

function makePromptImageHash(base64Data: string, mimeType: string): string {
  return createHash("sha256").update(mimeType).update(":").update(base64Data).digest("hex");
}

function buildPromptImageFilename(index: number, hash: string, mimeType: string): string {
  return `openclaw-image-${index + 1}-${hash.slice(0, 12)}.${resolveMimeExtension(mimeType)}`;
}

function isMediaReferenceUsable(
  reference: {
    fileId: string;
    sessionId?: string;
    provider?: string;
    modelId?: string;
  },
  params: {
    claudeSdkSessionId: string | undefined;
    provider?: string;
    modelId: string;
  },
): boolean {
  if (reference.sessionId) {
    if (!params.claudeSdkSessionId) {
      return false;
    }
    if (reference.sessionId !== params.claudeSdkSessionId) {
      return false;
    }
  }
  if (reference.provider && params.provider && reference.provider !== params.provider) {
    return false;
  }
  if (reference.modelId && reference.modelId !== params.modelId) {
    return false;
  }
  return typeof reference.fileId === "string" && reference.fileId.length > 0;
}

function buildPromptImages(params: {
  images: NormalizedPromptImage[];
  state: ClaudeSdkEventAdapterState;
  provider?: string;
  modelId: string;
}): {
  prepared: PreparedPromptImage[];
  inlineBytesSent: number;
  fileReferenceCount: number;
  pendingPersistence: Array<{ hash: string; filename: string }>;
} {
  if (params.images.length === 0) {
    return {
      prepared: [],
      inlineBytesSent: 0,
      fileReferenceCount: 0,
      pendingPersistence: [],
    };
  }
  const prepared: PreparedPromptImage[] = [];
  const pendingPersistence: Array<{ hash: string; filename: string }> = [];
  const mediaReferencesByHash = params.state.mediaReferencesByHash ?? new Map();
  const mediaReferencesByFilename = params.state.mediaReferencesByFilename ?? new Map();
  const mediaFailuresByHash = params.state.mediaPersistenceFailuresByHash ?? new Map();
  const pendingByFilename = params.state.pendingPersistHashesByFilename ?? new Map();
  let inlineBytesSent = 0;
  let fileReferenceCount = 0;
  const now = Date.now();

  for (const [index, image] of params.images.entries()) {
    if (image.base64Data) {
      const hash = makePromptImageHash(image.base64Data, image.mimeType);
      const filename = buildPromptImageFilename(index, hash, image.mimeType);
      const persistedRef = mediaReferencesByHash.get(hash);
      const recoveredFilenameRef = mediaReferencesByFilename.get(filename);
      const resolvedRef: PersistedMediaReference | undefined =
        persistedRef ??
        (recoveredFilenameRef
          ? {
              fileId: recoveredFilenameRef.fileId,
              filename,
              sessionId: recoveredFilenameRef.sessionId,
              provider: recoveredFilenameRef.provider,
              modelId: recoveredFilenameRef.modelId,
              updatedAt: recoveredFilenameRef.updatedAt,
            }
          : undefined);
      if (
        resolvedRef &&
        isMediaReferenceUsable(resolvedRef, {
          claudeSdkSessionId: params.state.claudeSdkSessionId,
          provider: params.provider,
          modelId: params.modelId,
        })
      ) {
        mediaReferencesByHash.set(hash, resolvedRef);
        mediaReferencesByFilename.set(filename, {
          fileId: resolvedRef.fileId,
          sessionId: resolvedRef.sessionId,
          provider: resolvedRef.provider,
          modelId: resolvedRef.modelId,
          updatedAt: resolvedRef.updatedAt,
        });
        fileReferenceCount += 1;
        prepared.push({
          mimeType: image.mimeType,
          filename,
          hash,
          referenceType: "file",
          source: {
            type: "file",
            file_id: resolvedRef.fileId,
          },
          inlineBytes: 0,
        });
        continue;
      }

      const failure = mediaFailuresByHash.get(hash);
      const backoffActive = Boolean(failure && failure.retryAfter > now);
      if (image.url && isHttpsUrl(image.url)) {
        prepared.push({
          mimeType: image.mimeType,
          filename,
          hash,
          referenceType: "url",
          source: { type: "url", url: image.url },
          inlineBytes: 0,
        });
        continue;
      }

      const mediaType = toAnthropicImageMediaType(image.mimeType);
      const inlineBytes = estimateBase64DecodedBytes(image.base64Data);
      inlineBytesSent += inlineBytes;
      prepared.push({
        mimeType: image.mimeType,
        filename,
        hash,
        referenceType: "inline_base64",
        source: {
          type: "base64",
          media_type: mediaType,
          data: image.base64Data,
        },
        inlineBytes,
      });

      if (!backoffActive) {
        pendingPersistence.push({ hash, filename });
        pendingByFilename.set(filename, hash);
      }
      continue;
    }

    if (!image.url || !isHttpsUrl(image.url)) {
      continue;
    }
    const urlHash = createHash("sha256").update(image.url).digest("hex");
    const filename = buildPromptImageFilename(index, urlHash, image.mimeType);
    prepared.push({
      mimeType: image.mimeType,
      filename,
      hash: urlHash,
      referenceType: "url",
      source: {
        type: "url",
        url: image.url.slice(0, MAX_REFERENCE_URL_CHARS),
      },
      inlineBytes: 0,
    });
  }

  params.state.mediaReferencesByHash = mediaReferencesByHash;
  params.state.mediaReferencesByFilename = mediaReferencesByFilename;
  params.state.mediaPersistenceFailuresByHash = mediaFailuresByHash;
  params.state.pendingPersistHashesByFilename = pendingByFilename;
  return { prepared, inlineBytesSent, fileReferenceCount, pendingPersistence };
}

function reconcilePromptMediaPersistence(params: {
  state: ClaudeSdkEventAdapterState;
  pendingPersistence: Array<{ hash: string; filename: string }>;
  persistedEventsStart: number;
  failedEventsStart: number;
  provider?: string;
  modelId: string;
}): { persistFailures: number; registeredFileRefs: number } {
  if (params.pendingPersistence.length === 0) {
    return { persistFailures: 0, registeredFileRefs: 0 };
  }

  const mediaReferencesByHash = params.state.mediaReferencesByHash ?? new Map();
  const mediaReferencesByFilename = params.state.mediaReferencesByFilename ?? new Map();
  const mediaFailuresByHash = params.state.mediaPersistenceFailuresByHash ?? new Map();
  const pendingByFilename = params.state.pendingPersistHashesByFilename ?? new Map();
  const persistedByName = params.state.persistedFileIdsByName ?? new Map();
  const newPersisted = (params.state.persistedFileEvents ?? []).slice(params.persistedEventsStart);
  const newFailed = (params.state.failedPersistedFileEvents ?? []).slice(params.failedEventsStart);
  const unresolved = [...params.pendingPersistence];
  let registeredFileRefs = 0;
  let persistFailures = 0;
  const now = Date.now();

  const resolveSuccess = (candidate: { hash: string; filename: string }, fileId: string) => {
    const nextRef = {
      fileId,
      filename: candidate.filename,
      sessionId: params.state.claudeSdkSessionId,
      provider: params.provider,
      modelId: params.modelId,
      updatedAt: now,
    };
    const existing = mediaReferencesByHash.get(candidate.hash);
    mediaReferencesByHash.set(candidate.hash, nextRef);
    mediaReferencesByFilename.set(candidate.filename, {
      fileId,
      sessionId: nextRef.sessionId,
      provider: nextRef.provider,
      modelId: nextRef.modelId,
      updatedAt: now,
    });
    mediaFailuresByHash.delete(candidate.hash);
    pendingByFilename.delete(candidate.filename);
    const changed =
      !existing ||
      existing.fileId !== nextRef.fileId ||
      existing.filename !== nextRef.filename ||
      existing.sessionId !== nextRef.sessionId ||
      existing.provider !== nextRef.provider ||
      existing.modelId !== nextRef.modelId;
    if (changed) {
      try {
        params.state.sessionManager?.appendCustomEntry?.(CLAUDE_SDK_MEDIA_REF_CUSTOM_TYPE, {
          hash: candidate.hash,
          fileId: nextRef.fileId,
          filename: nextRef.filename,
          sessionId: nextRef.sessionId,
          provider: nextRef.provider,
          modelId: nextRef.modelId,
          updatedAt: nextRef.updatedAt,
        });
      } catch {
        // Non-fatal — media reference persistence entry failed.
      }
    }
    registeredFileRefs += 1;
  };

  for (let i = unresolved.length - 1; i >= 0; i -= 1) {
    const candidate = unresolved[i];
    const byName = persistedByName.get(candidate.filename);
    if (!byName) {
      continue;
    }
    resolveSuccess(candidate, byName);
    unresolved.splice(i, 1);
  }

  for (const persistedEvent of newPersisted) {
    if (!persistedEvent.filename) {
      continue;
    }
    const idx = unresolved.findIndex((candidate) => candidate.filename === persistedEvent.filename);
    if (idx === -1) {
      continue;
    }
    resolveSuccess(unresolved[idx], persistedEvent.fileId);
    unresolved.splice(idx, 1);
  }

  if (unresolved.length > 0) {
    const namelessPersisted = newPersisted.filter((event) => !event.filename);
    if (namelessPersisted.length === unresolved.length) {
      for (let i = 0; i < unresolved.length; i += 1) {
        resolveSuccess(unresolved[i], namelessPersisted[i].fileId);
      }
      unresolved.length = 0;
    }
  }

  const recordFailure = (candidate: { hash: string; filename: string }, reason: string) => {
    const prev = mediaFailuresByHash.get(candidate.hash);
    const failureCount = (prev?.failureCount ?? 0) + 1;
    const retryMs = Math.min(
      MEDIA_PERSISTENCE_RETRY_BASE_MS * 2 ** (failureCount - 1),
      MEDIA_PERSISTENCE_RETRY_MAX_MS,
    );
    mediaFailuresByHash.set(candidate.hash, {
      filename: candidate.filename,
      reason,
      failureCount,
      lastFailureAt: now,
      retryAfter: now + retryMs,
    });
    try {
      params.state.sessionManager?.appendCustomEntry?.(
        CLAUDE_SDK_MEDIA_PERSIST_FAILURE_CUSTOM_TYPE,
        {
          hash: candidate.hash,
          filename: candidate.filename,
          reason,
          failureCount,
          lastFailureAt: now,
          retryAfter: now + retryMs,
        },
      );
    } catch {
      // Non-fatal — media persistence failure entry failed.
    }
    pendingByFilename.delete(candidate.filename);
    persistFailures += 1;
  };

  for (const failedEvent of newFailed) {
    if (!failedEvent.filename) {
      continue;
    }
    const idx = unresolved.findIndex((candidate) => candidate.filename === failedEvent.filename);
    if (idx === -1) {
      continue;
    }
    const [candidate] = unresolved.splice(idx, 1);
    recordFailure(candidate, failedEvent.error);
  }

  if (unresolved.length > 0) {
    const namelessFailed = newFailed.filter((event) => !event.filename);
    if (namelessFailed.length === unresolved.length) {
      for (let i = 0; i < unresolved.length; i += 1) {
        recordFailure(unresolved[i], namelessFailed[i].error);
      }
      unresolved.length = 0;
    }
  }

  params.state.mediaReferencesByHash = mediaReferencesByHash;
  params.state.mediaReferencesByFilename = mediaReferencesByFilename;
  params.state.mediaPersistenceFailuresByHash = mediaFailuresByHash;
  params.state.pendingPersistHashesByFilename = pendingByFilename;
  return { persistFailures, registeredFileRefs };
}

function buildPersistedUserContent(
  text: string,
  images: PreparedPromptImage[],
): PersistedUserContent {
  if (images.length === 0) {
    return text;
  }
  const content: Array<{ type: "text"; text: string } | ImageContent> = [{ type: "text", text }];
  for (const image of images) {
    if (image.referenceType === "inline_base64") {
      content.push({
        type: "image",
        data: image.source.data,
        mimeType: image.mimeType,
      });
      continue;
    }
    if (image.referenceType === "file") {
      content.push({
        type: "text",
        text:
          `[media_ref type=file hash=${image.hash} file_id=${image.source.file_id} ` +
          `filename=${image.filename} mime_type=${image.mimeType}]`,
      });
      continue;
    }
    content.push({
      type: "text",
      text:
        `[media_ref type=url hash=${image.hash ?? "n/a"} url=${image.source.url} ` +
        `filename=${image.filename} mime_type=${image.mimeType}]`,
    });
  }
  return content;
}

function buildClaudePromptInput(text: string, images: PreparedPromptImage[]): ClaudePromptInput {
  if (images.length === 0) {
    return text;
  }
  const userMessage = {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        { type: "text", text },
        ...images.map((image) => ({ type: "image" as const, source: image.source })),
      ],
    },
  } as unknown as SDKUserMessage;
  return (async function* () {
    yield userMessage;
  })();
}

function buildQueryOptions(
  params: ClaudeSdkSessionParams,
  state: ClaudeSdkEventAdapterState,
  toolServer: unknown,
): Record<string, unknown> {
  // Merge caller-provided MCP servers with our internal openclaw-tools bridge.
  // Spread caller servers first so that "openclaw-tools" always wins if the
  // caller accidentally uses that key.
  const mcpServers: Record<string, unknown> = {
    ...params.mcpServers,
    "openclaw-tools": toolServer,
  };

  const queryOptions: Record<string, unknown> = {
    model: params.modelId,
    mcpServers,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    systemPrompt: state.systemPrompt,
    tools: [],
    // Claude SDK session state (including server-side compaction context) must
    // persist for resume semantics to work across runs.
    persistSession: true,
    // Enable real-time streaming: the SDK yields stream_event messages with
    // token-level deltas so the UI can show text as it generates.
    includePartialMessages: true,
    // Use the caller-provided workspace for Claude SDK subprocess execution.
    cwd: params.workspaceDir,
    // Pass AbortController for canonical SDK cancellation. The SDK terminates
    // the underlying subprocess when this signal aborts. We also wire
    // interrupt() as defense-in-depth in the for-await loop.
    abortController: state.abortController,
    // Capture subprocess stderr so process exit errors have actionable context.
    // Without this the SDK discards stderr and "exited with code N" is opaque.
    stderr: (data: string) => {
      const tail = appendTail(state.lastStderr, data, CLAUDE_SDK_STDERR_TAIL_MAX_CHARS).trim();
      if (tail) {
        state.lastStderr = tail;
      }
    },
  };

  const maxThinkingTokens = resolveThinkingTokenBudget(params.thinkLevel);
  if (maxThinkingTokens !== null) {
    queryOptions.maxThinkingTokens = maxThinkingTokens;
  }

  if (params.extraParams) {
    for (const [key, value] of Object.entries(params.extraParams)) {
      if (!SDK_BLOCKED_EXTRA_PARAMS.has(key)) {
        queryOptions[key] = value;
      }
    }
  }

  // Resume from existing server-side session if we have a session_id.
  // CRITICAL: NEVER concatenate message history — server has full context.
  if (state.claudeSdkSessionId) {
    queryOptions.resume = state.claudeSdkSessionId;
  }

  const providerEnv = buildProviderEnv();

  const resolvedSubprocessEnv = resolveClaudeSubprocessEnv({
    providerEnv,
    claudeSdkConfig: params.claudeSdkConfig,
  });
  if (resolvedSubprocessEnv) {
    queryOptions["env"] = resolvedSubprocessEnv;
  }

  const customSpawn =
    typeof queryOptions.spawnClaudeCodeProcess === "function"
      ? (queryOptions.spawnClaudeCodeProcess as ClaudeSdkSpawnProcess)
      : undefined;
  queryOptions.spawnClaudeCodeProcess = createClaudeSdkSpawnWithStdoutTailLogging({
    baseSpawn: customSpawn,
    onExitCodeOne: (stdoutTail) => {
      const trimmed = stdoutTail.trim();
      if (!trimmed) {
        log.error("Claude Code subprocess exited with code 1 (stdout was empty).");
        return;
      }
      log.error(
        `Claude Code subprocess exited with code 1. stdout tail (last ${CLAUDE_SDK_STDOUT_TAIL_MAX_CHARS} chars):\n${trimmed}`,
      );
    },
  });

  return queryOptions;
}

// ---------------------------------------------------------------------------
// Main factory function
// ---------------------------------------------------------------------------

/**
 * Creates a Claude SDK session implementing the Pi AgentSession duck-typed interface.
 * The returned session can be used as a drop-in replacement for Pi's createAgentSession().
 */
export async function createClaudeSdkSession(
  params: ClaudeSdkSessionParams,
): Promise<ClaudeSdkSession> {
  const { transcriptProvider, transcriptApi } = resolveTranscriptMetadata(params.provider);

  // Internal adapter state
  const state: ClaudeSdkEventAdapterState = {
    subscribers: [],
    streaming: false,
    compacting: false,
    pendingCompactionEnd: undefined,
    abortController: null,
    systemPrompt: params.systemPrompt,
    pendingSteer: [],
    pendingToolUses: [],
    toolNameByUseId: new Map(),
    messages: [],
    messageIdCounter: 0,
    streamingMessageId: null,
    claudeSdkSessionId: params.claudeSdkResumeSessionId,
    sdkResultError: undefined,
    lastStderr: undefined,
    streamingBlockTypes: new Map(),
    streamingPartialMessage: null,
    streamingInProgress: false,
    sessionManager: params.sessionManager,
    transcriptProvider,
    transcriptApi,
    modelCost: params.modelCost,
    sessionIdPersisted: false,
    sdkStatus: null,
    sdkPermissionMode: undefined,
    replayedUserMessageUuids: new Set(),
    persistedFileIdsByName: new Map(),
    failedPersistedFilesByName: new Map(),
    persistedFileEvents: [],
    failedPersistedFileEvents: [],
    mediaReferencesByHash: new Map(),
    mediaReferencesByFilename: new Map(),
    pendingPersistHashesByFilename: new Map(),
    mediaPersistenceFailuresByHash: new Map(),
    lastAuthStatus: undefined,
    lastHookEvent: undefined,
    lastTaskEvent: undefined,
    lastRateLimitInfo: undefined,
    lastPromptSuggestion: undefined,
    compactBoundaryCount: 0,
    statusCompactingCount: 0,
    statusIdleCount: 0,
  };
  const restoredMediaState = hydratePersistedMediaStateFromSessionEntries({
    state,
  });
  if (
    restoredMediaState.restoredByHash > 0 ||
    restoredMediaState.restoredByFilename > 0 ||
    restoredMediaState.restoredFailures > 0
  ) {
    emitClaudeSdkMetric(
      "claude_sdk.media.state_hydrated",
      params,
      {
        restoredByHash: restoredMediaState.restoredByHash,
        restoredByFilename: restoredMediaState.restoredByFilename,
        restoredFailures: restoredMediaState.restoredFailures,
      },
      params.diagnosticsEnabled === true,
    );
  }

  const clearTurnToolCorrelationState = (): void => {
    if (state.pendingToolUses.length > 0 || state.toolNameByUseId.size > 0) {
      log.debug(
        `claude-sdk: clearing turn-local tool correlation state pending=${state.pendingToolUses.length} mapped=${state.toolNameByUseId.size}`,
      );
    }
    state.pendingToolUses.length = 0;
    state.toolNameByUseId.clear();
  };

  // Build in-process MCP tool server from OpenClaw tools (already wrapped with
  // before_tool_call hooks, abort signal propagation, and loop detection upstream)
  const allTools = [...params.tools, ...params.customTools];

  const toolServer = createClaudeSdkMcpToolServer({
    tools: allTools,
    emitEvent: (evt) => {
      for (const subscriber of state.subscribers) {
        subscriber(evt);
      }
    },
    getAbortSignal: () => state.abortController?.signal,
    consumePendingToolUse: () => {
      return state.pendingToolUses.shift();
    },
    appendRuntimeMessage: (message) => {
      state.messages.push(message);
    },
    sessionManager: state.sessionManager,
  });

  const session: ClaudeSdkSession = {
    subscribe(handler) {
      state.subscribers.push(handler);
      return () => {
        const idx = state.subscribers.indexOf(handler);
        if (idx !== -1) {
          state.subscribers.splice(idx, 1);
        }
      };
    },

    async prompt(text, options) {
      if (state.streaming) {
        throw new Error("Claude SDK session already has an in-flight prompt");
      }

      // Strip thread context only for resumed sessions, while preserving any
      // preamble and the complete user body.
      const stripResult = params.claudeSdkResumeSessionId
        ? stripThreadContextPrefix(text)
        : { prompt: text, stripped: false, removedChars: 0 };
      emitClaudeSdkMetric(
        "claude_sdk.prompt.thread_context_stripped",
        params,
        {
          stripped: stripResult.stripped,
          removedChars: stripResult.removedChars,
          marker: stripResult.marker,
        },
        params.diagnosticsEnabled === true,
      );

      // Drain any pending steer text by prepending to the current prompt.
      // Strip before steer prepend so steer content is never affected.
      const promptText = stripResult.prompt;
      const steerText = state.pendingSteer.splice(0).join("\n");
      const effectivePrompt = steerText ? `${steerText}\n\n${promptText}` : promptText;
      const promptImages = normalizePromptImages(
        options?.images as RuntimePromptImage[] | undefined,
      );
      const promptImagePlan = buildPromptImages({
        images: promptImages,
        state,
        provider: params.provider,
        modelId: params.modelId,
      });
      const turnPersistedEventsStart = state.persistedFileEvents?.length ?? 0;
      const turnFailedEventsStart = state.failedPersistedFileEvents?.length ?? 0;
      const persistedUserContent = buildPersistedUserContent(
        effectivePrompt,
        promptImagePlan.prepared,
      );
      const claudePromptInput = buildClaudePromptInput(effectivePrompt, promptImagePlan.prepared);
      const preQuerySessionId = state.claudeSdkSessionId;
      let persistFailuresForTurn = 0;
      let registeredFileRefsForTurn = 0;

      state.streaming = true;
      state.abortController = new AbortController();
      const { signal } = state.abortController;

      try {
        if (state.sessionManager?.appendMessage) {
          const userMessage = {
            role: "user" as const,
            content: persistedUserContent,
            timestamp: Date.now(),
          } as AgentMessage;
          state.messages.push(userMessage);
          try {
            state.sessionManager.appendMessage(userMessage);
          } catch {
            // Non-fatal — user message persistence failed
          }
        } else {
          state.messages.push({
            role: "user",
            content: persistedUserContent,
            timestamp: Date.now(),
          } as AgentMessage);
        }

        const queryOptions = buildQueryOptions(params, state, toolServer);
        const queryInstance = query({ prompt: claudePromptInput, options: queryOptions as never });

        // Wire abort signal to queryInstance.interrupt() so cancellation works
        // even when blocked on generator.next().
        const onAbort = () => {
          const qi = queryInstance as { interrupt?: () => Promise<void> };
          if (typeof qi.interrupt === "function") {
            qi.interrupt().catch(() => {});
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });

        try {
          for await (const message of queryInstance) {
            if (signal.aborted) {
              break;
            }
            translateSdkMessageToEvents(message as never, state);
          }
        } finally {
          signal.removeEventListener("abort", onAbort);
        }

        // After the query loop: throw if the SDK returned an error result message.
        // translateSdkMessageToEvents() stores the error in state.sdkResultError
        // when it encounters a result with subtype "error_*" or is_error: true.
        // Throwing here ensures prompt() rejects rather than resolving silently.
        if (state.sdkResultError) {
          throw new Error(state.sdkResultError);
        }
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") {
          // Aborted — normal flow, do not re-throw
          return;
        }
        // If SDK emitted a structured result error, keep that root cause even
        // when the subprocess exits with a generic code-1 transport error.
        if (state.sdkResultError) {
          const errMsg = state.sdkResultError;
          state.sdkResultError = undefined;
          throw mapSdkError(new Error(errMsg, { cause: err }));
        }
        // Enrich process-exit errors with captured stderr for actionable diagnostics.
        if (err instanceof Error && state.lastStderr) {
          err.message = `${err.message}\nSubprocess stderr: ${state.lastStderr}`;
        }
        throw mapSdkError(err);
      } finally {
        if (
          preQuerySessionId &&
          state.claudeSdkSessionId &&
          preQuerySessionId !== state.claudeSdkSessionId
        ) {
          state.mediaReferencesByHash?.clear();
          state.mediaReferencesByFilename?.clear();
          state.mediaPersistenceFailuresByHash?.clear();
          state.pendingPersistHashesByFilename?.clear();
          log.warn(
            `claude-sdk media reference state reset due to session id change ` +
              `${preQuerySessionId} -> ${state.claudeSdkSessionId}`,
          );
        }
        const reconciliation = reconcilePromptMediaPersistence({
          state,
          pendingPersistence: promptImagePlan.pendingPersistence,
          persistedEventsStart: turnPersistedEventsStart,
          failedEventsStart: turnFailedEventsStart,
          provider: params.provider,
          modelId: params.modelId,
        });
        persistFailuresForTurn = reconciliation.persistFailures;
        registeredFileRefsForTurn = reconciliation.registeredFileRefs;
        emitClaudeSdkMetric(
          "claude_sdk.media.inline_bytes_sent",
          params,
          {
            bytes: promptImagePlan.inlineBytesSent,
          },
          params.diagnosticsEnabled === true,
        );
        emitClaudeSdkMetric(
          "claude_sdk.media.file_ref_used",
          params,
          {
            count: promptImagePlan.fileReferenceCount,
            registeredForFutureTurns: registeredFileRefsForTurn,
          },
          params.diagnosticsEnabled === true,
        );
        if (persistFailuresForTurn > 0) {
          emitClaudeSdkMetric(
            "claude_sdk.media.persist_failures",
            params,
            {
              count: persistFailuresForTurn,
            },
            params.diagnosticsEnabled === true,
          );
        }
        // Turn-local correlation state must not leak into the next prompt turn.
        // At this point, all SDK messages for this turn have already been processed.
        clearTurnToolCorrelationState();
        state.streaming = false;
      }
    },

    async steer(text) {
      state.pendingSteer.push(text);
    },

    // -------------------------------------------------------------------------
    // abort — cancels the current in-flight query
    // -------------------------------------------------------------------------
    abort(): Promise<void> {
      state.abortController?.abort();
      return Promise.resolve();
    },

    abortCompaction() {
      if (state.compacting) {
        state.abortController?.abort();
      }
    },

    dispose() {
      if (state.sessionIdPersisted === true) {
        return;
      }
      if (!state.claudeSdkSessionId) {
        if (state.messages.length > 0) {
          log.warn(
            "claude-sdk dispose(): no session_id captured — server-side session may be orphaned",
          );
        }
        return;
      }
      if (params.sessionManager?.appendCustomEntry) {
        try {
          params.sessionManager.appendCustomEntry(
            "openclaw:claude-sdk-session-id",
            state.claudeSdkSessionId,
          );
          state.sessionIdPersisted = true;
        } catch {
          // Non-fatal — session_id persistence failed
        }
      }
    },

    get isStreaming() {
      return state.streaming;
    },
    get isCompacting() {
      return state.compacting;
    },
    get messages() {
      return state.messages;
    },
    get sessionId() {
      return params.sessionId;
    },
    get claudeSdkSessionId() {
      return state.claudeSdkSessionId;
    },
    get claudeSdkLifecycleSnapshot() {
      return {
        sdkStatus: state.sdkStatus,
        compactBoundaryCount: state.compactBoundaryCount ?? 0,
        statusCompactingCount: state.statusCompactingCount ?? 0,
        statusIdleCount: state.statusIdleCount ?? 0,
        lastAuthStatus: state.lastAuthStatus,
        lastHookEvent: state.lastHookEvent,
        lastTaskEvent: state.lastTaskEvent,
        lastRateLimitInfo: state.lastRateLimitInfo,
        lastPromptSuggestion: state.lastPromptSuggestion,
      };
    },

    // Local mirror only. Server-side session history remains authoritative.
    replaceMessages(messages: AgentMessage[]) {
      state.messages = [...messages];
    },
    setSystemPrompt(text: string) {
      state.systemPrompt = text;
    },

    runtimeHints: {
      allowSyntheticToolResults: false,
      enforceFinalTag: false,
      managesOwnHistory: true,
      supportsStreamFnWrapping: false,
      sessionFile: params.sessionFile,
    } satisfies AgentRuntimeHints,
  };

  return session;
}
