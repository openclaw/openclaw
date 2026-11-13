import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import type { EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import { unknownItemStatus } from "./event-projector-items.js";
import {
  readCodexNotificationThreadId,
  readCodexNotificationTurnId,
} from "./notification-correlation.js";
import {
  isJsonObject,
  type CodexTurn,
  type CodexServerNotification,
  type CodexThreadItem,
  type JsonObject,
} from "./protocol.js";

export function redactCodexEventKind(method: string): string {
  return redactSensitiveText(sanitizeTerminalText(method));
}

export class CodexProjectionDiagnostics {
  private readonly warningKeys = new Set<string>();
  private readonly liveCapture = process.env.OPENCLAW_LIVE_TEST === "1";
  private notificationCount = 0;

  constructor(
    private readonly threadId: string,
    private readonly turnId: string,
    private readonly emitLiveDiagnostic: (data: Record<string, unknown>) => void,
  ) {}

  recordNotification(notification: CodexServerNotification, params: JsonObject): void {
    if (!this.liveCapture) {
      return;
    }
    const sequence = ++this.notificationCount;
    const item = isJsonObject(params.item) ? params.item : undefined;
    const turn = isJsonObject(params.turn) ? params.turn : undefined;
    const items = item
      ? [item]
      : Array.isArray(turn?.items)
        ? turn.items.slice(-32).filter(isJsonObject)
        : [];
    const data = {
      phase: "notification",
      sequence,
      method: notification.method.slice(0, 160),
      ...(Array.isArray(turn?.items)
        ? {
            nativeItemCount: turn.items.length,
            droppedNativeItems: Math.max(0, turn.items.length - 32),
          }
        : {}),
      ...(typeof params.itemId === "string" ? { itemId: params.itemId.slice(0, 160) } : {}),
      ...(typeof params.delta === "string" ? { deltaLength: params.delta.length } : {}),
    };
    this.emitLiveDiagnostic({ ...data, threadId: this.threadId, turnId: this.turnId });
    for (const entry of items) {
      this.emitLiveDiagnostic({
        ...data,
        threadId: this.threadId,
        turnId: this.turnId,
        phase: "native_item",
        itemId: typeof entry.id === "string" ? entry.id.slice(0, 160) : undefined,
        itemType: typeof entry.type === "string" ? entry.type.slice(0, 160) : undefined,
        itemPhase: typeof entry.phase === "string" ? entry.phase.slice(0, 160) : undefined,
        status: typeof entry.status === "string" ? entry.status.slice(0, 160) : undefined,
        delivery: typeof entry.delivery === "string" ? entry.delivery.slice(0, 160) : undefined,
        textLength: typeof entry.text === "string" ? entry.text.length : undefined,
      });
    }
  }

  recordNoAnswer(
    runId: string,
    result: EmbeddedRunAttemptResult,
    turn: CodexTurn | undefined,
    finalSourceReplyDelivered: boolean,
  ): void {
    if (!this.liveCapture || result.assistantTexts.some((text) => text.trim())) {
      return;
    }
    const error = result.lastToolError;
    // A live qualification capture, not a new terminal classifier. Exclude all
    // content, free-form errors and model/auth data before crossing the Gateway.
    this.emitLiveDiagnostic({
      phase: "no_answer",
      runId,
      threadId: this.threadId,
      turnId: this.turnId,
      nativeStatus: turn?.status,
      classification: result.agentHarnessResultClassification,
      terminalKind: result.terminal.kind,
      terminalSource: result.terminal.kind === "failed" ? result.terminal.source : undefined,
      lastToolName: error?.toolName,
      lastToolErrorCode: error?.errorCode,
      executionStarted: error?.executionStarted,
      mutatingAction: error?.mutatingAction,
      timedOut: error?.timedOut,
      middlewareError: error?.middlewareError,
      toolCount: result.toolMetas.length,
      finalSourceReplyDelivered,
      startedCount: result.itemLifecycle?.startedCount,
      completedCount: result.itemLifecycle?.completedCount,
      activeCount: result.itemLifecycle?.activeCount,
    });
  }

  warnUnknownItemStatus(item: CodexThreadItem | undefined): void {
    if (!item) {
      return;
    }
    const status = unknownItemStatus(item);
    if (!status) {
      return;
    }
    const safeStatus = redactCodexEventKind(status);
    const safeItemType = redactCodexEventKind(item.type);
    this.warnOnce(
      JSON.stringify(["status", item.type, status]),
      "codex app-server item reported unknown status; continuing projection",
      {
        itemId: item.id,
        itemType: safeItemType,
        status: safeStatus,
      },
    );
  }

  warnUnknownEvent(notification: CodexServerNotification, params: JsonObject): void {
    const notificationThreadId = readCodexNotificationThreadId(params);
    const notificationTurnId = readCodexNotificationTurnId(params);
    const eventKind = redactCodexEventKind(notification.method);
    this.warnOnce(
      JSON.stringify(["method", notification.method]),
      `codex app-server projector received unknown event kind; continuing: ${eventKind}`,
      {
        eventKind,
        activeThreadId: this.threadId,
        activeTurnId: this.turnId,
        threadId: notificationThreadId,
        turnId: notificationTurnId,
        matchesActiveThread: notificationThreadId === this.threadId,
        matchesActiveTurn: notificationTurnId === this.turnId,
      },
    );
  }

  private warnOnce(key: string, message: string, context: Record<string, unknown>): void {
    if (this.warningKeys.has(key)) {
      return;
    }
    this.warningKeys.add(key);
    embeddedAgentLog.warn(message, context);
  }
}
