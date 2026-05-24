/**
 * Notification → accumulator + event emission for the Claude app-server bridge.
 *
 * Mirrors extensions/codex/src/app-server/event-projector.ts at smaller
 * scope. Pulled out of run-attempt.ts so the turn runner stays orchestration-
 * focused (promise + idle timer + unsubscribe lifecycle) while this module
 * owns the notification shape readers, current-turn filtering, accumulator
 * mutation, native-tool AfterToolCall emission, and assistant/reasoning
 * stream emission.
 *
 * Caller flow inside runTurn:
 *
 *   const projector = new ClaudeAppServerEventProjector({...});
 *   client.onNotification((notif) => {
 *     const outcome = projector.processNotification(notif);
 *     if (outcome?.kind === "completed") resolve();
 *     else if (outcome?.kind === "failed") reject(outcome.error);
 *   });
 *   // ... await settle ...
 *   projector.finalize(); // fold deltas into acc.assistantTexts/reasoning
 */

import {
  emitAgentEvent as emitGlobalAgentEvent,
  embeddedAgentLog,
  runAgentHarnessAfterToolCallHook,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";

/**
 * Emit an agent event to BOTH the global agent-event bus (with
 * sessionKey attached, so channel renderers can scope by session) AND
 * the per-attempt `params.onAgentEvent` callback (which the
 * attempt-execution layer threads through to channel/progress
 * subscribers — e.g. Discord's "streaming.mode = progress" renderer).
 *
 * Mirrors codex's wrapper at extensions/codex/src/app-server/event-projector.ts.
 * Before this helper the bridge only emitted to the global bus and
 * channel renderers using the per-attempt callback (Discord progress
 * mode included) never saw tool/item events for claude turns.
 */
function emitProjectedAgentEvent(
  params: EmbeddedRunAttemptParams,
  event: { stream: string; data: Record<string, unknown> },
): void {
  try {
    emitGlobalAgentEvent({
      runId: params.runId,
      stream: event.stream,
      data: event.data,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    });
  } catch (error) {
    embeddedAgentLog.debug("claude-bridge: global emitAgentEvent threw", { error });
  }
  try {
    const maybePromise = params.onAgentEvent?.(event);
    void Promise.resolve(maybePromise).catch((error: unknown) => {
      embeddedAgentLog.debug("claude-bridge: per-attempt onAgentEvent rejected", { error });
    });
  } catch (error) {
    // Downstream consumers must not corrupt the canonical projection.
    embeddedAgentLog.debug("claude-bridge: per-attempt onAgentEvent threw", { error });
  }
}
import { readTurn, readTurnCompletedNotification } from "./protocol-validators.js";
import type { JsonValue, RpcNotification, Turn } from "./types.js";

export type ProjectorAccumulator = {
  assistantTexts: string[];
  toolMetas: Array<{ toolName: string; meta?: string }>;
  reasoning: string;
  itemCount: number;
  toolCalls: Map<
    string,
    {
      name: string;
      args?: unknown;
      result?: unknown;
      isError?: boolean;
      startedAt?: number;
      isDynamic?: boolean;
    }
  >;
};

export type ProjectorHookContext = {
  runId?: string;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  channelId?: string;
};

export type ProjectorOutcome =
  | { kind: "completed"; turn?: Turn }
  | { kind: "failed"; error: Error }
  | null;

export class ClaudeAppServerEventProjector {
  private readonly textParts: string[] = [];
  private readonly reasoningParts: string[] = [];
  private settled = false;

  constructor(
    private readonly turnId: string,
    private readonly acc: ProjectorAccumulator,
    private readonly params: EmbeddedRunAttemptParams,
    private readonly hookContext: ProjectorHookContext,
  ) {}

  /**
   * Returns true if the notification's turn identity matches the projector's
   * turnId. Used by callers to gate per-turn idle-timer resets, so they
   * don't reset on stray notifications belonging to a different turn on
   * the same shared client.
   */
  matchesTurn(notif: RpcNotification): boolean {
    const p = notif.params as Record<string, unknown> | undefined;
    if (!p) {
      return false;
    }
    const ntid = typeof p.turnId === "string" ? p.turnId : undefined;
    const turnObj = p.turn as { id?: string } | undefined;
    const directMatch = ntid === this.turnId;
    const nestedMatch =
      turnObj !== undefined && typeof turnObj.id === "string" && turnObj.id === this.turnId;
    return directMatch || nestedMatch;
  }

  /**
   * Dispatch one server notification. Mutates the accumulator and emits
   * downstream agent events as side effects. Returns a terminal outcome
   * (completed/failed) when the turn naturally ends; null otherwise.
   * Returns null for notifications that don't match the current turn,
   * leaving caller-side settle state untouched.
   */
  processNotification(notif: RpcNotification): ProjectorOutcome {
    if (this.settled) {
      return null;
    }
    if (!this.matchesTurn(notif)) {
      return null;
    }
    const p = notif.params as Record<string, unknown> | undefined;
    if (!p) {
      return null;
    }
    switch (notif.method) {
      case "item/started":
      case "item/completed":
        this.handleItemLifecycle(notif.method, p);
        return null;
      case "item/agentMessage/delta":
        this.handleAgentMessageDelta(p);
        return null;
      case "item/reasoning/delta":
        this.handleReasoningDelta(p);
        return null;
      case "turn/error":
        this.settled = true;
        return { kind: "failed", error: this.errorFromTurnErrorPayload(p) };
      case "turn/completed":
        this.settled = true;
        return this.handleTurnCompleted(p);
      default:
        return null;
    }
  }

  /** Mark settled externally (e.g. after an idle-timeout or abort). */
  markSettled(): void {
    this.settled = true;
  }

  /** Fold streamed deltas into the accumulator. Call once after settle. */
  finalize(): void {
    if (this.textParts.length > 0) {
      this.acc.assistantTexts = [this.textParts.join("")];
    }
    if (this.reasoningParts.length > 0) {
      this.acc.reasoning = this.reasoningParts.join("");
    }
  }

  // ── internal handlers ──────────────────────────────────────────────────

  private handleItemLifecycle(
    method: "item/started" | "item/completed",
    p: Record<string, unknown>,
  ): void {
    const item = p.item as Record<string, unknown> | undefined;
    if (!item) {
      return;
    }
    if (method === "item/completed") {
      this.acc.itemCount += 1;
    }
    const isTool = isToolItem(item);
    if (method === "item/started") {
      if (isTool) {
        this.recordToolStart(item);
      } else {
        emitItemEvent(this.params, "start", item);
      }
      return;
    }
    if (isTool) {
      this.recordToolCompletion(item);
      emitToolEvent(this.params, "result", item);
    } else {
      emitItemEvent(this.params, "end", item);
    }
  }

  private recordToolStart(item: Record<string, unknown>): void {
    const toolName = extractItemName(item) ?? "unknown";
    this.acc.toolMetas.push({ toolName });
    const itemId = typeof item.id === "string" ? item.id : undefined;
    if (itemId) {
      this.acc.toolCalls.set(itemId, {
        name: toolName,
        args: item.arguments ?? item.input,
        startedAt: Date.now(),
        isDynamic: item.type === "dynamicToolCall",
      });
    }
    // Mirror codex's stream:"tool" phase:"start" emission so Discord/Slack/
    // etc. can render "🛠️ <tool> <preview>" stubs in real time instead of
    // waiting for the whole turn to finish.
    emitToolEvent(this.params, "start", item);
  }

  private recordToolCompletion(item: Record<string, unknown>): void {
    const itemId = typeof item.id === "string" ? item.id : undefined;
    if (!itemId) {
      return;
    }
    const prev = this.acc.toolCalls.get(itemId);
    // Server's makeDynamicToolCallItem emits `contentItems` (an array of
    // {type:"inputText"|"inputImage", ...}) — NOT `result`. Read whichever
    // is present so dynamic-tool output makes it into messagesSnapshot for
    // replay/provenance. Native tool items use `result`; both are accepted.
    const payload = item.contentItems ?? item.result;
    const merged = {
      ...(prev ?? { name: extractItemName(item) ?? "unknown" }),
      result: payload,
      isError: item.status === "failed" || item.error != null,
    };
    this.acc.toolCalls.set(itemId, merged);
    // Fire AfterToolCall for NATIVE tools only. Dynamic tool calls already
    // fire AfterToolCall inside dynamic-tools.ts when the openclaw bridge
    // invokes the AnyAgentTool, so firing here too would double-count.
    if (!merged.isDynamic) {
      const args =
        merged.args && typeof merged.args === "object" && !Array.isArray(merged.args)
          ? (merged.args as Record<string, unknown>)
          : {};
      void runAgentHarnessAfterToolCallHook({
        toolName: merged.name,
        toolCallId: itemId,
        runId: this.hookContext.runId,
        agentId: this.hookContext.agentId,
        sessionId: this.hookContext.sessionId,
        sessionKey: this.hookContext.sessionKey,
        channelId: this.hookContext.channelId,
        startArgs: args,
        result: payload as JsonValue,
        ...(merged.isError
          ? { error: typeof item.error === "string" ? item.error : "tool failed" }
          : {}),
        ...(merged.startedAt != null ? { startedAt: merged.startedAt } : {}),
      });
    }
  }

  private handleAgentMessageDelta(p: Record<string, unknown>): void {
    if (typeof p.delta !== "string") {
      return;
    }
    this.textParts.push(p.delta);
    // Forward token-level deltas to OpenClaw's agent-event bus so downstream
    // consumers (Discord/Slack/etc.) can stream-update their messages
    // instead of waiting for turn/completed.
    emitProjectedAgentEvent(this.params, {
      stream: "assistant",
      data: { text: this.textParts.join(""), delta: p.delta },
    });
  }

  private handleReasoningDelta(p: Record<string, unknown>): void {
    if (typeof p.delta !== "string") {
      return;
    }
    this.reasoningParts.push(p.delta);
    emitReasoningDeltaEvent(this.params, p.delta, this.reasoningParts.join(""));
  }

  private errorFromTurnErrorPayload(p: Record<string, unknown>): Error {
    const err = p.error as { message?: string } | undefined;
    return new Error(`Claude turn error: ${err?.message ?? "turn/error"}`);
  }

  private handleTurnCompleted(p: Record<string, unknown>): ProjectorOutcome {
    // readTurnCompletedNotification returns undefined for a malformed
    // payload (missing turn.id, unknown status enum). Falling through to
    // undefined preserves the prior cast-tolerant behavior without
    // committing to a value we can't trust.
    const parsedNotification = readTurnCompletedNotification(p);
    const turn: Turn | undefined =
      parsedNotification?.turn ?? readTurn((p as { turn?: unknown }).turn);
    if (turn?.status === "failed") {
      return {
        kind: "failed",
        error: new Error(`Claude turn failed: ${turn.error?.message ?? "unknown"}`),
      };
    }
    // Pick up any item text we didn't see via deltas.
    if (turn?.items) {
      for (const item of turn.items) {
        if (
          item.type === "agentMessage" &&
          this.textParts.length === 0 &&
          typeof item.text === "string"
        ) {
          this.textParts.push(item.text);
        }
      }
    }
    return { kind: "completed", turn };
  }
}

// ── pure helpers (exported for testability) ────────────────────────────────

export function isToolItem(item: Record<string, unknown>): boolean {
  return item.type === "dynamicToolCall" || item.type === "toolCall" || item.type === "mcpToolCall";
}

export function extractItemName(item: Record<string, unknown>): string | undefined {
  if (typeof item.name === "string") {
    return item.name;
  }
  if (typeof item.tool === "string") {
    return item.tool;
  }
  return undefined;
}

// ── event emission helpers (also used standalone by run-attempt) ────────────

export function emitToolEvent(
  params: EmbeddedRunAttemptParams,
  phase: "start" | "result",
  item: Record<string, unknown>,
): void {
  const toolName = extractItemName(item);
  if (!toolName) {
    return;
  }
  const itemId = typeof item.id === "string" ? item.id : undefined;
  const status = typeof item.status === "string" ? item.status : undefined;
  const args =
    item.arguments && typeof item.arguments === "object" && !Array.isArray(item.arguments)
      ? (item.arguments as Record<string, unknown>)
      : item.input && typeof item.input === "object" && !Array.isArray(item.input)
        ? (item.input as Record<string, unknown>)
        : undefined;
  const data: Record<string, unknown> = { phase, name: toolName };
  if (itemId) {
    data.itemId = itemId;
    data.toolCallId = itemId;
  }
  if (phase === "start" && args) {
    data.args = args;
  }
  if (phase === "result") {
    if (status) {
      data.status = status;
    }
    data.isError = status === "failed" || item.error != null;
    if (item.result && typeof item.result === "object" && !Array.isArray(item.result)) {
      data.result = item.result as Record<string, unknown>;
    }
  }
  emitProjectedAgentEvent(params, { stream: "tool", data });
}

export function emitItemEvent(
  params: EmbeddedRunAttemptParams,
  phase: "start" | "end",
  item: Record<string, unknown>,
): void {
  const itemId = typeof item.id === "string" ? item.id : undefined;
  const kind = typeof item.type === "string" ? item.type : undefined;
  const title = extractItemName(item) ?? kind;
  const status = typeof item.status === "string" ? item.status : undefined;
  const data: Record<string, unknown> = { phase };
  if (itemId) {
    data.itemId = itemId;
  }
  if (kind) {
    data.kind = kind;
  }
  if (title) {
    data.title = title;
  }
  if (status) {
    data.status = status;
  }
  emitProjectedAgentEvent(params, { stream: "item", data });
}

export function emitReasoningDeltaEvent(
  params: EmbeddedRunAttemptParams,
  delta: string,
  accumulated: string,
): void {
  emitProjectedAgentEvent(params, {
    stream: "reasoning",
    data: { delta, text: accumulated },
  });
}
