/**
 * Hub Plugin — Notification tool for agents, crons, and apps.
 *
 * Registers three tools:
 *   hub_notify  — Send a notification (POST /notify)
 *   hub_pending — List unhandled notifications (GET /pending)
 *   hub_done    — Mark a notification as handled (POST /done/{id})
 *
 * Requires the hub server running: python3 server.py
 */

import http from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 10020;

function resolveHubUrl(pluginConfig?: Record<string, unknown>): string {
  const host = (pluginConfig?.host as string) || DEFAULT_HOST;
  const port = (pluginConfig?.port as number) || DEFAULT_PORT;
  return `http://${host}:${port}`;
}

function httpRequest(
  url: string,
  method: string,
  body?: string,
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method,
      headers: body
        ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
        : undefined,
      timeout: 15_000,
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => (data += chunk.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, data }));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Hub request timed out"));
    });
    if (body) req.write(body);
    req.end();
  });
}

export default {
  id: "hub",
  name: "Notification Hub",
  description: "Send and manage notifications via the Hub.",

  register(api: OpenClawPluginApi) {
    const baseUrl = resolveHubUrl(api.pluginConfig);

    // ── hub_notify ──────────────────────────────────────────────
    api.registerTool({
      name: "hub_notify",
      label: "Hub Notify",
      description: [
        "Send a notification through the Hub.",
        "The hub stores it, wakes the main agent, and the agent forwards to the user via the configured channel.",
        "Use this from crons, sub-agents, or any automation that needs to reach the user.",
        "",
        "Priority levels:",
        "  urgent — Immediate attention (server down, security alert)",
        "  high   — Important but not critical",
        "  normal — Standard notification (default)",
        "  low    — FYI, no action needed",
      ].join("\n"),
      parameters: {
        type: "object" as const,
        required: ["message"],
        properties: {
          message: {
            type: "string",
            description: "The notification content",
          },
          source: {
            type: "string",
            description:
              "Who is sending this (e.g. 'daily-digest', 'health-check', your agent name)",
          },
          title: {
            type: "string",
            description: "Short title for the notification",
          },
          priority: {
            type: "string",
            enum: ["urgent", "high", "normal", "low"],
            description: "Notification priority (default: normal)",
          },
        },
      },
      async execute(_toolCallId: string, args: Record<string, unknown>) {
        const body = JSON.stringify({
          source: args.source ?? "agent",
          title: args.title ?? "",
          message: args.message,
          priority: args.priority ?? "normal",
        });
        try {
          const res = await httpRequest(`${baseUrl}/notify`, "POST", body);
          return JSON.parse(res.data);
        } catch (err: unknown) {
          return { error: `Hub unreachable: ${(err as Error).message}. Is server.py running?` };
        }
      },
    });

    // ── hub_pending ─────────────────────────────────────────────
    api.registerTool({
      name: "hub_pending",
      label: "Hub Pending",
      description:
        "List all unhandled notifications from the Hub. Use this to check if there are notifications waiting to be processed.",
      parameters: {
        type: "object" as const,
        properties: {},
      },
      async execute() {
        try {
          const res = await httpRequest(`${baseUrl}/pending`, "GET");
          return JSON.parse(res.data);
        } catch (err: unknown) {
          return { error: `Hub unreachable: ${(err as Error).message}. Is server.py running?` };
        }
      },
    });

    // ── hub_done ────────────────────────────────────────────────
    api.registerTool({
      name: "hub_done",
      label: "Hub Done",
      description:
        "Mark a hub notification as handled. Call this after you've forwarded or acted on a notification.",
      parameters: {
        type: "object" as const,
        required: ["id"],
        properties: {
          id: {
            type: "number",
            description: "The notification ID to mark as done",
          },
          response: {
            type: "string",
            description: "What you did about it (optional)",
          },
        },
      },
      async execute(_toolCallId: string, args: Record<string, unknown>) {
        const body = JSON.stringify({ response: args.response ?? "" });
        try {
          const res = await httpRequest(`${baseUrl}/done/${args.id}`, "POST", body);
          return JSON.parse(res.data);
        } catch (err: unknown) {
          return { error: `Hub unreachable: ${(err as Error).message}. Is server.py running?` };
        }
      },
    });

    api.logger.info(
      `Hub plugin registered — tools: hub_notify, hub_pending, hub_done (${baseUrl})`,
    );
  },
};
