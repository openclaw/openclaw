import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi, OpenClawPluginService } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";
import { formatDigest, formatStatus } from "./src/digest.js";
import { createNotificationStore } from "./src/store.js";
import { triageBatch } from "./src/triage.js";
import type { NotificationBatch } from "./src/types.js";

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: { text },
  };
}

export default function register(api: OpenClawPluginApi) {
  const pluginConfig = (api.pluginConfig ?? {}) as Record<string, unknown>;
  const maxStored =
    typeof pluginConfig.maxStoredNotifications === "number"
      ? pluginConfig.maxStoredNotifications
      : 500;
  const retentionMin =
    typeof pluginConfig.retentionMinutes === "number" ? pluginConfig.retentionMinutes : 60;

  const store = createNotificationStore({
    maxItems: maxStored,
    retentionMs: retentionMin * 60_000,
  });

  // ── Gateway method: receive notification batches from Android nodes ───────

  api.registerGatewayMethod("notifications.batch", async ({ params, respond }) => {
    try {
      const batch = params as unknown as NotificationBatch;
      if (!batch || !Array.isArray(batch.notifications)) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "notifications array required",
        });
        return;
      }
      const triaged = triageBatch(batch.notifications);
      store.add(triaged);
      api.logger.info(
        `[notification-intelligence] batch ${batch.batchId ?? "unknown"}: ${triaged.length} notifications triaged`,
      );
      respond(true, { processed: triaged.length, batchId: batch.batchId ?? null });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      api.logger.error(`[notification-intelligence] batch error: ${message}`);
      respond(false, undefined, { code: "INTERNAL_ERROR", message });
    }
  });

  // ── Command: /notifications [digest|status|clear|help] ────────────────────

  api.registerCommand({
    name: "notifications",
    description: "AI-powered notification digest and management.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const args = ctx.args?.trim() ?? "";
      const tokens = args.split(/\s+/).filter(Boolean);
      const action = tokens[0]?.toLowerCase() ?? "digest";

      switch (action) {
        case "digest": {
          const sinceMin = Number.parseInt(tokens[1] ?? "60", 10);
          const sinceMs =
            Number.isFinite(sinceMin) && sinceMin > 0 ? sinceMin * 60_000 : 60 * 60_000;
          const digest = store.getDigest(sinceMs);
          return { text: formatDigest(digest) };
        }
        case "status": {
          return { text: formatStatus(store.stats()) };
        }
        case "clear": {
          store.clear();
          return { text: "Notification store cleared." };
        }
        default: {
          return {
            text: [
              "Notification Intelligence commands:",
              "",
              "/notifications digest [minutes]  - Show triaged digest (default: 60m)",
              "/notifications status            - Show store stats",
              "/notifications clear             - Clear stored notifications",
            ].join("\n"),
          };
        }
      }
    },
  });

  // ── Tool: notification_triage (agent can query proactively) ────────────────

  api.registerTool({
    name: "notification_triage",
    label: "Notification Triage",
    description:
      "Get a triaged summary of recent phone notifications from the connected Android device. " +
      "Returns notifications classified by urgency level (critical, important, informational, noise).",
    parameters: Type.Object({
      action: stringEnum(["digest", "recent", "critical"] as const, {
        description: "digest: full triaged summary, recent: all recent, critical: critical only",
      }),
      since_minutes: Type.Optional(
        Type.Number({ description: "Look-back window in minutes (default 60)" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const p = params as { action: string; since_minutes?: number };
      const action = typeof p.action === "string" ? p.action : "digest";
      const sinceMin =
        typeof p.since_minutes === "number" && p.since_minutes > 0 ? p.since_minutes : 60;
      const sinceMs = sinceMin * 60_000;

      switch (action) {
        case "digest": {
          const digest = store.getDigest(sinceMs);
          return textResult(formatDigest(digest));
        }
        case "recent": {
          const recent = store.getRecent(sinceMs);
          if (recent.length === 0) return textResult("No recent notifications.");
          return jsonResult({
            count: recent.length,
            notifications: recent.map((n) => ({
              level: n.triageLevel,
              app: n.appLabel || n.packageName,
              title: n.title,
              text: n.text,
            })),
          });
        }
        case "critical": {
          const critical = store.getByLevel("critical", sinceMs);
          if (critical.length === 0) return textResult("No critical notifications.");
          return jsonResult({
            count: critical.length,
            notifications: critical.map((n) => ({
              app: n.appLabel || n.packageName,
              title: n.title,
              text: n.text,
            })),
          });
        }
        default:
          return textResult("Unknown action. Use: digest, recent, or critical.");
      }
    },
  });

  // ── Background service: periodic garbage collection ────────────────────────

  let gcInterval: ReturnType<typeof setInterval> | null = null;

  const gcService: OpenClawPluginService = {
    id: "notification-intelligence-gc",
    start: async () => {
      gcInterval = setInterval(() => {
        store.gc();
      }, 60_000);
      gcInterval.unref?.();
    },
    stop: async () => {
      if (gcInterval) {
        clearInterval(gcInterval);
        gcInterval = null;
      }
    },
  };

  api.registerService(gcService);
}
