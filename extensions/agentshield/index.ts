import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

/**
 * Feature gate: entirely disabled unless AGENTSHIELD_APPROVALS_ENABLED=1.
 */
function isEnabled(): boolean {
  return process.env.AGENTSHIELD_APPROVALS_ENABLED === "1";
}

/**
 * Resolve the AgentShield operating mode.
 *
 * - "all"       — every tool call requires approval (default when enabled).
 * - "selective" — only tool calls that match AGENTSHIELD_TOOLS require approval.
 */
function resolveMode(): "all" | "selective" {
  const raw = process.env.AGENTSHIELD_MODE?.trim().toLowerCase();
  return raw === "selective" ? "selective" : "all";
}

/**
 * Parse the optional AGENTSHIELD_TOOLS allow-list.
 * Comma-separated, case-insensitive, trimmed.  Empty means "all tools".
 */
function resolveToolFilter(): Set<string> | null {
  const raw = process.env.AGENTSHIELD_TOOLS?.trim();
  if (!raw) {
    return null;
  }
  return new Set(
    raw
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
}

const agentshieldPlugin = {
  id: "agentshield",
  name: "AgentShield",
  description: "Approval gate for tool calls via the before_tool_call hook",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    if (!isEnabled()) {
      api.logger.info("AgentShield approvals disabled (AGENTSHIELD_APPROVALS_ENABLED != 1)");
      return;
    }

    const mode = resolveMode();
    const toolFilter = mode === "selective" ? resolveToolFilter() : null;
    const url = process.env.AGENTSHIELD_URL?.trim() || null;

    api.logger.info(
      `AgentShield approvals enabled — mode=${mode}${url ? ` url=${url}` : ""}${
        toolFilter ? ` tools=${[...toolFilter].join(",")}` : ""
      }`,
    );

    api.on(
      "before_tool_call",
      async (event, _ctx) => {
        const toolName = event.toolName;

        // In selective mode, skip tools that are not in the filter list.
        if (mode === "selective" && toolFilter && !toolFilter.has(toolName.toLowerCase())) {
          return undefined;
        }

        // If an external trust server URL is configured, call it.
        if (url) {
          try {
            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                toolName,
                params: event.params,
              }),
              signal: AbortSignal.timeout(5000),
            });

            if (!res.ok) {
              return {
                block: true,
                blockReason: `AgentShield trust server returned ${res.status}`,
              };
            }

            const body = (await res.json()) as Record<string, unknown>;
            const action = typeof body.action === "string" ? body.action : "allow";

            if (action === "block" || action === "deny") {
              return {
                block: true,
                blockReason:
                  typeof body.reason === "string" ? body.reason : "Blocked by AgentShield",
              };
            }

            if (action === "needs_approval" || action === "needs-approval") {
              return {
                needsApproval: true,
                approvalReason:
                  typeof body.reason === "string"
                    ? body.reason
                    : `Tool "${toolName}" requires AgentShield approval`,
              };
            }

            // action === "allow" or anything else — proceed
            return undefined;
          } catch (err) {
            // Trust server unreachable: fail-closed.
            return {
              block: true,
              blockReason: `AgentShield trust server error: ${String(err)}`,
            };
          }
        }

        // No external URL — operate in local-only approval mode.
        return {
          needsApproval: true,
          approvalReason: `Tool "${toolName}" requires AgentShield approval`,
        };
      },
      { priority: 100 },
    );
  },
};

export default agentshieldPlugin;

export const __testing = {
  isEnabled,
  resolveMode,
  resolveToolFilter,
};
