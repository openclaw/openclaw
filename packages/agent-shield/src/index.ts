// Plugin entry point. We're hook-only - no provider, no channel.
// We hook into the agent lifecycle to scan inbound content, redact
// outbound secrets, and expose a couple of tools/CLI commands.

import { scan } from "./scanner/message-scanner.js";
import { handleThreats, getAgentState, getAllAgentStates, confirmRecovery, resetAgentState } from "./recovery/router.js";
import { redactSecrets, containsSecrets } from "./utils/redact.js";
import { buildSafeEnv, getFilterSummary } from "./utils/env-filter.js";
import { logThreat, queryLog, getStats, clearLog } from "./utils/threat-log.js";
import { RULES } from "./rules/index.js";
import type { AgentShieldConfig, MessageSource, ThreatMatch } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

export default function register(api: any) {
  const config: AgentShieldConfig = {
    ...DEFAULT_CONFIG,
    ...(api.getPluginConfig?.() || {}),
  };

  // Per-session match history, used by T18 (multi-turn detection).
  const sessionMatches = new Map<string, ThreatMatch[]>();

  // Scan inbound content before it enters the prompt.
  api.registerHook?.("before_prompt_build", async (ctx: any) => {
    if (!config.enabled) return;

    const sessionId = ctx.sessionId || ctx.session?.id || "unknown";
    const priorMatches = sessionMatches.get(sessionId) || [];

    if (ctx.toolResults && Array.isArray(ctx.toolResults)) {
      for (const toolResult of ctx.toolResults) {
        const content =
          typeof toolResult.content === "string"
            ? toolResult.content
            : JSON.stringify(toolResult.content);

        const source: MessageSource = {
          agentId: ctx.agentId || "primary",
          targetId: "prompt",
          direction: "tool_result",
          sessionId,
          timestamp: Date.now(),
        };

        const result = scan(
          content,
          source,
          config,
          ctx.delegationDepth || 0,
          ctx.delegationChain || [],
          priorMatches,
          toolResult.toolName
        );

        if (!result.clean) {
          priorMatches.push(...result.matches);
          sessionMatches.set(sessionId, priorMatches);

          const recoveryActions = handleThreats(
            source.agentId,
            result.matches,
            config,
            ctx.availableAgents || [],
            sessionId
          );
          logThreat(result, source, recoveryActions, config);

          if (
            config.mode === "enforce" &&
            result.action === "block"
          ) {
            toolResult._shieldBlocked = true;
            toolResult._shieldReason = result.matches
              .map((m) => `${m.ruleId}: ${m.ruleName}`)
              .join("; ");
          }
        }
      }
    }

    // Same treatment for agent-to-agent messages.
    if (ctx.delegatedContent && typeof ctx.delegatedContent === "string") {
      const source: MessageSource = {
        agentId: ctx.sourceAgentId || "delegated",
        targetId: ctx.agentId || "primary",
        direction: "agent_to_agent",
        sessionId,
        timestamp: Date.now(),
      };

      const result = scan(
        ctx.delegatedContent,
        source,
        config,
        ctx.delegationDepth || 0,
        ctx.delegationChain || [],
        priorMatches
      );

      if (!result.clean) {
        priorMatches.push(...result.matches);
        sessionMatches.set(sessionId, priorMatches);

        const recoveryActions = handleThreats(
          source.agentId,
          result.matches,
          config,
          ctx.availableAgents || [],
          sessionId
        );
        logThreat(result, source, recoveryActions, config);

        if (config.mode === "enforce" && result.action === "block") {
          ctx._shieldBlocked = true;
          ctx._shieldAnnotation =
            `[AGENT SHIELD] Blocked agent-to-agent message from "${source.agentId}": ` +
            result.matches.map((m) => m.ruleName).join(", ");
        }
      }
    }
  });

  // Outbound: redact secrets before anything reaches a channel.
  api.registerHook?.("message_sending", async (ctx: any) => {
    if (!config.enabled || !config.redactSecrets) return;

    if (ctx.content && typeof ctx.content === "string") {
      const source: MessageSource = {
        agentId: ctx.agentId || "primary",
        targetId: ctx.channelId || "channel",
        direction: "outbound",
        sessionId: ctx.sessionId || "unknown",
        timestamp: Date.now(),
      };

      const result = scan(ctx.content, source, config);
      if (!result.clean) {
        logThreat(result, source, [], config);
      }

      // Redact regardless of scan result - it's cheap and the cost of
      // leaking a key once is much higher than scanning twice.
      const { redacted, count } = redactSecrets(ctx.content);
      if (count > 0) {
        ctx.content = redacted;

        logThreat(
          {
            clean: false,
            matches: [
              {
                ruleId: "REDACT",
                ruleName: "Secret Redaction",
                category: "secret_leak",
                severity: "high",
                confidence: 1.0,
                excerpt: `[${count} secret(s) redacted]`,
                action: "redact",
                explanation: `Redacted ${count} secret pattern(s) from outbound message.`,
              },
            ],
            durationMs: 0,
            maxSeverity: "high",
            action: "redact",
          },
          source,
          [],
          config
        );
      }
    }
  });

  // Tool: agent_shield_status - let the agent query its own shield state.
  api.registerAgentTool?.({
    name: "agent_shield_status",
    description:
      "Query Agent Shield status: active rules, recent threats, " +
      "agent health states, and aggregate statistics.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          enum: ["stats", "agents", "recent", "rules"],
          description:
            "stats = aggregate threat stats; agents = all agent health states; " +
            "recent = last 10 threat events; rules = list all active rules",
        },
      },
      required: ["query"],
    },
    async execute({ query }: { query: string }) {
      switch (query) {
        case "stats":
          return JSON.stringify(getStats(), null, 2);
        case "agents":
          return JSON.stringify(
            getAllAgentStates().map((s) => ({
              agentId: s.agentId,
              status: s.status,
              threats: s.threats.length,
              recoveryAttempts: s.recoveryAttempts,
              activeWork: s.activeWork.length,
            })),
            null,
            2
          );
        case "recent":
          return JSON.stringify(
            queryLog({ limit: 10 }).map((e) => ({
              id: e.id,
              time: new Date(e.timestamp).toISOString(),
              session: e.sessionId,
              severity: e.scanResult.maxSeverity,
              threats: e.scanResult.matches.map((m) => m.ruleName),
              actions: e.recoveryActions.map((a) => a.type),
            })),
            null,
            2
          );
        case "rules":
          return JSON.stringify(
            RULES.map((r) => ({
              id: r.id,
              name: r.name,
              category: r.category,
              severity: r.severity,
              description: r.description,
            })),
            null,
            2
          );
        default:
          return `Unknown query: ${query}. Use: stats, agents, recent, rules`;
      }
    },
  });

  // Tool: agent_shield_resume - approval-gated way to bring an agent back.
  api.registerAgentTool?.({
    name: "agent_shield_resume",
    description:
      "Resume a paused agent after security review. Requires approval.",
    parameters: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description: "The ID of the agent to resume",
        },
      },
      required: ["agentId"],
    },
    requiresApproval: true,
    async execute({ agentId }: { agentId: string }) {
      const state = getAgentState(agentId);
      if (state.status === "healthy") {
        return `Agent "${agentId}" is already healthy.`;
      }
      if (state.status === "quarantined") {
        return (
          `Agent "${agentId}" is quarantined after ${state.recoveryAttempts} ` +
          "failed recovery attempts. Manual intervention required. " +
          "Use the escalation artifact for diagnosis and fix steps."
        );
      }
      confirmRecovery(agentId);
      return `Agent "${agentId}" has been resumed and marked healthy.`;
    },
  });

  // CLI: openclaw agent-shield ...
  api.registerCliCommand?.({
    name: "agent-shield",
    description: "Agent Shield security management",
    subcommands: {
      status: {
        description: "Show shield status and stats",
        async run() {
          const stats = getStats();
          console.log("\nAgent Shield Status");
          console.log("=".repeat(40));
          console.log(`Rules active: ${RULES.length}`);
          console.log(`Mode: ${config.mode}`);
          console.log(`Total scans: ${stats.totalScans}`);
          console.log(`Total threats: ${stats.totalThreats}`);
          console.log(`Recovery actions: ${stats.recoveryActions}`);
          if (Object.keys(stats.bySeverity).length > 0) {
            console.log("\nBy severity:");
            for (const [sev, count] of Object.entries(stats.bySeverity)) {
              console.log(`  ${sev}: ${count}`);
            }
          }
          if (Object.keys(stats.byCategory).length > 0) {
            console.log("\nBy category:");
            for (const [cat, count] of Object.entries(stats.byCategory)) {
              console.log(`  ${cat}: ${count}`);
            }
          }
          console.log();
        },
      },
      agents: {
        description: "List agent health states",
        async run() {
          const states = getAllAgentStates();
          if (states.length === 0) {
            console.log("No agent states recorded yet.");
            return;
          }
          console.log("\nAgent Health States");
          console.log("=".repeat(60));
          for (const s of states) {
            const icon =
              s.status === "healthy" ? "OK" :
              s.status === "paused" ? "PAUSED" :
              s.status === "recovering" ? "RECOVERING" :
              "QUARANTINED";
            console.log(
              `  [${icon}] ${s.agentId} | threats: ${s.threats.length} | ` +
              `recovery: ${s.recoveryAttempts} | work: ${s.activeWork.length}`
            );
          }
          console.log();
        },
      },
      resume: {
        description: "Resume a paused agent",
        args: ["agentId"],
        async run(args: string[]) {
          const agentId = args[0];
          if (!agentId) {
            console.error("Usage: openclaw agent-shield resume <agentId>");
            return;
          }
          confirmRecovery(agentId);
          console.log(`Agent "${agentId}" resumed.`);
        },
      },
      reset: {
        description: "Reset all shield state (clears log and agent states)",
        async run() {
          clearLog();
          for (const state of getAllAgentStates()) {
            resetAgentState(state.agentId);
          }
          console.log("Agent Shield state cleared.");
        },
      },
      rules: {
        description: "List all threat rules",
        async run() {
          console.log(`\nAgent Shield Rules (${RULES.length} active)`);
          console.log("=".repeat(70));
          for (const r of RULES) {
            console.log(`  ${r.id} [${r.severity.toUpperCase()}] ${r.name}`);
            console.log(`       ${r.category} | ${r.description}`);
            console.log();
          }
        },
      },
    },
  });

  if (config.enabled) {
    process.stderr.write(
      `[agent-shield] Loaded ${RULES.length} threat rules in ${config.mode} mode\n`
    );
  }
}
