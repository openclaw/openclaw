import type {
  ControlUiAction,
  ControlUiHost,
  ControlUiSession,
} from "openclaw/plugin-sdk/control-ui";
import { isRecord, truncateUtf16Safe } from "openclaw/plugin-sdk/string-coerce-runtime";
import { t } from "./i18n/index.ts";
import { workboardCardBoardId } from "./lib/workboard/board-filter.ts";
import type { WorkboardCapability } from "./lib/workboard/capability.ts";
import {
  isActiveWorkboardCard,
  replaceCard,
  selectedWorkboardBoardParams,
} from "./lib/workboard/card-state.ts";
import { loadWorkboard } from "./lib/workboard/loading.ts";
import { normalizeCardPayload } from "./lib/workboard/normalization.ts";
import { findWorkboardSessionCard, isReservedSessionKey } from "./lib/workboard/session-links.ts";
import type { WorkboardCard, WorkboardStatus } from "./lib/workboard/types.ts";
import { matchesAgentScope } from "./pages/workboard/agent-filter.ts";
import { workboardPageTarget } from "./pages/workboard/page-target.ts";
import { openCardDetails } from "./pages/workboard/view-card-details.tsx";

const SESSION_CAPTURE_HISTORY_LIMIT = 40;
const SESSION_CAPTURE_HISTORY_MAX_CHARS = 6000;
const SESSION_CAPTURE_TEXT_MAX_CHARS = 700;
const WORKBOARD_CAPTURE_TITLE_MAX_CHARS = 180;

type SessionCaptureHistory = {
  recentUserText: string | null;
  lastAssistantText: string | null;
};

function trimmedLabel(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((part) => {
      if (!isRecord(part)) {
        return "";
      }
      if (typeof part.text === "string") {
        return part.text;
      }
      if (typeof part.content === "string") {
        return part.content;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractLatestChatText(messages: unknown[], role: "assistant" | "user"): string | null {
  for (const message of messages.toReversed()) {
    if (!isRecord(message) || message.role !== role) {
      continue;
    }
    const text = textFromContent(message.content).trim();
    if (text) {
      return text;
    }
  }
  return null;
}

function clampCaptureText(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${truncateUtf16Safe(compact, maxChars - 3).trimEnd()}...`;
}

function sessionTitle(row: ControlUiSession, recentUserText: string | null): string {
  const title =
    trimmedLabel(row.label) ?? trimmedLabel(row.displayName) ?? recentUserText ?? row.key;
  return clampCaptureText(title, WORKBOARD_CAPTURE_TITLE_MAX_CHARS);
}

function abortedLastRun(row: ControlUiSession): boolean {
  // abortedLastRun predates the Control UI session projection but still rides on wire rows.
  const record: unknown = row;
  return isRecord(record) && record.abortedLastRun === true;
}

function sessionCaptureStatus(row: ControlUiSession): WorkboardStatus {
  if (row.status === "queued") {
    return "todo";
  }
  if (row.hasActiveRun === true || row.status === "running") {
    return "running";
  }
  if (row.status === "failed" || abortedLastRun(row)) {
    return "blocked";
  }
  if (row.status === "done") {
    return "review";
  }
  return "todo";
}

function sessionCaptureNotes(sessionKey: string, history: SessionCaptureHistory): string {
  const lines = [`Session: ${sessionKey}`];
  if (history.recentUserText) {
    lines.push(
      "",
      `Recent user prompt: ${clampCaptureText(history.recentUserText, SESSION_CAPTURE_TEXT_MAX_CHARS)}`,
    );
  }
  if (history.lastAssistantText) {
    lines.push(
      "",
      `Latest assistant note: ${clampCaptureText(history.lastAssistantText, SESSION_CAPTURE_TEXT_MAX_CHARS)}`,
    );
  }
  return lines.join("\n");
}

async function loadSessionCaptureHistory(
  host: ControlUiHost,
  sessionKey: string,
): Promise<SessionCaptureHistory> {
  try {
    const payload = await host.request("chat.history", {
      sessionKey,
      limit: SESSION_CAPTURE_HISTORY_LIMIT,
      maxChars: SESSION_CAPTURE_HISTORY_MAX_CHARS,
    });
    const messages = isRecord(payload) && Array.isArray(payload.messages) ? payload.messages : [];
    return {
      recentUserText: extractLatestChatText(messages, "user"),
      lastAssistantText: extractLatestChatText(messages, "assistant"),
    };
  } catch {
    // Capture still creates a useful card when chat history is unavailable.
    return { recentUserText: null, lastAssistantText: null };
  }
}

export function createWorkboardSessionAction(
  host: ControlUiHost,
  workboard: WorkboardCapability,
): ControlUiAction {
  return {
    id: "capture-session",
    placement: "session",
    label: t("sessionsView.addToWorkboard"),
    resolve({ sessionKey, session }) {
      const row = session ?? host.sessions.rows.find((candidate) => candidate.key === sessionKey);
      const card = findWorkboardSessionCard(workboard.state.cards, sessionKey);
      return {
        label: t(
          card && isActiveWorkboardCard(card)
            ? "sessionsView.openWorkboardCard"
            : "sessionsView.addToWorkboard",
        ),
        disabled: workboard.state.dispatching,
        hidden:
          !host.connection.connected ||
          !host.connection.canWrite ||
          !row ||
          isReservedSessionKey(row.key),
      };
    },
    async run({ sessionKey, session, host: actionHost, signal }) {
      signal.throwIfAborted();
      const row =
        session ?? actionHost.sessions.rows.find((candidate) => candidate.key === sessionKey);
      if (!row || isReservedSessionKey(row.key)) {
        throw new Error("Refresh the session list, then add this session to Workboard again.");
      }
      if (!workboard.state.loaded) {
        // Details and board open against loaded cards, not a partial snapshot.
        await loadWorkboard({ host: workboard, client: actionHost, force: true });
        signal.throwIfAborted();
        if (!workboard.state.loaded) {
          throw new Error(
            workboard.state.error ?? "Workboard could not load. Refresh and try again.",
          );
        }
      }
      const existing = findWorkboardSessionCard(workboard.state.cards, row.key);
      let card: WorkboardCard;
      if (existing && isActiveWorkboardCard(existing)) {
        card = existing;
      } else {
        const history = await loadSessionCaptureHistory(actionHost, row.key);
        signal.throwIfAborted();
        const payload = await actionHost.request("workboard.cards.captureSession", {
          title: sessionTitle(row, history.recentUserText),
          notes: sessionCaptureNotes(row.key, history),
          status: sessionCaptureStatus(row),
          priority: "normal",
          agentId: "",
          sessionKey: row.key,
          ...selectedWorkboardBoardParams(workboard.state),
        });
        signal.throwIfAborted();
        card = normalizeCardPayload(payload);
        replaceCard(workboard.state, card);
      }
      // The source menu owns navigation after capture. Leaving it must not pull the user back.
      signal.throwIfAborted();
      // Card assignment can differ from the source session; widen only the page scope.
      if (
        !matchesAgentScope(
          card,
          actionHost.agents.defaultId ?? actionHost.connection.assistantAgentId,
          actionHost.agents.scopeId,
        )
      ) {
        actionHost.agents.setScope(null);
      }
      openCardDetails(workboard.state, card);
      workboard.notify();
      actionHost.navigation.openPage(workboardPageTarget(workboardCardBoardId(card)));
    },
  };
}
