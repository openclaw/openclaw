/**
 * Pictorem fulfillment tools — bridges MABOS agents to the VividWalls
 * Payment Bridge internal API (localhost:3001/api/*).
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { httpRequest, textResult } from "./common.js";

const BRIDGE_PORT = process.env.PAYMENT_BRIDGE_PORT || "3001";
const BRIDGE_BASE = `http://localhost:${BRIDGE_PORT}/api`;

function bridgeHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  const token = process.env.BRIDGE_API_TOKEN;
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

function bridgeDown(data: unknown): string {
  const err = (data as { error?: string })?.error ?? "Unknown error";
  return `**Payment Bridge unreachable** (port ${BRIDGE_PORT}).\n\nError: ${err}\n\nEnsure the bridge service is running on the VPS.`;
}

export function createPictoremTools(_api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    // ── Queue List ─────────────────────────────────────────────
    {
      name: "pictorem_queue_list",
      label: "Pictorem Queue List",
      description:
        "List items in the Pictorem fulfillment queue. Filter by status and limit results.",
      parameters: Type.Object({
        status: Type.Optional(
          Type.String({
            description:
              "Filter by status: pending_fulfillment, submitted_to_pictorem, image_download_failed, automation_error, automation_partial, submission_failed, blocked_no_print_image",
          }),
        ),
        limit: Type.Optional(Type.Number({ description: "Max items to return (default 50)" })),
      }),
      async execute(_id: string, params: { status?: string; limit?: number }) {
        const qs = new URLSearchParams();
        if (params.status) qs.set("status", params.status);
        if (params.limit) qs.set("limit", String(params.limit));
        const url = `${BRIDGE_BASE}/queue${qs.toString() ? "?" + qs : ""}`;
        const { status, data } = await httpRequest(url, "GET", bridgeHeaders(), undefined, 5000);

        if (status === 0) return textResult(bridgeDown(data));
        if (status !== 200)
          return textResult(`**Error** (HTTP ${status}): ${JSON.stringify(data)}`);

        const d = data as { count: number; items: Array<Record<string, unknown>> };
        if (!d.count) return textResult("Queue is empty.");

        const lines = d.items.map((i) => {
          const num = i.shopify_order_number ?? "?";
          const st = i.status ?? "unknown";
          const title = i.product_title ?? "";
          const created = i.created_at ? String(i.created_at).slice(0, 10) : "";
          return `| #${num} | ${st} | ${title} | ${created} |`;
        });

        return textResult(
          `## Fulfillment Queue (${d.count} items)\n\n| Order | Status | Product | Date |\n|-------|--------|---------|------|\n${lines.join("\n")}`,
        );
      },
    },

    // ── Order Status ───────────────────────────────────────────
    {
      name: "pictorem_order_status",
      label: "Pictorem Order Status",
      description: "Get detailed fulfillment status for a specific Shopify order number.",
      parameters: Type.Object({
        order_number: Type.String({
          description: "Shopify order number (e.g. '1006')",
        }),
      }),
      async execute(_id: string, params: { order_number: string }) {
        const url = `${BRIDGE_BASE}/queue/${encodeURIComponent(params.order_number)}`;
        const { status, data } = await httpRequest(url, "GET", bridgeHeaders(), undefined, 5000);

        if (status === 0) return textResult(bridgeDown(data));
        if (status === 404)
          return textResult(`No fulfillment items found for order #${params.order_number}.`);
        if (status !== 200)
          return textResult(`**Error** (HTTP ${status}): ${JSON.stringify(data)}`);

        const d = data as {
          order_number: string;
          count: number;
          items: Array<Record<string, unknown>>;
        };

        const sections = d.items.map((i) => {
          const lines = [
            `### ${i.product_title ?? "Unknown Product"}`,
            `- **Status:** ${i.status}`,
            `- **Variant:** ${i.variant ?? "N/A"}`,
            `- **Size:** ${i.width}x${i.height}`,
            `- **Created:** ${i.created_at}`,
          ];
          if (i.pictorem_details) lines.push(`- **Details:** ${i.pictorem_details}`);
          if (i.retry_count) lines.push(`- **Retries:** ${i.retry_count}`);
          if (i.retried_at) lines.push(`- **Last Retry:** ${i.retried_at}`);
          return lines.join("\n");
        });

        return textResult(
          `## Order #${d.order_number} — ${d.count} item(s)\n\n${sections.join("\n\n")}`,
        );
      },
    },

    // ── Retry Fulfillment ──────────────────────────────────────
    {
      name: "pictorem_retry_fulfillment",
      label: "Pictorem Retry Fulfillment",
      description:
        "Retry failed fulfillment items for a specific order. Only retryable statuses: image_download_failed, automation_error, automation_partial, submission_failed.",
      parameters: Type.Object({
        order_number: Type.String({
          description: "Shopify order number to retry",
        }),
      }),
      async execute(_id: string, params: { order_number: string }) {
        const url = `${BRIDGE_BASE}/queue/${encodeURIComponent(params.order_number)}/retry`;
        const { status, data } = await httpRequest(url, "POST", bridgeHeaders(), {}, 15000);

        if (status === 0) return textResult(bridgeDown(data));
        if (status === 404)
          return textResult(`No fulfillment items found for order #${params.order_number}.`);
        if (status !== 200)
          return textResult(`**Error** (HTTP ${status}): ${JSON.stringify(data)}`);

        const d = data as {
          order_number: string;
          retried: Array<{ file: string; retry_count: number }>;
          skipped: Array<{ file: string; status: string; reason: string }>;
        };

        const lines: string[] = [`## Retry Results — Order #${d.order_number}`, ""];

        if (d.retried.length) {
          lines.push(`### Retried (${d.retried.length})`);
          for (const r of d.retried) {
            lines.push(`- ${r.file} — retry #${r.retry_count}`);
          }
        }

        if (d.skipped.length) {
          lines.push("", `### Skipped (${d.skipped.length})`);
          for (const s of d.skipped) {
            lines.push(`- ${s.file} — status: ${s.status} (${s.reason})`);
          }
        }

        if (!d.retried.length && !d.skipped.length) {
          lines.push("No items found for this order.");
        }

        return textResult(lines.join("\n"));
      },
    },

    // ── Pipeline Stats ─────────────────────────────────────────
    {
      name: "pictorem_pipeline_stats",
      label: "Pictorem Pipeline Stats",
      description:
        "Get pipeline dashboard: item counts by status, error rate, 7-day activity, and uptime.",
      parameters: Type.Object({}),
      async execute() {
        const { status, data } = await httpRequest(
          `${BRIDGE_BASE}/stats`,
          "GET",
          bridgeHeaders(),
          undefined,
          5000,
        );

        if (status === 0) return textResult(bridgeDown(data));
        if (status !== 200)
          return textResult(`**Error** (HTTP ${status}): ${JSON.stringify(data)}`);

        const d = data as {
          total: number;
          by_status: Record<string, number>;
          error_count: number;
          error_rate: number;
          recent_7d: number;
          uptime: number;
          mode: string;
        };

        const statusLines = Object.entries(d.by_status)
          .sort(([, a], [, b]) => b - a)
          .map(([s, n]) => `| ${s} | ${n} |`);

        const uptimeH = Math.floor(d.uptime / 3600);
        const uptimeM = Math.floor((d.uptime % 3600) / 60);

        return textResult(
          [
            `## Fulfillment Pipeline Dashboard`,
            "",
            `| Metric | Value |`,
            `|--------|-------|`,
            `| Total Items | ${d.total} |`,
            `| Error Count | ${d.error_count} |`,
            `| Error Rate | ${(d.error_rate * 100).toFixed(1)}% |`,
            `| Last 7 Days | ${d.recent_7d} |`,
            `| Bridge Uptime | ${uptimeH}h ${uptimeM}m |`,
            `| Mode | ${d.mode} |`,
            "",
            `### Status Breakdown`,
            "",
            `| Status | Count |`,
            `|--------|-------|`,
            ...statusLines,
          ].join("\n"),
        );
      },
    },

    // ── Trigger Fulfillment ────────────────────────────────────
    {
      name: "pictorem_trigger_fulfillment",
      label: "Pictorem Trigger Fulfillment",
      description:
        "Manually trigger fulfillment for a Shopify order. Fetches the order from Shopify and runs the full pipeline (image download, Pictorem submission, payment).",
      parameters: Type.Object({
        order_number: Type.String({
          description: "Shopify order number to fulfill (e.g. '1006')",
        }),
      }),
      async execute(_id: string, params: { order_number: string }) {
        const url = `${BRIDGE_BASE}/fulfillment/trigger`;
        const { status, data } = await httpRequest(
          url,
          "POST",
          bridgeHeaders(),
          { order_number: params.order_number },
          30000,
        );

        if (status === 0) return textResult(bridgeDown(data));
        if (status === 400)
          return textResult(
            `**Bad request:** ${(data as { error?: string })?.error ?? "order_number required"}`,
          );
        if (status === 404)
          return textResult(`Order #${params.order_number} not found in Shopify.`);
        if (status !== 200)
          return textResult(`**Error** (HTTP ${status}): ${JSON.stringify(data)}`);

        const d = data as {
          success: boolean;
          order_number: string;
          order_id: number;
          message: string;
        };

        return textResult(
          `Fulfillment triggered for order **#${d.order_number}** (Shopify ID: ${d.order_id}).\n\nThe pipeline is running asynchronously. Use \`pictorem_order_status\` to check progress.`,
        );
      },
    },
  ];
}
