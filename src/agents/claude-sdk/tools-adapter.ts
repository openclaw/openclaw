// Tool-dispatch bridge from OpenClaw's tool policy pipeline to the
// Claude Agent SDK.
//
// Design notes:
//   * The SDK accepts two kinds of tool sources:
//       1. Built-in tools (Bash, Read, Edit, Grep, ...) enabled via the
//          `tools` option on `query()`. We enable the full preset because
//          OpenClaw's agent workspace already expects these to be
//          available.
//       2. Custom in-process tools via `createSdkMcpServer()` plus
//          `options.mcpServers`. This is where OpenClaw-specific tools
//          (message, sessions.send, cron.add, plugin-contributed tools)
//          attach.
//   * Permission gating — OpenClaw's tool policy pipeline (owner-only,
//     subagent scope, model-provider collision checks) is expressed via
//     `options.canUseTool`. We translate the pipeline's allow/deny
//     decision into the SDK's `PermissionResult` shape.
//
// Phase 2 scope: the shape of the adapter is here, but the wiring into
// OpenClaw's `createOpenClawCodingTools()` (at `src/agents/pi-tools.ts`)
// is intentionally narrow. Plugin-contributed tools that are already
// exposed as MCP servers flow through `buildMcpServersConfig()` below;
// OpenClaw-native tools (message, sessions.send) are surfaced via the
// permission gate so the model can request them and OpenClaw's existing
// handlers take over. A deeper integration — converting every OpenClaw
// tool into an `SdkMcpToolDefinition` — is a follow-up and is not on
// the Phase 2 scope.

import type { CanUseTool, McpServerConfig, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

export type OpenClawToolPolicyDecision =
  | { kind: "allow"; reason?: string }
  | { kind: "deny"; message: string };

/**
 * Callback OpenClaw supplies to this module. Typically wraps
 * `resolveAgentToolPolicy()` + any per-session gates (sandbox root,
 * workspace-only, elevated token checks). Keeping the signature narrow
 * so we don't re-implement the pipeline here.
 */
export type OpenClawToolPolicyGate = (params: {
  toolName: string;
  input: Record<string, unknown>;
}) => Promise<OpenClawToolPolicyDecision> | OpenClawToolPolicyDecision;

export type BuildCanUseToolParams = {
  gate: OpenClawToolPolicyGate;
};

/**
 * Build the SDK's `canUseTool` callback from an OpenClaw policy gate.
 *
 * Returns `allow` on gate-allow, `deny` with the gate's message on
 * gate-deny. We never return `interrupt` — OpenClaw's policy model
 * treats deny as final within a run, and the caller controls abort via
 * the `abortSignal` plumbed through `RunClaudeSdkAgentOptions`.
 */
export function buildCanUseTool(params: BuildCanUseToolParams): CanUseTool {
  const { gate } = params;
  return async (toolName, input) => {
    const decision = await gate({ toolName, input });
    if (decision.kind === "allow") {
      const result: PermissionResult = {
        behavior: "allow",
        updatedInput: input,
      };
      return result;
    }
    const result: PermissionResult = {
      behavior: "deny",
      message: decision.message,
      interrupt: false,
    };
    return result;
  };
}

/**
 * Merge OpenClaw's plugin-contributed MCP servers with any SDK-native
 * server definitions provided by the caller. Deterministic key ordering
 * matters here for prompt-cache stability (AGENTS.md) — we sort by name.
 */
export type BuildMcpServersConfigParams = {
  /**
   * OpenClaw's plugin-contributed MCP servers, keyed by the same names
   * OpenClaw uses in `.mcp.json`. Passed through verbatim.
   */
  openclawMcp: Record<string, McpServerConfig>;
  /** Additional SDK-native servers the caller assembled. */
  sdkNative?: Record<string, McpServerConfig>;
};

export function buildMcpServersConfig(
  params: BuildMcpServersConfigParams,
): Record<string, McpServerConfig> {
  const merged: Record<string, McpServerConfig> = {};
  const keys = [...Object.keys(params.openclawMcp), ...Object.keys(params.sdkNative ?? {})];
  // Sort + dedupe. First occurrence wins — OpenClaw's own servers take
  // precedence over sdkNative when names collide (callers can rename the
  // SDK-native server to avoid overlap).
  const seen = new Set<string>();
  for (const key of keys.toSorted((a, b) => a.localeCompare(b))) {
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const server =
      params.openclawMcp[key] ?? (params.sdkNative ? params.sdkNative[key] : undefined);
    if (server) {
      merged[key] = server;
    }
  }
  return merged;
}

/**
 * Default built-in tool preset for OpenClaw-driven SDK sessions.
 *
 * We use the full Claude Code preset because OpenClaw's agent workspace
 * already assumes Bash/Read/Edit/Grep/Glob are available. Plugins that
 * want to restrict the set should pass their own `tools` array through
 * `RunClaudeSdkAgentOptions` once Phase 2 exposes that knob. Today we
 * don't expose it — narrow surface, fewer footguns.
 */
export const DEFAULT_SDK_TOOL_PRESET = { type: "preset", preset: "claude_code" } as const;
