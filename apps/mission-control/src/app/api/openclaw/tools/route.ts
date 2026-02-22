import { NextRequest, NextResponse } from "next/server";
import { getOpenClawClient } from "@/lib/openclaw-client";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { apiErrorResponse, handleApiError, UserError } from "@/lib/errors";
import { parseOrThrow, toolsCallSchema } from "@/lib/schemas";

// Whitelist of allowed gateway methods for the Tools Playground
// Only safe, read-only methods are allowed. No destructive operations.
const ALLOWED_METHODS = new Set([
  // Health & Status
  "health",
  "status",

  // Sessions (read-only)
  "sessions.list",
  "sessions.preview",

  // Agents (read-only)
  "agents.list",

  // Cron (read-only)
  "cron.list",
  "cron.status",

  // Usage (read-only)
  "usage.status",
  "usage.cost",

  // Models (read-only)
  "models.list",

  // Channels (read-only)
  "channels.status",

  // Skills (read-only)
  "skills.status",

  // Nodes (read-only)
  "node.list",
  "node.describe",

  // Logs (read-only)
  "logs.tail",

  // TTS (text-to-speech)
  "tts.status",
  "tts.providers",
  "tts.convert",
]);

// Timeout wrapper for gateway calls
const TOOL_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

// Tools Playground API: invokes gateway WebSocket methods directly
// SECURITY: Only whitelisted read-only methods are allowed
export const POST = withApiGuard(async (request: NextRequest) => {
  const start = Date.now();
  try {
    const { tool, args } = parseOrThrow(toolsCallSchema, await request.json());

    // Security check: only allow whitelisted methods
    if (!ALLOWED_METHODS.has(tool)) {
      throw new UserError(
        `Method "${tool}" is not allowed. Only read-only methods are permitted in the playground.`,
        403
      );
    }

    const client = getOpenClawClient();
    await withTimeout(client.connect(), TOOL_TIMEOUT_MS, `connect(${tool})`);

    // The tool name from the playground uses dot notation matching gateway WS methods
    // e.g. "health", "agents.list", "sessions.list", "cron.list"
    const result = await withTimeout(
      client.call(tool, args || {}),
      TOOL_TIMEOUT_MS,
      tool
    );

    return NextResponse.json({ ok: true, result, durationMs: Date.now() - start });
  } catch (error) {
    if (error instanceof UserError) {
      return apiErrorResponse({
        message: error.message,
        status: error.statusCode,
        code: error.errorCode,
      });
    }
    return handleApiError(error, "Tools RPC failed");
  }
}, ApiGuardPresets.write);
