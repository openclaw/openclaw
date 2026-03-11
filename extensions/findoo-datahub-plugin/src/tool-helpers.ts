import { Type } from "@sinclair/typebox";
import type { TObject } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { DataHubClient } from "./datahub-client.js";

/* ---------- response helper ---------- */

export const json = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

/* ---------- param builder ---------- */

/** Build query params from user-facing tool params, forwarding all non-empty string/number values. */
export function buildParams(params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (k === "endpoint" || k === "indicator") continue; // routing keys, not query params
    if (v == null || v === "") continue;
    out[k] = String(v);
  }
  return out;
}

/* ---------- tool factory ---------- */

export type CategoryToolDef = {
  name: string;
  label: string;
  description: string;
  parameters: TObject;
  category: string;
  clientMethod: (
    client: DataHubClient,
    endpoint: string,
    qp: Record<string, string>,
  ) => Promise<unknown[]>;
  defaultEndpoint: string;
  /** Optional pre-execute hook to transform params before calling client. */
  transformParams?: (endpoint: string, qp: Record<string, string>) => void;
};

/**
 * Register a standard DataHub category tool.
 * Covers the common pattern: parse endpoint + buildParams → client call → json response.
 */
export function registerCategoryTool(
  api: OpenClawPluginApi,
  client: DataHubClient,
  def: CategoryToolDef,
) {
  api.registerTool(
    {
      name: def.name,
      label: def.label,
      description: def.description,
      parameters: def.parameters,
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const endpoint = String(params.endpoint ?? def.defaultEndpoint);
          const qp = buildParams(params);
          def.transformParams?.(endpoint, qp);
          const results = await def.clientMethod(client, endpoint, qp);
          return json({
            success: true,
            endpoint: `${def.category}/${endpoint}`,
            count: results.length,
            results,
          });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { names: [def.name] },
  );
}

/* ---------- shared parameter fragments ---------- */

export const dateRangeParams = {
  start_date: Type.Optional(Type.String({ description: "Start date, e.g. 2025-01-01" })),
  end_date: Type.Optional(Type.String({ description: "End date, e.g. 2025-12-31" })),
  limit: Type.Optional(Type.Number({ description: "Max records to return" })),
};

export const symbolParam = Type.String({ description: "Stock/index/fund code" });
export const optionalSymbol = Type.Optional(Type.String({ description: "Symbol (optional)" }));
