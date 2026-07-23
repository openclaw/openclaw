import { isSilentReplyText } from "openclaw/plugin-sdk/reply-runtime";
import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "openclaw/plugin-sdk/simple-completion-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  CoreConfig,
  MatrixFreshnessConfig,
  MatrixFreshnessFinalAction,
  MatrixFreshnessMode,
} from "../../types.js";
import {
  evaluateMatrixFreshnessObservation,
  resolveMatrixDraftFreshnessScope,
} from "./latest-visible.js";
import type { HistoryEntry } from "./room-history.js";
import type { ReplyPayload } from "./runtime-api.js";
import type { MatrixRawEvent } from "./types.js";
import { EventType } from "./types.js";

const MATRIX_DEFAULT_ALLOWED_FINAL_FRESHNESS_ACTIONS: MatrixFreshnessFinalAction[] = [
  "revise",
  "send-as-is",
  "suppress",
];

export type MatrixDraftFreshnessState = {
  roomChangedSinceDraftStart: boolean;
  invalidatingEventIds: string[];
  recheckEventIds: string[];
  latestPendingHistory?: HistoryEntry[];
  latestVisibleEventIds: string[];
  reason?: string;
};

type MatrixFinalFreshnessAiDecision = {
  finalAction?: string;
  action?: string;
  reason?: string;
};

export function sanitizeMatrixFinalFreshnessActions(
  actions?: readonly MatrixFreshnessFinalAction[],
): MatrixFreshnessFinalAction[] {
  const validActions = new Set<MatrixFreshnessFinalAction>(
    MATRIX_DEFAULT_ALLOWED_FINAL_FRESHNESS_ACTIONS,
  );
  const sanitized = Array.from(
    new Set(
      (actions ?? []).filter((action): action is MatrixFreshnessFinalAction =>
        validActions.has(action),
      ),
    ),
  );
  return sanitized.length > 0 ? sanitized : [...MATRIX_DEFAULT_ALLOWED_FINAL_FRESHNESS_ACTIONS];
}

export function resolveMatrixFreshnessMode(config?: MatrixFreshnessConfig): MatrixFreshnessMode {
  return config?.mode ?? "auto";
}

function extractMatrixFinalFreshnessJsonObject(text: string): MatrixFinalFreshnessAiDecision {
  const trimmed = text.trim();
  if (!trimmed) {
    return {};
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim();
  const candidate = fenced ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return {};
  }
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as MatrixFinalFreshnessAiDecision;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function resolveMatrixFinalFreshnessActionFromAiResult(params: {
  decision: MatrixFinalFreshnessAiDecision;
  allowedActions: readonly MatrixFreshnessFinalAction[];
}): MatrixFreshnessFinalAction | undefined {
  const action =
    typeof params.decision.finalAction === "string"
      ? params.decision.finalAction
      : typeof params.decision.action === "string"
        ? params.decision.action
        : undefined;
  if (!action) {
    return undefined;
  }
  return params.allowedActions.find((allowed) => allowed === action);
}

function resolveMatrixBodyForAgentBase(ctxPayload: Record<string, unknown>): string {
  const bodyForAgent = normalizeOptionalString(ctxPayload.BodyForAgent);
  if (bodyForAgent) {
    return bodyForAgent;
  }
  return normalizeOptionalString(ctxPayload.Body) ?? "";
}

function formatMatrixFreshnessHistoryEntry(entry: HistoryEntry): string {
  const sender = normalizeOptionalString(entry.sender) ?? "unknown";
  const body = normalizeOptionalString(entry.body) ?? "";
  const timestamp =
    typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
      ? ` timestamp=${entry.timestamp}`
      : "";
  const messageId = normalizeOptionalString(entry.messageId);
  return `- ${sender}${messageId ? ` [${messageId}]` : ""}${timestamp}: ${body}`;
}

function resolveMatrixRedactionTargetEventId(event: MatrixRawEvent): string | undefined {
  return normalizeOptionalString(event.redacts) ?? normalizeOptionalString(event.content?.redacts);
}

function historyEntryFromLatestVisibleEvent(event: MatrixRawEvent): HistoryEntry | undefined {
  const eventId = normalizeOptionalString(event.event_id);
  const sender = normalizeOptionalString(event.sender) ?? "unknown";
  const timestamp =
    typeof event.origin_server_ts === "number" && Number.isFinite(event.origin_server_ts)
      ? event.origin_server_ts
      : undefined;
  if (event.type === EventType.RoomMessage) {
    const body = normalizeOptionalString(event.content?.body);
    if (!body) {
      return undefined;
    }
    return {
      sender,
      body,
      timestamp,
      messageId: eventId,
    };
  }
  if (event.type === EventType.RoomRedaction) {
    const targetEventId = resolveMatrixRedactionTargetEventId(event);
    return {
      sender,
      body: targetEventId ? `[Matrix redaction of ${targetEventId}]` : "[Matrix redaction]",
      timestamp,
      messageId: eventId,
    };
  }
  return undefined;
}

function buildMatrixFinalFreshnessReviseBodyForAgent(params: {
  ctxPayload: Record<string, unknown>;
  draftText?: string;
  latestPendingHistory?: readonly HistoryEntry[];
}): string {
  const latestHistory = (params.latestPendingHistory ?? [])
    .map(formatMatrixFreshnessHistoryEntry)
    .join("\n");
  return [
    resolveMatrixBodyForAgentBase(params.ctxPayload),
    "",
    "System note: before this Matrix draft was published, newer relevant Matrix room messages arrived.",
    "Re-evaluate the original turn in light of the newer messages below. If the reply is now unnecessary, reply exactly NO_REPLY. Otherwise send the updated reply only.",
    "",
    "Unpublished draft text:",
    params.draftText?.trim() || "(empty)",
    "",
    "New Matrix messages since drafting began:",
    latestHistory || "(none)",
  ].join("\n");
}

export function computeMatrixDraftFreshnessState(params: {
  config?: MatrixFreshnessConfig;
  draftEventId?: string;
  historyAfterSnapshot?: readonly HistoryEntry[];
  latestVisibleEvents?: readonly MatrixRawEvent[];
  messageId?: string;
  replyToEventId?: string;
  selfUserId?: string;
  threadId?: string;
}): MatrixDraftFreshnessState {
  const ignoredEventIds = [params.messageId, params.draftEventId].filter((value): value is string =>
    Boolean(value?.trim()),
  );
  const draftScope = resolveMatrixDraftFreshnessScope({
    threadId: params.config?.scope === "room" ? undefined : params.threadId,
  });
  const invalidatingEventIds: string[] = [];
  const recheckEventIds: string[] = [];
  const latestVisibleHistory: HistoryEntry[] = [];
  for (const event of params.latestVisibleEvents ?? []) {
    const decision = evaluateMatrixFreshnessObservation({
      draftScope,
      event,
      selfUserId: params.selfUserId,
      ignoredEventIds,
      protectedEventIds: [params.messageId, params.replyToEventId].filter(
        (value): value is string => Boolean(value?.trim()),
      ),
    });
    if (
      params.config?.scope === "room" &&
      decision.action === "ignore" &&
      (decision.reason === "different-thread" ||
        decision.reason === "thread-irrelevant-root-message") &&
      event.type === EventType.RoomMessage
    ) {
      invalidatingEventIds.push(normalizeOptionalString(event.event_id) ?? "");
      const historyEntry = historyEntryFromLatestVisibleEvent(event);
      if (historyEntry) {
        latestVisibleHistory.push(historyEntry);
      }
      continue;
    }
    if (decision.action === "invalidate") {
      invalidatingEventIds.push(decision.eventId);
      const historyEntry = historyEntryFromLatestVisibleEvent(event);
      if (historyEntry) {
        latestVisibleHistory.push(historyEntry);
      }
    } else if (decision.action === "recheck") {
      recheckEventIds.push(decision.eventId);
      const historyEntry = historyEntryFromLatestVisibleEvent(event);
      if (historyEntry) {
        latestVisibleHistory.push(historyEntry);
      }
    }
  }
  const latestPendingHistory = (params.historyAfterSnapshot ?? []).filter(
    (entry) => entry.messageId !== params.messageId,
  );
  const latestPendingHistoryIds = new Set(
    latestPendingHistory.map((entry) => normalizeOptionalString(entry.messageId)).filter(Boolean),
  );
  const combinedLatestPendingHistory = [
    ...latestPendingHistory,
    ...latestVisibleHistory.filter((entry) => {
      const entryId = normalizeOptionalString(entry.messageId);
      return !entryId || !latestPendingHistoryIds.has(entryId);
    }),
  ];
  const historyChanged = latestPendingHistory.length > 0;
  const roomChangedSinceDraftStart =
    historyChanged || invalidatingEventIds.length > 0 || recheckEventIds.length > 0;
  return {
    roomChangedSinceDraftStart,
    invalidatingEventIds: invalidatingEventIds.filter(Boolean),
    recheckEventIds: recheckEventIds.filter(Boolean),
    latestPendingHistory:
      combinedLatestPendingHistory.length > 0 ? combinedLatestPendingHistory : undefined,
    latestVisibleEventIds: (params.latestVisibleEvents ?? [])
      .map((event) => normalizeOptionalString(event.event_id) ?? "")
      .filter(Boolean),
    reason: historyChanged
      ? "history-after-snapshot"
      : invalidatingEventIds.length > 0
        ? "latest-visible-event"
        : recheckEventIds.length > 0
          ? "protected-event-recheck"
          : undefined,
  };
}

export async function chooseMatrixFinalFreshnessAction(params: {
  allowedActions: readonly MatrixFreshnessFinalAction[];
  cfg: CoreConfig;
  config?: MatrixFreshnessConfig;
  ctxPayload: Record<string, unknown>;
  draftText?: string;
  mode: MatrixFreshnessMode;
  state: MatrixDraftFreshnessState;
  agentId: string;
  log?: (message: string) => void;
}): Promise<MatrixFreshnessFinalAction> {
  const allowedActions = sanitizeMatrixFinalFreshnessActions(params.allowedActions);
  const pickAllowed = (preferred: MatrixFreshnessFinalAction): MatrixFreshnessFinalAction =>
    allowedActions.includes(preferred) ? preferred : (allowedActions[0] ?? "send-as-is");

  if (params.mode !== "auto") {
    return params.mode;
  }
  if (params.config?.finalAction) {
    return params.config.finalAction;
  }
  if (params.config?.aiDeterminesFinalAction !== true) {
    return "send-as-is";
  }
  try {
    const prepared = await prepareSimpleCompletionModelForAgent({
      cfg: params.cfg as never,
      agentId: params.agentId,
      modelRef: params.config?.model?.trim() || undefined,
    });
    if ("error" in prepared) {
      params.log?.(`matrix freshness ai action selector unavailable: ${prepared.error}`);
      return pickAllowed("send-as-is");
    }
    const completion = await completeWithPreparedSimpleCompletionModel({
      model: prepared.model,
      auth: prepared.auth,
      context: [
        {
          role: "system",
          content:
            'Decide what to do with an unpublished Matrix agent draft after newer relevant room messages arrived. Return JSON only with schema {"finalAction":"revise|suppress|send-as-is","reason":string}. Use only allowedActions. revise means rewrite before sending, suppress means send nothing, send-as-is means send the existing draft unchanged.',
        },
        {
          role: "user",
          content: JSON.stringify({
            allowedActions,
            originalTurn: resolveMatrixBodyForAgentBase(params.ctxPayload),
            draftText: params.draftText ?? "",
            latestHistory: params.state.latestPendingHistory ?? [],
            invalidatingEventIds: params.state.invalidatingEventIds,
            recheckEventIds: params.state.recheckEventIds,
          }),
        },
      ] as never,
      options: { maxTokens: 180 } as never,
    });
    const selected = resolveMatrixFinalFreshnessActionFromAiResult({
      decision: extractMatrixFinalFreshnessJsonObject((completion as { text?: string }).text ?? ""),
      allowedActions,
    });
    return selected ?? pickAllowed("send-as-is");
  } catch (err) {
    params.log?.(`matrix freshness ai action selector failed: ${String(err)}`);
    return pickAllowed("send-as-is");
  }
}

export async function reviseMatrixFinalReplyWithFreshness(params: {
  cfg: CoreConfig;
  config?: MatrixFreshnessConfig;
  agentId: string;
  ctxPayload: Record<string, unknown>;
  draftText?: string;
  fallbackPayload: ReplyPayload;
  latestPendingHistory?: readonly HistoryEntry[];
  log?: (message: string) => void;
}): Promise<ReplyPayload | undefined> {
  const freshCtxPayload = {
    ...params.ctxPayload,
    BodyForAgent: buildMatrixFinalFreshnessReviseBodyForAgent({
      ctxPayload: params.ctxPayload,
      draftText: params.draftText,
      latestPendingHistory: params.latestPendingHistory,
    }),
    InboundHistory: params.latestPendingHistory,
  };
  const prepared = await prepareSimpleCompletionModelForAgent({
    cfg: params.cfg as never,
    agentId: params.agentId,
    modelRef: params.config?.model?.trim() || undefined,
  });
  if ("error" in prepared) {
    params.log?.(`matrix freshness revision model unavailable: ${prepared.error}`);
    return params.fallbackPayload;
  }
  let text: string | undefined;
  try {
    const completion = await completeWithPreparedSimpleCompletionModel({
      model: prepared.model,
      auth: prepared.auth,
      context: [
        {
          role: "user",
          content: freshCtxPayload.BodyForAgent,
        },
      ] as never,
      cfg: params.cfg as never,
    });
    text = (completion as { text?: string }).text;
  } catch (err) {
    params.log?.(`matrix freshness revision failed; sending original draft: ${String(err)}`);
    return params.fallbackPayload;
  }
  if (!text?.trim() || isSilentReplyText(text)) {
    return undefined;
  }
  return { text };
}
