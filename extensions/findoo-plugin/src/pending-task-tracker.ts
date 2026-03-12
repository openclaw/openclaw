/**
 * PendingTaskTracker — manages background A2A SSE streams for async analysis.
 *
 * When fin_analyze submits a long-running query, it opens an SSE stream,
 * grabs the taskId from the first event, and returns immediately.
 * The stream keeps running in background; when the final event arrives,
 * the tracker fires the completion callback to push results via heartbeat.
 *
 * Why not poll with tasks/get?
 * The LangGraph A2A server cleans up tasks once the stream ends.
 * tasks/get only works while the stream is active, so the stream itself
 * is the only reliable way to receive the final result.
 */

import type { A2AClient, A2AStreamEvent } from "./a2a-client.js";

export interface PendingTask {
  taskId: string;
  contextId?: string;
  query: string;
  threadId?: string;
  submittedAt: number;
  status: "submitted" | "working" | "completed" | "failed" | "timeout";
}

export interface TaskTrackerConfig {
  a2aClient: A2AClient;
  onTaskCompleted: (task: PendingTask, result: Record<string, unknown>) => void;
  onTaskFailed: (task: PendingTask, error: string) => void;
  timeoutMs?: number;
  log?: (level: string, msg: string) => void;
}

export class PendingTaskTracker {
  private tasks = new Map<string, PendingTask>();
  private readonly timeoutMs: number;
  private readonly a2a: A2AClient;
  private readonly onCompleted: TaskTrackerConfig["onTaskCompleted"];
  private readonly onFailed: TaskTrackerConfig["onTaskFailed"];
  private readonly log: (level: string, msg: string) => void;

  constructor(config: TaskTrackerConfig) {
    this.a2a = config.a2aClient;
    this.onCompleted = config.onTaskCompleted;
    this.onFailed = config.onTaskFailed;
    this.timeoutMs = config.timeoutMs ?? 600_000;
    this.log = config.log ?? (() => {});
  }

  /**
   * Register a task and start consuming its SSE stream in background.
   * The stream iterator should already be started (first event consumed);
   * this method takes ownership of the remaining stream.
   */
  trackStream(
    taskId: string,
    query: string,
    stream: AsyncGenerator<A2AStreamEvent>,
    opts?: { threadId?: string; contextId?: string },
  ): PendingTask {
    const task: PendingTask = {
      taskId,
      contextId: opts?.contextId,
      query,
      threadId: opts?.threadId,
      submittedAt: Date.now(),
      status: "submitted",
    };
    this.tasks.set(taskId, task);
    this.log("info", `[findoo-tracker] tracking stream for ${taskId}: "${query.slice(0, 60)}"`);

    // Consume stream in background (fire-and-forget)
    this.consumeStream(task, stream).catch((err) => {
      this.log("warn", `[findoo-tracker] stream error for ${taskId}: ${err}`);
    });

    return task;
  }

  /**
   * Submit a task for timeout tracking only (no stream).
   * Used when stream is consumed elsewhere or for testing.
   */
  submit(
    taskId: string,
    query: string,
    opts?: { threadId?: string; contextId?: string },
  ): PendingTask {
    const task: PendingTask = {
      taskId,
      contextId: opts?.contextId,
      query,
      threadId: opts?.threadId,
      submittedAt: Date.now(),
      status: "submitted",
    };
    this.tasks.set(taskId, task);
    this.log("info", `[findoo-tracker] submitted task ${taskId}: "${query.slice(0, 60)}"`);
    return task;
  }

  stop(): void {
    // Mark remaining tasks as timed out
    for (const [taskId, task] of this.tasks) {
      task.status = "timeout";
      this.tasks.delete(taskId);
    }
    this.log("info", "[findoo-tracker] stopped");
  }

  getPending(): PendingTask[] {
    return [...this.tasks.values()];
  }

  private async consumeStream(
    task: PendingTask,
    stream: AsyncGenerator<A2AStreamEvent>,
  ): Promise<void> {
    const timeoutTimer = setTimeout(() => {
      task.status = "timeout";
      this.tasks.delete(task.taskId);
      this.log("warn", `[findoo-tracker] task ${task.taskId} timed out`);
      try {
        this.onFailed(task, "Analysis timed out after " + Math.round(this.timeoutMs / 1000) + "s");
      } catch (e) {
        this.log("warn", `[findoo-tracker] onFailed callback error: ${e}`);
      }
      // Try to close the stream
      stream.return(undefined as unknown as A2AStreamEvent).catch(() => {});
    }, this.timeoutMs);

    try {
      let lastEvent: A2AStreamEvent | undefined;
      // The final event only has status metadata; the actual result text
      // accumulates in working events' status.message.parts[].text.
      // We keep the last message from working events to extract the result.
      let lastMessage: Record<string, unknown> | undefined;

      for await (const event of stream) {
        lastEvent = event;

        if (event.kind === "error") {
          clearTimeout(timeoutTimer);
          task.status = "failed";
          this.tasks.delete(task.taskId);
          const errMsg =
            (event.raw as Record<string, unknown>)?.error ??
            event.status?.message ??
            "Unknown error";
          this.log("info", `[findoo-tracker] task ${task.taskId} error`);
          this.onFailed(task, typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg));
          return;
        }

        // Track the latest message content from working events
        const msg = event.status?.message;
        if (msg && typeof msg === "object") {
          lastMessage = msg as Record<string, unknown>;
        }

        // Update status from stream events
        const state = event.status?.state;
        if (state === "working" || state === "in-progress") {
          task.status = "working";
        }

        if (event.final) {
          clearTimeout(timeoutTimer);
          task.status = "completed";
          this.tasks.delete(task.taskId);
          this.log("info", `[findoo-tracker] task ${task.taskId} completed via stream`);
          // Use lastMessage (has actual content) over final event raw (only metadata)
          const resultPayload = lastMessage ? { ...event.raw, message: lastMessage } : event.raw;
          this.onCompleted(task, resultPayload);
          return;
        }
      }

      // Stream ended without final event — treat as completion if we got events
      clearTimeout(timeoutTimer);
      if (lastEvent) {
        task.status = "completed";
        this.tasks.delete(task.taskId);
        this.log("info", `[findoo-tracker] task ${task.taskId} stream ended (no final flag)`);
        const resultPayload = lastMessage
          ? { ...lastEvent.raw, message: lastMessage }
          : lastEvent.raw;
        this.onCompleted(task, resultPayload);
      } else {
        task.status = "failed";
        this.tasks.delete(task.taskId);
        this.log("warn", `[findoo-tracker] task ${task.taskId} stream empty`);
        this.onFailed(task, "Stream ended without events");
      }
    } catch (err) {
      clearTimeout(timeoutTimer);
      task.status = "failed";
      this.tasks.delete(task.taskId);
      const msg = err instanceof Error ? err.message : String(err);
      this.log("warn", `[findoo-tracker] task ${task.taskId} stream error: ${msg}`);
      this.onFailed(task, msg);
    }
  }
}

/** Extract a summary from completed task result (max chars) */
export function extractSummary(result: Record<string, unknown>, maxLen = 2000): string {
  // Try the message field (added by tracker from last working event)
  const message = result.message as Record<string, unknown> | undefined;
  if (message) {
    const text = extractTextFromParts(message);
    if (text) return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
  }

  // Try common A2A result shapes: artifacts
  const artifacts = result.artifacts as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(artifacts) && artifacts.length > 0) {
    const parts = artifacts[0].parts as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(parts)) {
      const text = extractTextFromPartsList(parts);
      if (text) return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
    }
  }

  // Try status.message (often contains assistant reply)
  const status = result.status as Record<string, unknown> | undefined;
  const msg = status?.message as Record<string, unknown> | undefined;
  if (msg) {
    const text = extractTextFromParts(msg);
    if (text) return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
  }

  // Fallback: stringify the whole result
  const raw = JSON.stringify(result);
  return raw.length > maxLen ? raw.slice(0, maxLen) + "…" : raw;
}

/** Extract text from a message object with parts array */
function extractTextFromParts(msg: Record<string, unknown>): string | undefined {
  const parts = msg.parts as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(parts)) return undefined;
  return extractTextFromPartsList(parts) || undefined;
}

/** Extract text from a parts array (handles kind=text and kind=data with text) */
function extractTextFromPartsList(parts: Array<Record<string, unknown>>): string {
  return parts
    .filter((p) => typeof p.text === "string" && p.text.length > 0)
    .map((p) => String(p.text))
    .join("\n");
}
