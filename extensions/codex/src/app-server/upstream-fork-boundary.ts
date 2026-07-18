import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import type { CodexSessionCatalogControl } from "../session-catalog-types.js";
import type { CodexThreadItem, CodexTurn } from "./protocol.js";

export type CodexUpstreamForkBoundaryFailureCode =
  | "steer-message"
  | "in-progress-turn"
  | "drift-mismatch"
  | "upstream-unavailable";

export type CodexUpstreamForkBoundary =
  | { wholeThread: true; targetTurnId: string }
  | { beforeTurnId: string; targetTurnId: string };

export type CodexUpstreamForkBoundaryResult =
  | { ok: true; boundary: CodexUpstreamForkBoundary }
  | { ok: false; code: CodexUpstreamForkBoundaryFailureCode; message: string };

const TURN_PAGE_LIMIT = 100;

type UserInput = {
  type?: unknown;
  text?: unknown;
  textElements?: unknown;
  url?: unknown;
  path?: unknown;
};

function failure(
  code: CodexUpstreamForkBoundaryFailureCode,
  message: string,
): CodexUpstreamForkBoundaryResult {
  return { ok: false, code, message };
}

function asInputs(item: CodexThreadItem): UserInput[] {
  return Array.isArray(item.content) ? (item.content as UserInput[]) : [];
}

function userMessageDisplay(item: CodexThreadItem): {
  text: string;
  visible: boolean;
} {
  let text = "";
  let hasTextElement = false;
  let hasImage = false;
  for (const input of asInputs(item)) {
    if (input.type === "text") {
      if (typeof input.text === "string") {
        text += input.text;
      }
      hasTextElement ||= Array.isArray(input.textElements) && input.textElements.length > 0;
    } else if (input.type === "image" || input.type === "localImage") {
      hasImage = true;
    }
  }
  return { text, visible: Boolean(text.trim()) || hasTextElement || hasImage };
}

function isHiddenNestedReviewTurn(previous: CodexTurn | undefined, turn: CodexTurn): boolean {
  if (
    previous?.status !== "completed" ||
    turn.status !== "interrupted" ||
    turn.completedAt != null ||
    !previous.items.some((item) => item.type === "enteredReviewMode") ||
    !previous.items.some((item) => item.type === "exitedReviewMode")
  ) {
    return false;
  }
  const userMessages = turn.items.filter((item) => item.type === "userMessage");
  return (
    userMessages.length === 2 &&
    JSON.stringify(asInputs(userMessages[0])) === JSON.stringify(asInputs(userMessages[1]))
  );
}

function localMessageText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .flatMap((block) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        return [];
      }
      const typed = block as { type?: unknown; text?: unknown };
      return typed.type === "text" && typeof typed.text === "string" ? [typed.text] : [];
    })
    .join("");
  return text || undefined;
}

export function resolveCodexUpstreamForkBoundaryFromTurns(params: {
  turns: readonly CodexTurn[];
  userMessageOrdinal: number;
  localText: string;
}): CodexUpstreamForkBoundaryResult {
  let visibleUserMessagesSeen = 0;
  let reviewMode = false;
  for (const [turnIndex, turn] of params.turns.entries()) {
    const hiddenNestedReviewTurn = isHiddenNestedReviewTurn(params.turns[turnIndex - 1], turn);
    let userMessagesInTurn = 0;
    for (const item of turn.items) {
      if (item.type === "enteredReviewMode") {
        reviewMode = true;
        continue;
      }
      if (item.type === "exitedReviewMode") {
        reviewMode = false;
        continue;
      }
      if (item.type !== "userMessage") {
        continue;
      }
      const isSteer = userMessagesInTurn > 0;
      userMessagesInTurn += 1;
      if (reviewMode || hiddenNestedReviewTurn) {
        continue;
      }
      const display = userMessageDisplay(item);
      if (!display.visible) {
        continue;
      }
      if (visibleUserMessagesSeen !== params.userMessageOrdinal) {
        visibleUserMessagesSeen += 1;
        continue;
      }
      if (isSteer) {
        return failure(
          "steer-message",
          "This message steered an existing Codex turn and cannot be forked independently. Fork from the turn's first message instead.",
        );
      }
      if (turn.status === "inProgress") {
        return failure(
          "in-progress-turn",
          "This Codex turn is still in progress. Wait for it to finish, then try forking again.",
        );
      }
      // The local transcript is only a mirror; never cut the authoritative rollout on ordinal alone.
      if (display.text !== params.localText) {
        return failure(
          "drift-mismatch",
          "The local message no longer matches the Codex thread. Refresh the session and try again.",
        );
      }
      return {
        ok: true,
        boundary:
          turnIndex === 0
            ? { wholeThread: true, targetTurnId: turn.id }
            : { beforeTurnId: turn.id, targetTurnId: turn.id },
      };
    }
  }
  return failure(
    "drift-mismatch",
    "The message could not be matched to the Codex thread. Refresh the session and try again.",
  );
}

export async function listCodexUpstreamTurns(
  control: CodexSessionCatalogControl,
  threadId: string,
): Promise<CodexTurn[]> {
  const turns: CodexTurn[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await control.listTurnPage({
      threadId,
      limit: TURN_PAGE_LIMIT,
      sortDirection: "asc",
      itemsView: "full",
      ...(cursor ? { cursor } : {}),
    });
    turns.push(...page.data);
    const nextCursor = page.nextCursor?.trim() || undefined;
    if (!nextCursor) {
      return turns;
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error("Codex returned a repeated thread/turns/list cursor");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

export async function resolveCodexUpstreamForkBoundary(params: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  entryId: string;
  threadId: string;
  control: CodexSessionCatalogControl;
}): Promise<CodexUpstreamForkBoundaryResult> {
  try {
    const entries = await readVisibleSessionTranscriptMessageEntries({
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    });
    const visibleUserEntries = entries.filter((entry) => entry.role === "user");
    const userMessageOrdinal = visibleUserEntries.findIndex(
      (entry) => entry.entryId === params.entryId,
    );
    const localText = localMessageText(visibleUserEntries[userMessageOrdinal]?.message.content);
    if (userMessageOrdinal < 0 || localText === undefined) {
      return failure(
        "drift-mismatch",
        "The local message could not be mapped to the Codex thread. Refresh the session and try again.",
      );
    }
    const turns = await listCodexUpstreamTurns(params.control, params.threadId);
    return resolveCodexUpstreamForkBoundaryFromTurns({
      turns,
      userMessageOrdinal,
      localText,
    });
  } catch {
    return failure(
      "upstream-unavailable",
      "The Codex thread could not be read. Check that Codex is available, then try again.",
    );
  }
}

export function precheckCodexUpstreamForkBoundary(params: {
  boundary: CodexUpstreamForkBoundary;
  turns: readonly CodexTurn[];
}): CodexUpstreamForkBoundaryResult {
  const target = params.turns.find((turn) => turn.id === params.boundary.targetTurnId);
  if (!target) {
    return failure(
      "upstream-unavailable",
      "The Codex thread changed before it could be forked. Refresh the session and try again.",
    );
  }
  if (target.status === "inProgress") {
    return failure(
      "in-progress-turn",
      "This Codex turn is still in progress. Wait for it to finish, then try forking again.",
    );
  }
  return { ok: true, boundary: params.boundary };
}
