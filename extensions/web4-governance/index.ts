/**
 * Web4 Governance Plugin for Moltbot
 *
 * Adds R6 workflow formalism, audit trails, and session identity
 * to moltbot agent sessions. Uses internal hooks for session lifecycle
 * and typed after_tool_call hooks for tool-level audit.
 */

import type { MoltbotPluginApi } from "clawdbot/plugin-sdk";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { createSoftLCT } from "./src/soft-lct.js";
import { createR6Request, hashOutput, classifyTool, extractTarget } from "./src/r6.js";
import { AuditChain } from "./src/audit.js";
import { SessionStore, type SessionState } from "./src/session-state.js";
import { PolicyEngine } from "./src/policy.js";
import type { PolicyConfig, PolicyEvaluation } from "./src/policy-types.js";

type PluginConfig = {
  auditLevel?: string;
  showR6Status?: boolean;
  storagePath?: string;
  policy?: Partial<PolicyConfig>;
};

const plugin = {
  id: "web4-governance",
  name: "Web4 Governance",
  description: "R6 workflow formalism, audit trails, and trust-native session identity",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      auditLevel: { type: "string", enum: ["minimal", "standard", "verbose"], default: "standard" },
      showR6Status: { type: "boolean", default: true },
      storagePath: { type: "string" },
    },
  },

  register(api: MoltbotPluginApi) {
    const config = (api.pluginConfig ?? {}) as PluginConfig;
    const storagePath = config.storagePath ?? join(homedir(), ".web4");
    const auditLevel = config.auditLevel ?? "standard";
    const logger = api.logger;

    // Per-session state (keyed by sessionKey)
    const sessions = new Map<string, { state: SessionState; audit: AuditChain }>();
    const sessionStore = new SessionStore(storagePath);

    // Policy engine
    const policyEngine = new PolicyEngine(config.policy);
    if (policyEngine.ruleCount > 0) {
      logger.info(
        `[web4] Policy engine: ${policyEngine.ruleCount} rules, enforce=${policyEngine.isEnforcing}`,
      );
    }

    // Stash for passing policy evaluations from before_tool_call to after_tool_call
    const policyStash = new Map<string, PolicyEvaluation>();

    function getOrCreateSession(sessionKey: string): { state: SessionState; audit: AuditChain } {
      let entry = sessions.get(sessionKey);
      if (!entry) {
        const sessionId = sessionKey || randomUUID();
        const lct = createSoftLCT(sessionId);
        const state: SessionState = {
          sessionId,
          lct,
          actionIndex: 0,
          startedAt: new Date().toISOString(),
          toolCounts: {},
          categoryCounts: {},
        };
        const audit = new AuditChain(storagePath, sessionId);
        sessionStore.save(state);
        entry = { state, audit };
        sessions.set(sessionKey, entry);
        logger.info(`[web4] Session ${lct.tokenId} initialized (${auditLevel} audit)`);
      }
      return entry;
    }

    // --- Internal Hooks (these actually fire in current moltbot) ---

    // Hook into agent bootstrap - fires when agent session starts
    api.registerHook(["agent", "agent:bootstrap"], async (event) => {
      const sessionKey = event.sessionKey || "default";
      const entry = getOrCreateSession(sessionKey);
      logger.info(`[web4] Governance active: ${entry.state.lct.tokenId} (session: ${sessionKey})`);
    }, { name: "web4-agent-bootstrap", description: "Initialize Web4 governance session on agent bootstrap" });

    // Hook into session events
    api.registerHook(["session"], async (event) => {
      const sessionKey = event.sessionKey || "default";
      if (event.action === "new" || event.action === "start") {
        const entry = getOrCreateSession(sessionKey);
        logger.info(`[web4] Session ${event.action}: ${entry.state.lct.tokenId}`);
      } else if (event.action === "end" || event.action === "stop" || event.action === "reset") {
        const entry = sessions.get(sessionKey);
        if (entry) {
          const verification = entry.audit.verify();
          logger.info(
            `[web4] Session ${event.action}: ${entry.state.actionIndex} actions, ` +
              `chain ${verification.valid ? "VALID" : "INVALID"} (${verification.recordCount} records)`,
          );
          sessionStore.save(entry.state);
          sessions.delete(sessionKey);
        }
      }
    }, { name: "web4-session-lifecycle", description: "Track Web4 session lifecycle events" });

    // Hook into command events - captures all agent commands
    api.registerHook(["command"], async (event) => {
      const sessionKey = event.sessionKey || "default";
      const entry = getOrCreateSession(sessionKey);
      const { state } = entry;

      // Create R6 request for the command
      const toolName = String(event.context.command ?? event.action ?? "unknown");
      const params = (event.context ?? {}) as Record<string, unknown>;

      const r6 = createR6Request(
        state.sessionId,
        undefined,
        toolName,
        params,
        state.actionIndex,
        state.lastR6Id,
        auditLevel,
      );

      // Record in audit chain with success (commands that reach hooks succeeded)
      const result = {
        status: "success" as const,
        outputHash: hashOutput(event.context),
      };
      r6.result = result;
      entry.audit.record(r6, result);

      // Update session state
      const category = classifyTool(toolName);
      sessionStore.incrementAction(state, toolName, category, r6.id);

      if (auditLevel === "verbose") {
        logger.info(`[web4] R6 ${r6.id}: ${toolName} [${category}] → ${r6.request.target ?? "(no target)"}`);
      }
    }, { name: "web4-command-audit", description: "Record R6 audit entries for agent commands" });

    // --- Typed Tool Hooks (wired via pi-tools.hooks.ts) ---

    // Pre-action policy gating
    api.on("before_tool_call", (event, ctx) => {
      if (policyEngine.ruleCount === 0) return;

      const category = classifyTool(event.toolName);
      const target = extractTarget(event.toolName, event.params);
      const { blocked, evaluation } = policyEngine.shouldBlock(event.toolName, category, target);

      // Stash evaluation for after_tool_call to pick up
      const sid = ctx.sessionKey ?? ctx.agentId ?? "default";
      policyStash.set(sid, evaluation);

      if (evaluation.decision === "warn") {
        logger.warn(
          `[web4] Policy WARN: ${event.toolName} [${category}] → ${target ?? "(no target)"} — ${evaluation.reason}`,
        );
      }

      if (blocked) {
        logger.warn(
          `[web4] Policy DENY: ${event.toolName} [${category}] → ${target ?? "(no target)"} — ${evaluation.reason}`,
        );
        return { block: true, blockReason: `[web4-policy] ${evaluation.reason}` };
      }

      if (evaluation.decision === "deny" && !evaluation.enforced) {
        // Dry-run mode: log but don't block
        logger.warn(
          `[web4] Policy DENY (dry-run): ${event.toolName} [${category}] → ${target ?? "(no target)"} — ${evaluation.reason}`,
        );
      }
    });

    api.on("after_tool_call", (event, ctx) => {
      const sid = ctx.sessionKey ?? ctx.agentId ?? "default";
      const entry = sessions.get(sid);
      if (!entry) return;

      // Pick up stashed policy evaluation from before_tool_call
      const policyEval = policyStash.get(sid);
      policyStash.delete(sid);

      const r6 = createR6Request(
        entry.state.sessionId,
        ctx.agentId,
        event.toolName,
        event.params,
        entry.state.actionIndex,
        entry.state.lastR6Id,
        auditLevel,
      );

      // Write policy constraints to R6
      if (policyEval) {
        r6.rules.constraints = policyEval.constraints;
      }

      const result = {
        status: (event.error ? "error" : "success") as "success" | "error",
        outputHash: event.result ? hashOutput(event.result) : undefined,
        errorMessage: event.error,
        durationMs: event.durationMs,
      };
      r6.result = result;
      entry.audit.record(r6, result);
      sessionStore.incrementAction(entry.state, event.toolName, classifyTool(event.toolName), r6.id);

      if (auditLevel === "verbose") {
        logger.info(`[web4] R6 ${r6.id}: ${event.toolName} [${classifyTool(event.toolName)}] (${event.durationMs ?? 0}ms)`);
      }
    });

    // --- CLI Commands ---

    api.registerCli(
      ({ program }) => {
        const audit = program.command("audit").description("Web4 governance audit trail");

        audit
          .command("summary")
          .description("Show session audit summary")
          .action(() => {
            for (const [sid, entry] of sessions) {
              const v = entry.audit.verify();
              console.log(`Session: ${entry.state.lct.tokenId}`);
              console.log(`  Actions: ${entry.state.actionIndex}`);
              console.log(`  Audit records: ${v.recordCount}`);
              console.log(`  Chain valid: ${v.valid}`);
              console.log(`  Tools: ${JSON.stringify(entry.state.toolCounts)}`);
              console.log(`  Categories: ${JSON.stringify(entry.state.categoryCounts)}`);
            }
            if (sessions.size === 0) {
              console.log("No active governance sessions.");
            }
          });

        audit
          .command("verify")
          .description("Verify audit chain integrity")
          .argument("[sessionId]", "Session ID to verify")
          .action((sessionId?: string) => {
            if (sessionId) {
              const chain = new AuditChain(storagePath, sessionId);
              const result = chain.verify();
              console.log(`Chain valid: ${result.valid}`);
              console.log(`Records: ${result.recordCount}`);
              if (result.errors.length > 0) {
                console.log("Errors:");
                for (const e of result.errors) console.log(`  - ${e}`);
              }
            } else {
              for (const [, entry] of sessions) {
                const result = entry.audit.verify();
                console.log(`${entry.state.sessionId}: ${result.valid ? "VALID" : "INVALID"} (${result.recordCount} records)`);
              }
            }
          });

        audit
          .command("last")
          .description("Show last N audit records")
          .argument("[count]", "Number of records", "10")
          .action((countStr: string) => {
            const count = parseInt(countStr, 10) || 10;
            for (const [, entry] of sessions) {
              const records = entry.audit.getLast(count);
              for (const r of records) {
                console.log(`${r.timestamp} ${r.tool} → ${r.target ?? "?"} [${r.result.status}]`);
              }
            }
          });
      },
      { commands: ["audit"] },
    );

    // --- Policy Admin CLI ---

    api.registerCli(
      ({ program }) => {
        const policy = program.command("policy").description("Web4 policy engine administration");

        policy
          .command("status")
          .description("Show policy engine status")
          .action(() => {
            console.log(`Policy engine:`);
            console.log(`  Rules:    ${policyEngine.ruleCount}`);
            console.log(`  Default:  ${policyEngine.defaultDecision}`);
            console.log(`  Enforce:  ${policyEngine.isEnforcing}`);
          });

        policy
          .command("rules")
          .description("List all policy rules in evaluation order")
          .action(() => {
            const rules = policyEngine.sortedRules;
            if (rules.length === 0) {
              console.log("No policy rules configured.");
              return;
            }
            console.log(`${rules.length} rules (priority order):\n`);
            for (const rule of rules) {
              const match = rule.match;
              const criteria: string[] = [];
              if (match.tools) criteria.push(`tools=[${match.tools.join(", ")}]`);
              if (match.categories) criteria.push(`categories=[${match.categories.join(", ")}]`);
              if (match.targetPatterns) {
                const kind = match.targetPatternsAreRegex ? "regex" : "glob";
                criteria.push(`targets(${kind})=[${match.targetPatterns.join(", ")}]`);
              }
              console.log(`  [${rule.priority}] ${rule.id} → ${rule.decision}`);
              console.log(`       ${rule.name}`);
              if (criteria.length > 0) console.log(`       match: ${criteria.join(" AND ")}`);
              if (rule.reason) console.log(`       reason: ${rule.reason}`);
              console.log();
            }
            console.log(`Default: ${policyEngine.defaultDecision} | Enforce: ${policyEngine.isEnforcing}`);
          });

        policy
          .command("test")
          .description("Dry-run a tool call against the policy engine")
          .argument("<toolName>", "Tool name (e.g. Bash, Read, WebFetch)")
          .argument("[target]", "Target string (e.g. command, file path, URL)")
          .action((toolName: string, target?: string) => {
            const category = classifyTool(toolName);
            const evaluation = policyEngine.evaluate(toolName, category, target);
            console.log(`Tool:       ${toolName}`);
            console.log(`Category:   ${category}`);
            console.log(`Target:     ${target ?? "(none)"}`);
            console.log(`Decision:   ${evaluation.decision}`);
            console.log(`Enforced:   ${evaluation.enforced}`);
            console.log(`Reason:     ${evaluation.reason}`);
            if (evaluation.matchedRule) {
              console.log(`Rule:       ${evaluation.matchedRule.id} (priority ${evaluation.matchedRule.priority})`);
            }
            console.log(`Constraints: ${evaluation.constraints.join(", ")}`);
          });
      },
      { commands: ["policy"] },
    );

    logger.info(`[web4] Web4 Governance plugin loaded (audit: ${auditLevel})`);
  },
};

export default plugin;
