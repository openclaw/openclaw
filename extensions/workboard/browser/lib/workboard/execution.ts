import type { BoardGetParams, SessionsCreateResult } from "@openclaw/gateway-protocol";
import {
  isRecord,
  normalizeOptionalString,
  truncateUtf16Safe,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { replaceCard, workboardCardRunId, workboardCardSessionKey } from "./card-state.ts";
import { runWorkboardCardMutation } from "./mutations.ts";
import { normalizeCardPayload } from "./normalization.ts";
import { getWorkboardState, workboardMutationsReady, type WorkboardHost } from "./runtime.ts";
import { workboardCardSessionTarget } from "./session-resolution.ts";
import type {
  WorkboardCard,
  WorkboardExecutionEngine,
  WorkboardExecutionMode,
  WorkboardUiState,
} from "./types.ts";

const WORKBOARD_ENGINE_MODELS = {
  codex: "openai/gpt-6-astra",
  claude: "anthropic/claude-sonnet-4-6",
} as const;
const WORKBOARD_SESSION_LABEL_MAX_CHARS = 512;

export function canStartWorkboardCard(card: WorkboardCard): boolean {
  return !workboardCardSessionKey(card);
}

function assertCurrentCard(state: WorkboardUiState, card: WorkboardCard): void {
  const current = state.cards.find((candidate) => candidate.id === card.id);
  // Page hiding closes admission; an existing action still owns this revision.
  if (!current || current.updatedAt !== card.updatedAt) {
    throw new Error("This card changed. Refresh its details before starting or stopping it.");
  }
}

function buildCardSessionLabel(card: WorkboardCard): string {
  const suffix = card.id.trim().slice(0, 8) || "card";
  const title = card.title.trim() || "Workboard card";
  const suffixText = ` (${suffix})`;
  if (title.length + suffixText.length <= WORKBOARD_SESSION_LABEL_MAX_CHARS) {
    return `${title}${suffixText}`;
  }
  const titleMax = WORKBOARD_SESSION_LABEL_MAX_CHARS - suffixText.length;
  return `${truncateUtf16Safe(title, titleMax - 3).trimEnd()}...${suffixText}`;
}

function workboardRunWasAborted(result: unknown): boolean {
  return (
    isRecord(result) &&
    (result.aborted === true || (Array.isArray(result.runIds) && result.runIds.length > 0))
  );
}

export async function startWorkboardCard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  card: WorkboardCard;
  engine?: WorkboardExecutionEngine;
  mode?: WorkboardExecutionMode;
  requestUpdate?: () => void;
}): Promise<string | null> {
  const initialState = getWorkboardState(params.host);
  if (
    !params.client ||
    !workboardMutationsReady(initialState) ||
    initialState.dispatching ||
    initialState.busyCardIds.has(params.card.id)
  ) {
    return null;
  }
  const engine = params.engine;
  const mode = params.mode ?? "autonomous";
  const model =
    engine === "codex" || engine === "claude" ? WORKBOARD_ENGINE_MODELS[engine] : undefined;
  const scheduledAt = params.card.metadata?.automation?.scheduledAt;
  initialState.error = null;
  if (
    mode === "autonomous" &&
    (typeof scheduledAt === "number"
      ? scheduledAt > Date.now()
      : params.card.status === "scheduled")
  ) {
    initialState.error = "Scheduled cards cannot start before their scheduled time.";
    params.requestUpdate?.();
    return null;
  }
  const mutationResult = await runWorkboardCardMutation(
    { ...params, cardId: params.card.id, reconcileConflict: false },
    async (state, client) => {
      assertCurrentCard(state, params.card);
      if (!canStartWorkboardCard(params.card)) {
        throw new Error(
          "This card already has an execution. Refresh its details or use Edit to clear its session link before starting another.",
        );
      }
      if (mode === "autonomous") {
        const separator = model?.indexOf("/") ?? -1;
        const payload = await client.request("workboard.cards.start", {
          id: params.card.id,
          ...(separator > 0
            ? { provider: model?.slice(0, separator), model: model?.slice(separator + 1) }
            : {}),
        });
        assertCurrentCard(state, params.card);
        const card = normalizeCardPayload(payload);
        replaceCard(state, card);
        const sessionKey = workboardCardSessionKey(card);
        return sessionKey ?? null;
      }
      const shouldClearManualSchedule = params.card.metadata?.automation?.scheduledAt !== undefined;
      const shouldUnscheduleManual = params.card.status === "scheduled";
      const nextCardStatus = shouldUnscheduleManual ? "todo" : params.card.status;
      const result = await client.request<SessionsCreateResult>("sessions.create", {
        ...(params.card.agentId ? { agentId: params.card.agentId } : {}),
        label: buildCardSessionLabel(params.card),
        ...(model ? { model } : {}),
      });
      const sessionKey = normalizeOptionalString(result?.key);
      if (!sessionKey) {
        throw new Error("sessions.create returned no key");
      }
      assertCurrentCard(state, params.card);
      const now = Date.now();
      const payload = await client.request("workboard.cards.update", {
        id: params.card.id,
        expectedUpdatedAt: params.card.updatedAt,
        patch: {
          status: nextCardStatus,
          ...(shouldClearManualSchedule ? { scheduledAt: null } : {}),
          sessionKey,
          runId: null,
          ...(engine
            ? {
                execution: {
                  id: params.card.execution?.id ?? `${params.card.id}:agent-session`,
                  kind: "agent-session",
                  engine,
                  mode: "manual",
                  status: "idle",
                  startedAt: now,
                  updatedAt: now,
                  ...(model ? { model } : {}),
                  sessionKey,
                },
              }
            : { execution: null }),
        },
      });
      assertCurrentCard(state, params.card);
      replaceCard(state, normalizeCardPayload(payload));
      return sessionKey;
    },
  );
  return mutationResult === false ? null : mutationResult;
}

export async function stopWorkboardCard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  card: WorkboardCard;
  session?: BoardGetParams;
  requestUpdate?: () => void;
}) {
  const linkedSessionKey = workboardCardSessionKey(params.card);
  const session = workboardCardSessionTarget(params.card, params.session);
  if (!linkedSessionKey) {
    return;
  }
  await runWorkboardCardMutation(
    { ...params, cardId: params.card.id, reconcileConflict: false },
    async (state, client) => {
      const assertCurrent = () => assertCurrentCard(state, params.card);
      assertCurrent();
      let sessionAborted = false;
      if (session) {
        const runId = workboardCardRunId(params.card);
        const targetedAbort = await client.request("chat.abort", {
          ...session,
          ...(runId ? { runId } : {}),
        });
        assertCurrent();
        sessionAborted = workboardRunWasAborted(targetedAbort);
        // A stale card run id aborts nothing; retry session-wide before giving up.
        if (!sessionAborted && runId) {
          sessionAborted = workboardRunWasAborted(await client.request("chat.abort", session));
        }
      }
      assertCurrent();
      if (!sessionAborted) {
        if (!session) {
          throw new Error(
            "Refresh this card's session details before stopping it, or use Edit to choose its session.",
          );
        }
        return;
      }
      const payload = await client.request("workboard.cards.update", {
        id: params.card.id,
        expectedUpdatedAt: params.card.updatedAt,
        patch: {
          status: "blocked",
          ...(params.card.execution
            ? {
                execution: {
                  ...params.card.execution,
                  status: "blocked",
                  updatedAt: Date.now(),
                },
              }
            : {}),
        },
      });
      assertCurrent();
      replaceCard(state, normalizeCardPayload(payload));
    },
  );
}
