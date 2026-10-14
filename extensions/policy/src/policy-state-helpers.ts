import { asNonArrayRecord, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getPolicyPath } from "./policy-value.js";

export function ocPathSegment(value: string): string {
  if (/^(?:[A-Za-z0-9_-]+|#\d+)$/.test(value)) {
    return value;
  }
  if (value.includes('"') || value.includes("\\")) {
    return value;
  }
  return `"${value}"`;
}

export function readBooleanPath(value: unknown, path: readonly string[]): boolean | undefined {
  const current = getPolicyPath(value, path);
  return typeof current === "boolean" ? current : undefined;
}

export function collectPolicyConfiguredAgents(agents: Record<string, unknown>) {
  const entries = agents.entries;
  if (Object.hasOwn(agents, "entries") && entries !== undefined) {
    return isRecord(entries)
      ? Object.entries(entries)
          .toSorted(([a], [b]) => a.localeCompare(b))
          .map(([agentId, value]) => ({
            agentId,
            sourceBase: `oc://openclaw.config/agents/entries/${ocPathSegment(agentId)}`,
            value,
          }))
      : [];
  }
  return Array.isArray(agents.list)
    ? agents.list.map((value, index) => ({
        agentId:
          isRecord(value) && typeof value.id === "string" && value.id.trim() !== ""
            ? value.id.trim()
            : `agent-${index}`,
        sourceBase: `oc://openclaw.config/agents/list/#${index}`,
        value,
      }))
    : [];
}

export type PolicyAgentContext<Scope extends "defaults" | "global"> = {
  readonly id: string;
  readonly scope: Scope | "agent";
  readonly agentId?: string;
  readonly sandbox: Record<string, unknown>;
  readonly inheritedSandbox: Record<string, unknown>;
  readonly tools: Record<string, unknown>;
  readonly inheritedTools: Record<string, unknown>;
  readonly workspaceSourceBase: string;
  readonly toolsSourceBase: string;
};

export function collectPolicyAgentContexts<Scope extends "defaults" | "global">(
  cfg: Record<string, unknown>,
  scope: Scope,
): readonly PolicyAgentContext<Scope>[] {
  const agents = asNonArrayRecord(cfg.agents);
  const sandbox = asNonArrayRecord(asNonArrayRecord(agents.defaults).sandbox);
  const tools = asNonArrayRecord(cfg.tools);
  return [
    {
      id: scope === "global" ? "tools" : "agents-defaults",
      scope,
      sandbox,
      inheritedSandbox: {},
      tools,
      inheritedTools: {},
      workspaceSourceBase: "oc://openclaw.config/agents/defaults",
      toolsSourceBase: "oc://openclaw.config/tools",
    },
    ...collectPolicyConfiguredAgents(agents).flatMap(({ agentId, sourceBase, value }) =>
      isRecord(value)
        ? [
            {
              id: agentId,
              scope: "agent" as const,
              agentId,
              sandbox: asNonArrayRecord(value.sandbox),
              inheritedSandbox: sandbox,
              tools: asNonArrayRecord(value.tools),
              inheritedTools: tools,
              workspaceSourceBase: sourceBase,
              toolsSourceBase: `${sourceBase}/tools`,
            },
          ]
        : [],
    ),
  ];
}

export function resolvePolicyValue<T extends string | boolean>(
  local: T | undefined,
  inherited: T | undefined,
  fallback: T,
) {
  return {
    value: local ?? inherited ?? fallback,
    explicit: local !== undefined || inherited !== undefined,
    inherited: local === undefined && inherited !== undefined,
  };
}
