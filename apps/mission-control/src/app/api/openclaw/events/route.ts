import { NextRequest } from "next/server";
import { getOpenClawClient } from "@/lib/openclaw-client";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface GatewayStreamPayload {
  type: "status" | "gateway_event" | "ping";
  event?: string;
  payload?: unknown;
  seq?: number;
  ts: string;
}

const REDACTED_VALUE = "[redacted]";
const TRUNCATED_VALUE = "[truncated]";
const MAX_EVENT_ARRAY = 32;
const MAX_EVENT_DEPTH = 5;
const MAX_EVENT_OBJECT_KEYS = 48;
const SENSITIVE_KEY_PATTERN =
  /(token|secret|password|apikey|api_key|authorization|auth|signature|private|sessionfile|workspace|path|prompt)/i;

function sanitizeEventPayload(value: unknown, depth = 0): unknown {
  if (value == null) {return value;}
  if (depth >= MAX_EVENT_DEPTH) {return TRUNCATED_VALUE;}

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, MAX_EVENT_ARRAY).map((entry) =>
      sanitizeEventPayload(entry, depth + 1)
    );
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};

    let processed = 0;
    for (const [key, entry] of Object.entries(obj)) {
      processed += 1;
      if (processed > MAX_EVENT_OBJECT_KEYS) {
        sanitized._truncated = true;
        break;
      }
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        sanitized[key] = REDACTED_VALUE;
        continue;
      }
      sanitized[key] = sanitizeEventPayload(entry, depth + 1);
    }
    return sanitized;
  }

  return String(value);
}

function toBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function toNum(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function toStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function summarizeHealthPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") {
    return { ok: false };
  }

  const source = payload as Record<string, unknown>;
  const channelsSource =
    source.channels && typeof source.channels === "object"
      ? (source.channels as Record<string, unknown>)
      : {};

  const channels: Record<string, Record<string, boolean | undefined>> = {};
  for (const [name, raw] of Object.entries(channelsSource)) {
    if (!raw || typeof raw !== "object") {continue;}
    const entry = raw as Record<string, unknown>;
    channels[name] = {
      configured: toBool(entry.configured),
      running: toBool(entry.running),
      connected: toBool(entry.connected),
      linked: toBool(entry.linked),
    };
  }

  const agents = Array.isArray(source.agents) ? source.agents : [];
  const sessionCount =
    source.sessions && typeof source.sessions === "object"
      ? toNum((source.sessions as Record<string, unknown>).count)
      : undefined;

  return {
    ok: toBool(source.ok) ?? false,
    ts: source.ts ?? null,
    durationMs: toNum(source.durationMs) ?? null,
    defaultAgentId: toStr(source.defaultAgentId) ?? null,
    heartbeatSeconds: toNum(source.heartbeatSeconds) ?? null,
    channelCount: Object.keys(channels).length,
    channels,
    agentCount: agents.length,
    sessionCount: sessionCount ?? null,
  };
}

function shapeEventPayload(eventName: string, payload: unknown): unknown {
  if (eventName.toLowerCase().startsWith("health")) {
    return summarizeHealthPayload(payload);
  }
  return sanitizeEventPayload(payload);
}

function encodeSse(payload: GatewayStreamPayload): Uint8Array {
  const text = `data: ${JSON.stringify(payload)}\n\n`;
  return new TextEncoder().encode(text);
}

export const GET = withApiGuard(async (request: NextRequest) => {
  void request;
  const client = getOpenClawClient();

  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const safeEnqueue = (payload: GatewayStreamPayload) => {
        if (closed) {return;}
        try {
          controller.enqueue(encodeSse(payload));
        } catch {
          closed = true;
        }
      };

      // Connect asynchronously so we don't block the SSE response headers
      const isAlreadyConnected = client.isConnected();
      safeEnqueue({
        type: "status",
        payload: { connected: isAlreadyConnected },
        ts: new Date().toISOString(),
      });

      if (!isAlreadyConnected) {
        client.connect().then(() => {
          safeEnqueue({
            type: "status",
            payload: { connected: true },
            ts: new Date().toISOString(),
          });
        }).catch(() => {
          // Gateway unavailable — status updates will flow via the heartbeat
        });
      }

      const unsubscribe = client.onEvent("*", (data) => {
        const frame = data as { event?: string; payload?: unknown; seq?: number };
        const eventName = frame?.event || "unknown";
        safeEnqueue({
          type: "gateway_event",
          event: eventName,
          payload: shapeEventPayload(eventName, frame?.payload),
          seq: frame?.seq,
          ts: new Date().toISOString(),
        });
      });

      let lastConnectedState = true;

      const heartbeat = setInterval(() => {
        const nowConnected = client.isConnected();

        // Notify the browser when gateway connection state changes
        if (nowConnected !== lastConnectedState) {
          lastConnectedState = nowConnected;
          safeEnqueue({
            type: "status",
            payload: { connected: nowConnected },
            ts: new Date().toISOString(),
          });
        }

        safeEnqueue({
          type: "ping",
          ts: new Date().toISOString(),
        });
      }, 15_000);

      cleanup = () => {
        if (closed) {return;}
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Ignore close errors when stream already ended.
        }
      };
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}, ApiGuardPresets.read);
