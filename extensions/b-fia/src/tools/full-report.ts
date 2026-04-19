/**
 * bfia_full_report: Full analysis with channel-specific formatting.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callBfiaBackend } from "../client.js";

function optionalStringEnum<const T extends readonly string[]>(
  values: T,
  options: { description?: string } = {},
) {
  return Type.Optional(
    Type.Unsafe<T[number]>({
      type: "string",
      enum: [...values],
      ...options,
    }),
  );
}

const Schema = Type.Object(
  {
    symbol: Type.String({ description: "Stock ticker symbol, e.g. NVDA" }),
    period: Type.Optional(Type.String({ description: 'Lookback period (default: "1y")' })),
    channel: optionalStringEnum(["slack", "line"] as const, {
      description:
        'Target channel for formatting: "slack" (Block Kit) or "line" (Flex Message). Omit for raw JSON.',
    }),
  },
  { additionalProperties: false },
);

export function createFullReportTool(api: OpenClawPluginApi) {
  return {
    name: "bfia_full_report",
    label: "B-FIA Full Report",
    description:
      "Generate a complete stock analysis report formatted for Slack (rich Block Kit) or LINE (mobile-friendly Flex Message). Combines market data, sentiment, and trade signals with divergence warnings.",
    parameters: Schema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const symbol = readStringParam(rawParams, "symbol", { required: true });
      const period = readStringParam(rawParams, "period") || "1y";
      const channel = readStringParam(rawParams, "channel") || "";

      return jsonResult(
        await callBfiaBackend("/api/v1/report", { symbol, period, channel }, api.config),
      );
    },
  };
}
