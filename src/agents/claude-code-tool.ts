import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { runSDKAgent, type SDKProgressEvent } from "./claude-sdk-integration.js";

const claudeCodeSchema = Type.Object({
  prompt: Type.String({ description: "The task or question for Claude Code" }),
  model: Type.Optional(Type.String({ description: "Model override (default: inherited)" })),
  permissionMode: Type.Optional(
    Type.Union([Type.Literal("execute"), Type.Literal("plan")], {
      description:
        "execute (default): run immediately. plan: generate plan without execution, returns sessionId for resume.",
    }),
  ),
  resume: Type.Optional(
    Type.String({
      description:
        "Session ID from a previous plan-mode call. Resumes and executes the planned work.",
    }),
  ),
});

export type ClaudeCodeToolDetails =
  | { status: "running"; phase: string; info?: string }
  | { status: "planned"; sessionId: string; summary: string }
  | { status: "completed"; durationMs: number; numTurns: number; sessionId: string };

export type ClaudeCodePermissions = {
  /** Tools to auto-allow without prompting (default: Read, Glob, Grep, Write, Edit, etc.) */
  autoAllow?: string[];
  /** Patterns to auto-deny. Format: "ToolName:command_substring" */
  autoDeny?: string[];
  /** Enable gateway approval for ambiguous operations (default: false) */
  gatewayApproval?: boolean;
  /** Timeout for gateway approval in ms (default: 120000) */
  approvalTimeoutMs?: number;
  /** Session key for gateway approval requests */
  sessionKey?: string;
};

export function createClaudeCodeTool(defaults?: {
  cwd?: string;
  model?: string;
  maxTurns?: number;
  systemPromptAppend?: string;
  env?: Record<string, string | undefined>;
  permissions?: ClaudeCodePermissions;
}): AgentTool<typeof claudeCodeSchema, ClaudeCodeToolDetails> {
  return {
    name: "claude_code",
    label: "Claude Code",
    description:
      "Execute coding tasks using Claude Code with built-in file editing, bash execution, and code analysis tools. Use this for complex coding tasks that require multiple file operations.",
    parameters: claudeCodeSchema,
    execute: async (_toolCallId, params, _signal, onUpdate) => {
      const isPlan = params.permissionMode === "plan";

      const result = await runSDKAgent({
        prompt: params.prompt,
        cwd: defaults?.cwd ?? process.cwd(),
        model: params.model ?? defaults?.model,
        maxTurns: defaults?.maxTurns,
        systemPromptAppend: defaults?.systemPromptAppend,
        env: defaults?.env,
        permissionMode: isPlan ? "plan" : "acceptEdits",
        resume: params.resume,
        canUseTool: isPlan ? undefined : buildCanUseTool(defaults?.permissions, onUpdate),
        onProgress: (evt: SDKProgressEvent) => {
          if (!onUpdate) {
            return;
          }
          let update: AgentToolResult<ClaudeCodeToolDetails>;
          switch (evt.phase) {
            case "init":
              update = {
                content: [
                  { type: "text", text: `Claude Code initialized (${evt.toolCount} tools)` },
                ],
                details: { status: "running", phase: "init", info: `model=${evt.model}` },
              };
              break;
            case "tool_progress":
              update = {
                content: [
                  {
                    type: "text",
                    text: `Running ${evt.toolName} (${evt.elapsedSeconds}s)`,
                  },
                ],
                details: { status: "running", phase: "tool", info: evt.toolName },
              };
              break;
            case "tool_use":
              update = {
                content: [{ type: "text", text: `Using: ${evt.toolNames.join(", ")}` }],
                details: {
                  status: "running",
                  phase: "tool_use",
                  info: evt.toolNames.join(", "),
                },
              };
              break;
            default:
              return;
          }
          onUpdate(update);
        },
      });

      if (isPlan) {
        const sessionInfo = result.sessionId
          ? `\n\n---\nsessionId: ${result.sessionId}\n(Use this sessionId with the "resume" parameter to execute this plan)`
          : "\n\n---\n(Warning: No sessionId returned by SDK. Resume may not be available in plan mode.)";
        return {
          content: [{ type: "text", text: `${result.text}${sessionInfo}` }],
          details: {
            status: "planned" as const,
            sessionId: result.sessionId,
            summary: result.text,
          },
        };
      }

      return {
        content: [{ type: "text", text: result.text }],
        details: {
          status: "completed" as const,
          durationMs: result.durationMs,
          numTurns: result.numTurns,
          sessionId: result.sessionId,
        },
      };
    },
  };
}

function buildCanUseTool(
  permissions: ClaudeCodePermissions | undefined,
  onUpdate: AgentToolUpdateCallback<ClaudeCodeToolDetails> | undefined,
) {
  const autoAllow = new Set(
    permissions?.autoAllow ?? ["Read", "Glob", "Grep", "Write", "Edit", "TodoRead", "TodoWrite"],
  );
  const autoDenyPatterns = permissions?.autoDeny ?? [
    "Bash:rm -rf",
    "Bash:git push --force",
    "Bash:git reset --hard",
  ];

  return async (
    toolName: string,
    input: Record<string, unknown>,
    _options: { signal: AbortSignal; toolUseID: string; decisionReason?: string },
  ): Promise<PermissionResult> => {
    // Tier 1: Rule-based auto-allow
    if (autoAllow.has(toolName)) {
      return { behavior: "allow" };
    }

    // Tier 1: Rule-based auto-deny
    const command = typeof input.command === "string" ? input.command : "";
    for (const pattern of autoDenyPatterns) {
      const colonIdx = pattern.indexOf(":");
      if (colonIdx === -1) {
        continue;
      }
      const tool = pattern.slice(0, colonIdx);
      const cmdSubstr = pattern.slice(colonIdx + 1);
      if (toolName === tool && command.includes(cmdSubstr)) {
        return { behavior: "deny", message: `Auto-denied: ${pattern}` };
      }
    }

    // Tier 2: Gateway approval (requires gatewayApproval + sessionKey)
    if (permissions?.gatewayApproval && permissions.sessionKey) {
      onUpdate?.({
        content: [{ type: "text", text: `Permission requested: ${toolName}(${command || "..."})` }],
        details: {
          status: "running",
          phase: "permission",
          info: `${toolName}: awaiting approval`,
        },
      });

      try {
        const { callGatewayTool } = await import("./tools/gateway.js");
        const timeoutMs = permissions.approvalTimeoutMs ?? 120_000;
        const result = await callGatewayTool<{ decision: string }>(
          "exec.approval.request",
          { timeoutMs: timeoutMs + 10_000 },
          {
            id: crypto.randomUUID(),
            command: `claude_code:${toolName} ${command}`.slice(0, 200),
            cwd: "",
            host: "gateway",
            security: "ask",
            ask: "always",
            sessionKey: permissions.sessionKey,
            timeoutMs,
          },
        );
        const decision =
          result && typeof result === "object" ? (result as { decision?: string }).decision : null;
        if (decision === "allow-once" || decision === "allow-always") {
          return { behavior: "allow" };
        }
        return { behavior: "deny", message: "Approval denied or timed out" };
      } catch {
        return { behavior: "deny", message: "Approval request failed" };
      }
    }

    // Tier 3: No gateway — allow remaining tools (acceptEdits mode handles file safety)
    return { behavior: "allow" };
  };
}
