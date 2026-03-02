import type {
  OpenClawPluginDefinition,
  OpenClawPluginApi,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookAfterToolCallEvent,
  PluginHookToolContext,
} from "openclaw/plugin-sdk";
import { AuditLogger } from "./audit.js";
import { BUILTIN_RULES } from "./builtin-rules.js";
import { ChainDetector, DEFAULT_CHAIN_RULES } from "./chain-detector.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { RulesEngine } from "./engine.js";
import { RateLimiter, DEFAULT_RATE_LIMITS } from "./rate-limiter.js";
import type { HarnessMode, HarnessTier } from "./types.js";
import { classifyVerb } from "./verb-classifier.js";

const HARNESS_PRIORITY = 100;
const DEFAULT_AUDIT_PATH = "/var/log/fridaclaw/harness-audit.jsonl";

export const safetyHarnessPlugin: OpenClawPluginDefinition = {
  id: "safety-harness",
  name: "Safety Harness",
  description: "Classifies tool calls into allow/confirm/block tiers with audit logging",
  version: "0.1.0",

  register(api: OpenClawPluginApi) {
    const mode: HarnessMode = (process.env.HARNESS_MODE as HarnessMode) || "observe";
    const auditPath = process.env.HARNESS_AUDIT_PATH || DEFAULT_AUDIT_PATH;

    const engine = new RulesEngine(BUILTIN_RULES, [], []);
    const audit = new AuditLogger(auditPath);
    const rateLimiter = new RateLimiter(DEFAULT_RATE_LIMITS);
    const chainDetector = new ChainDetector(DEFAULT_CHAIN_RULES);
    const circuitBreaker = new CircuitBreaker();

    // Track the most recent effective tier and chain flags per toolName so after_tool_call
    // can audit correctly. Last-call-wins is acceptable for Phase 1 (sequential tool calls).
    const lastTierByTool = new Map<string, HarnessTier>();
    const lastChainFlagsByTool = new Map<string, string[]>();

    api.logger.info(`[safety-harness] initialized in ${mode} mode, audit → ${auditPath}`);

    api.on(
      "before_tool_call",
      async (
        event: PluginHookBeforeToolCallEvent,
        _ctx: PluginHookToolContext,
      ): Promise<PluginHookBeforeToolCallResult | void> => {
        try {
          const { toolName, params } = event;
          const verb = classifyVerb(toolName);

          // In degraded mode (circuit open), allow reads but block all else
          if (circuitBreaker.isDegraded()) {
            if (verb !== "read") {
              return {
                block: true,
                blockReason: "Safety check unavailable. Action blocked for safety.",
              };
            }
            return undefined; // allow reads in degraded mode
          }

          // 1. Rules engine classification
          const classification = engine.classify(toolName, params);

          // 2. Rate limit check (may escalate tier) — build a local reason string,
          //    never mutate the engine's return object (Issue 7).
          const rateCategory = RateLimiter.toRateCategory(verb);
          let effectiveTier = classification.tier;
          let effectiveReason = classification.reason;
          if (rateCategory && !rateLimiter.check(rateCategory)) {
            effectiveTier = "block";
            effectiveReason = `Rate limit exceeded for ${rateCategory}: ${effectiveReason}`;
          }

          // 3. Chain detection
          const chainFlags = chainDetector.check({
            tool: toolName,
            verb,
            target: toolName.split(".")[0] || toolName,
          });
          if (chainFlags.length > 0) {
            effectiveTier = "block";
            effectiveReason = `Chain detected (${chainFlags.join(", ")}): ${effectiveReason}`;
          }

          // Store effective tier and chain flags for after_tool_call audit
          lastTierByTool.set(toolName, effectiveTier);
          lastChainFlagsByTool.set(toolName, chainFlags);

          api.logger.info(
            `[safety-harness] ${toolName}: tier=${effectiveTier} reason="${effectiveReason}" mode=${mode}`,
          );

          circuitBreaker.recordSuccess();

          // In observe mode, never block
          if (mode === "observe") {
            return undefined;
          }

          // In enforce mode, block if tier is "block"
          if (effectiveTier === "block") {
            // Return generic message to AI; log details only in audit trail
            api.logger.warn(`[safety-harness] BLOCKED ${toolName}: ${effectiveReason}`);
            return {
              block: true,
              blockReason: "Action blocked by safety policy. Please try a different approach.",
            };
          }

          // "confirm" tier: for Phase 1, treat as allow (confirmation flow is Phase 3)
          return undefined;
        } catch (err) {
          circuitBreaker.recordFailure();
          api.logger.error(`[safety-harness] pre-hook error (fail-closed): ${err}`);
          return {
            block: true,
            blockReason: "Safety check unavailable. Action blocked for safety.",
          };
        }
      },
      { priority: HARNESS_PRIORITY },
    );

    api.on(
      "after_tool_call",
      async (event: PluginHookAfterToolCallEvent, _ctx: PluginHookToolContext) => {
        const { toolName, params } = event;
        const verb = classifyVerb(toolName);

        // Resolve the tier captured during before_tool_call (or re-classify if the
        // pre-hook was skipped, e.g. in tests that call after_tool_call in isolation).
        const tier: HarnessTier =
          lastTierByTool.get(toolName) ?? engine.classify(toolName, params).tier;
        const chainFlags: string[] = lastChainFlagsByTool.get(toolName) ?? [];
        // Consume stored values so stale entries don't bleed across calls
        lastTierByTool.delete(toolName);
        lastChainFlagsByTool.delete(toolName);

        // Only record quota and ledger for calls that actually executed (Issues 1 & 2).
        // Blocked calls were rejected before execution — consuming quota would be wrong.
        if (tier !== "block") {
          const rateCategory = RateLimiter.toRateCategory(verb);
          if (rateCategory) {
            rateLimiter.record(rateCategory);
          }

          chainDetector.record({
            tool: toolName,
            verb,
            target: toolName.split(".")[0] || toolName,
          });
        }

        // Build args summary (sanitized — no full bodies or secrets)
        // Expanded redaction list for credential fields
        const SENSITIVE_KEY_PATTERN =
          /body|content|text|html|token|key|password|secret|auth|credential|bearer|private/i;
        const argsSummary = Object.entries(params)
          .map(([k, v]) =>
            SENSITIVE_KEY_PATTERN.test(k) ? `${k}: [REDACTED]` : `${k}: ${String(v).slice(0, 100)}`,
          )
          .join(", ");

        const result = event.error ? "error" : "executed";
        await audit
          .log({
            tool: toolName,
            argsSummary,
            tier,
            tainted: false, // Phase 4 stub
            result,
            chainFlags,
            rateWindow: rateLimiter.getCounts(),
          })
          .catch((err) => {
            api.logger.error(`[safety-harness] audit write failed: ${err}`);
          });
      },
      { priority: HARNESS_PRIORITY },
    );
  },
};

export default safetyHarnessPlugin;
