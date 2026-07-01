/**
 * Boundary-time validators for the Claude app-server JSON-RPC protocol.
 *
 * Mirrors extensions/codex/src/app-server/protocol-validators.ts. Codex uses
 * AJV-compiled JSON Schemas generated from the codex CLI's source; we own
 * both sides of this protocol (server lives in
 * openclaw-plugins/openclaw-claude/server), so we use zod schemas directly
 * — same fail-closed semantics, smaller blast radius, no codegen step.
 *
 * Two helper shapes per response/notification:
 *   - assertX(value): throws ClaudeAppServerProtocolError with structured
 *                     errors if validation fails. Used at request-result
 *                     boundaries where we can't proceed without a valid
 *                     payload (thread/start, turn/start).
 *   - readX(value):   returns the parsed value or undefined. Used for
 *                     notification/request inspection where the runtime
 *                     can still make progress by skipping a malformed
 *                     event (item/tool/call dispatch, error notification
 *                     enrichment).
 *
 * Schemas are intentionally lenient (passthrough on extra fields) so that
 * forward-compat server updates don't break the bridge. We validate
 * *required* fields strictly; new optional fields flow through unchecked.
 */

import { z } from "zod";
import type { DynamicToolCallParams, ThreadStartResponse, Turn, TurnStartParams } from "./types.js";

// ── error type ──────────────────────────────────────────────────────────────

export class ClaudeAppServerProtocolError extends Error {
  constructor(
    message: string,
    readonly target: string,
    readonly issues?: z.ZodIssue[],
  ) {
    super(message);
    this.name = "ClaudeAppServerProtocolError";
  }
}

// ── core protocol shapes ────────────────────────────────────────────────────

const threadSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    cwd: z.string().optional(),
    createdAt: z.number().optional(),
    updatedAt: z.number().optional(),
  })
  .passthrough();

const threadStartResponseSchema = z
  .object({
    thread: threadSchema,
    model: z.string().min(1).optional(),
    modelProvider: z.string().min(1).optional(),
    cwd: z.string().optional(),
  })
  .passthrough();

const threadResumeResponseSchema = threadStartResponseSchema;

const turnSchema = z
  .object({
    id: z.string().min(1),
    threadId: z.string().min(1).optional(),
    status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
    items: z.array(z.record(z.string(), z.unknown())).optional(),
    error: z.object({ message: z.string() }).passthrough().nullable().optional(),
  })
  .passthrough();

const turnStartResponseSchema = z
  .object({
    turn: turnSchema,
  })
  .passthrough();

const turnCompletedNotificationSchema = z
  .object({
    turn: turnSchema,
  })
  .passthrough();

const dynamicToolCallParamsSchema = z
  .object({
    callId: z.string().min(1),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    tool: z.string().min(1),
    arguments: z.unknown().optional(),
  })
  .passthrough();

const errorNotificationSchema = z
  .object({
    message: z.string(),
    code: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

const turnStartParamsSchema = z
  .object({
    threadId: z.string().min(1),
    input: z.array(z.unknown()),
    cwd: z.string().optional(),
    model: z.string().optional(),
    effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
    fastMode: z.boolean().optional(),
  })
  .passthrough();

// ── assertX: throws on invalid input ────────────────────────────────────────

function assertShape<T>(schema: z.ZodType<T>, value: unknown, target: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new ClaudeAppServerProtocolError(
      `Invalid ${target} payload from claude-bridge: ${summary}`,
      target,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export function assertThreadStartResponse(value: unknown): ThreadStartResponse {
  return assertShape(threadStartResponseSchema, value, "thread/start") as ThreadStartResponse;
}

export function assertThreadResumeResponse(value: unknown): ThreadStartResponse {
  return assertShape(threadResumeResponseSchema, value, "thread/resume") as ThreadStartResponse;
}

export function assertTurnStartResponse(value: unknown): { turn: Turn } {
  return assertShape(turnStartResponseSchema, value, "turn/start") as { turn: Turn };
}

export function assertTurnStartParams(value: unknown): TurnStartParams {
  return assertShape(turnStartParamsSchema, value, "turn/start params") as TurnStartParams;
}

// ── readX: lenient, returns undefined on invalid input ──────────────────────

function readShape<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function readDynamicToolCallParams(value: unknown): DynamicToolCallParams | undefined {
  return readShape(dynamicToolCallParamsSchema, value) as DynamicToolCallParams | undefined;
}

export function readTurnCompletedNotification(value: unknown): { turn: Turn } | undefined {
  return readShape(turnCompletedNotificationSchema, value) as { turn: Turn } | undefined;
}

export function readErrorNotification(
  value: unknown,
): { message: string; code?: string | number } | undefined {
  return readShape(errorNotificationSchema, value);
}

export function readTurn(value: unknown): Turn | undefined {
  return readShape(turnSchema, value) as Turn | undefined;
}
