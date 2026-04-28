import type { OpenClawConfig } from "../config/config.js";

export type SubagentModelRoute = {
  /** JavaScript regex (string). Example: "\\bdeploy\\b" */
  pattern: string;
  /** Model ref, e.g. "anthropic/claude-opus-4-6" */
  model: string;
  /** Optional human label for debugging. */
  label?: string;
};

export type SubagentModelRouteResult = {
  model?: string;
  matched?: {
    pattern: string;
    label?: string;
  };
  warning?: string;
};

function readRoutes(cfg: OpenClawConfig | undefined): SubagentModelRoute[] {
  const agents = (cfg as { agents?: unknown } | undefined)?.agents;
  const defaults =
    agents && typeof agents === "object" ? (agents as { defaults?: unknown }).defaults : undefined;
  const subagents =
    defaults && typeof defaults === "object"
      ? (defaults as { subagents?: unknown }).subagents
      : undefined;
  const raw =
    subagents && typeof subagents === "object"
      ? (subagents as { modelRoutes?: unknown }).modelRoutes
      : undefined;
  if (!Array.isArray(raw)) {
    return [];
  }
  const routes: SubagentModelRoute[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const pattern = typeof item.pattern === "string" ? item.pattern : "";
    const model = typeof item.model === "string" ? item.model : "";
    const label = typeof item.label === "string" ? item.label : undefined;
    if (!pattern.trim() || !model.trim()) {
      continue;
    }
    routes.push({ pattern, model, label });
  }
  return routes;
}

export function routeSubagentModel(params: {
  cfg: OpenClawConfig;
  task: string;
}): SubagentModelRouteResult {
  const task = params.task ?? "";
  const routes = readRoutes(params.cfg);
  let warning: string | undefined;
  for (const route of routes) {
    try {
      const re = new RegExp(route.pattern, "i");
      if (!re.test(task)) {
        continue;
      }
      return {
        model: route.model,
        matched: { pattern: route.pattern, label: route.label },
        ...(warning ? { warning } : {}),
      };
    } catch (err) {
      // Continue evaluating later routes instead of aborting all routing.
      warning ??= `Invalid subagent model route regex: ${
        err instanceof Error ? err.message : String(err)
      }`;
      continue;
    }
  }
  return warning ? { warning } : {};
}
