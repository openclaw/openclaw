/**
 * Sondera Extension for OpenClaw
 *
 * Provides Cedar policy-based guardrails for AI agent tool calls.
 * Uses pure JavaScript (cedar-wasm) - no Python required.
 *
 * @see https://docs.sondera.ai/integrations/openclaw
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type {
  OpenClawPluginApi,
  PluginHookBeforeToolCallEvent,
  PluginHookToolContext,
  PluginHookBeforeToolCallResult,
  PluginHookAfterToolCallEvent,
  PluginHookToolResultPersistEvent,
  PluginHookToolResultPersistContext,
  PluginHookToolResultPersistResult,
} from "../../src/plugins/types.js";
import { CedarEvaluator, countPolicyRules } from "./evaluator.js";

type SonderaConfig = {
  /** Enable the Sondera Policy Pack (default rules) */
  a_policyPack?: boolean;
  /** Enable the OpenClaw System Protection Pack */
  a2_openclawSystemPack?: boolean;
  /** Enable the OWASP Agentic Pack (advanced rules) */
  a3_owaspAgenticPack?: boolean;
  /** Block all by default (deny unless explicitly permitted) */
  b_lockdown?: boolean;
  /** Additional Cedar rules to append (from config UI) */
  c_customRules?: string;
  /** Path to the base Cedar policy file (relative to extension or absolute) */
  d_policyPath?: string;
};

export default function (api: OpenClawPluginApi) {
  api.logger.debug?.("Sondera extension loading...");

  // Use import.meta to get the actual source directory where .cedar files live
  // api.source may point to a different location (e.g., dist/) where policy files aren't copied
  const extensionDir = path.dirname(fileURLToPath(import.meta.url));

  // Use api.pluginConfig for direct access to this plugin's config
  const pluginConfig = api.pluginConfig as SonderaConfig | undefined;

  const policyPackEnabled = pluginConfig?.a_policyPack ?? true;
  const openclawSystemPackEnabled = pluginConfig?.a2_openclawSystemPack ?? false;
  const owaspAgenticPackEnabled = pluginConfig?.a3_owaspAgenticPack ?? false;
  const blockByDefault = pluginConfig?.b_lockdown ?? false;
  const customPolicyRules = pluginConfig?.c_customRules?.trim() ?? "";
  const customPolicyPath = pluginConfig?.d_policyPath?.trim();

  // Log config for debugging
  api.logger.debug?.(
    `[Sondera] Config: lockdown=${blockByDefault}, policyPack=${policyPackEnabled}, openclawSystem=${openclawSystemPackEnabled}, owaspAgentic=${owaspAgenticPackEnabled}`,
  );

  // Lockdown mode: rely on Cedar's implicit deny (no default policy needed)
  // When no policies match, Cedar returns DENY by default
  // This allows user's permit rules to work without being overridden by a blanket forbid

  // Allow-by-default mode: allow all unless explicitly forbidden
  const allowAllPolicy = `
// Allow-by-default mode (standard)
@id("default-allow")
permit(principal, action, resource);
`;

  // Load policy based on mode:
  // - If policyPath is set: use ONLY that file (expert mode, full control)
  // - Otherwise: combine defaultPolicy + bundled guardrails + customPolicy from UI
  let combinedPolicy = "";
  const bundledPolicyPath = path.resolve(extensionDir, "policy-sondera-base.cedar");
  const owaspAgenticPolicyPath = path.resolve(extensionDir, "policy-owasp-agentic.cedar");
  const openclawSystemPolicyPath = path.resolve(extensionDir, "policy-openclaw-system.cedar");

  if (customPolicyPath) {
    // Expert mode: User specified a custom policy file - use ONLY this
    const resolvedPath = path.isAbsolute(customPolicyPath)
      ? customPolicyPath
      : path.resolve(extensionDir, customPolicyPath);
    try {
      combinedPolicy = fs.readFileSync(resolvedPath, "utf-8");
      api.logger.debug?.(`[Sondera] Expert mode: using custom policy file ONLY: ${resolvedPath}`);
      api.logger.debug?.(
        `[Sondera] Note: policyPack, lockdown, and customRules settings are ignored when policyPath is set`,
      );
    } catch (err) {
      api.logger.error(`[Sondera] Failed to load custom policy from ${resolvedPath}: ${err}`);
      // Fall through to standard mode
    }
  }

  // Standard mode: combine layers
  if (!combinedPolicy) {
    // Load bundled default guardrails (if enabled)
    let basePolicy = "";
    if (policyPackEnabled) {
      try {
        basePolicy = fs.readFileSync(bundledPolicyPath, "utf-8");
        const ruleCount = countPolicyRules(basePolicy);
        api.logger.debug?.(`[Sondera] Loaded bundled default policy pack (${ruleCount} rules)`);
      } catch {
        api.logger.debug?.(
          `[Sondera] No bundled policy-sondera-base.cedar found (this is OK if using UI-only)`,
        );
      }
    } else {
      api.logger.debug?.(`[Sondera] Sondera Policy Pack disabled by config`);
    }

    // Load OpenClaw System Protection pack (if enabled)
    let openclawSystemPolicy = "";
    if (openclawSystemPackEnabled) {
      try {
        openclawSystemPolicy = fs.readFileSync(openclawSystemPolicyPath, "utf-8");
        const ruleCount = countPolicyRules(openclawSystemPolicy);
        api.logger.debug?.(`[Sondera] Loaded OpenClaw System Protection pack (${ruleCount} rules)`);
      } catch {
        api.logger.debug?.(`[Sondera] No policy-openclaw-system.cedar found`);
      }
    } else {
      api.logger.debug?.(`[Sondera] OpenClaw System Protection Pack disabled by config`);
    }

    // Load OWASP Agentic pack (if enabled)
    let owaspAgenticPolicy = "";
    if (owaspAgenticPackEnabled) {
      try {
        owaspAgenticPolicy = fs.readFileSync(owaspAgenticPolicyPath, "utf-8");
        const ruleCount = countPolicyRules(owaspAgenticPolicy);
        api.logger.debug?.(`[Sondera] Loaded OWASP Agentic policy pack (${ruleCount} rules)`);
      } catch {
        api.logger.debug?.(`[Sondera] No policy-owasp-agentic.cedar found`);
      }
    } else {
      api.logger.debug?.(`[Sondera] OWASP Agentic Pack disabled by config (default)`);
    }

    // Log custom rules from UI if present
    if (customPolicyRules) {
      const customRuleCount = countPolicyRules(customPolicyRules);
      api.logger.debug?.(`[Sondera] Adding ${customRuleCount} custom rules from config UI`);
    }

    // Log block-by-default mode
    if (blockByDefault) {
      api.logger.debug?.(
        `[Sondera] Block-by-default mode ENABLED (deny all unless explicitly permitted)`,
      );
    }

    // Select the default policy based on mode
    // Lockdown mode: no default policy (Cedar's implicit deny handles it)
    // Normal mode: permit all by default
    const defaultPolicy = blockByDefault ? "" : allowAllPolicy;

    // Combine: default policy + base guardrails + OpenClaw system pack + OWASP pack + custom rules from UI
    // Order matters: default policy first, then guardrails, then OpenClaw system, then OWASP, then custom rules
    combinedPolicy = [
      defaultPolicy,
      basePolicy,
      openclawSystemPolicy,
      owaspAgenticPolicy,
      customPolicyRules,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  if (!combinedPolicy.trim()) {
    if (blockByDefault) {
      // Lockdown mode with no policies: rely on Cedar's implicit default-deny
      // Empty policy set = no permits = all requests denied (Cedar best practice)
      api.logger.info("[Sondera] Lockdown mode enabled - all tools blocked by Cedar default-deny.");
      // Keep combinedPolicy empty - this is valid input for Cedar
    } else {
      api.logger.warn(
        "[Sondera] No policy configured. Set policyPath or add customPolicy via config UI.",
      );
      api.logger.debug?.("Sondera extension loaded (inactive - no policy configured).");
      return;
    }
  }

  // Create the Cedar evaluator
  let evaluator: CedarEvaluator;
  try {
    evaluator = new CedarEvaluator(combinedPolicy);
    const totalRules = evaluator.ruleCount;
    const hasDefaultPermit = combinedPolicy.includes('@id("default-allow")');
    api.logger.debug?.(
      `[Sondera] Cedar evaluator initialized with ${totalRules} rules (default-allow=${hasDefaultPermit})`,
    );
  } catch (err) {
    api.logger.error(`[Sondera] Failed to initialize Cedar evaluator: ${err}`);
    api.logger.debug?.("Sondera extension loaded (inactive - policy parse error).");
    return;
  }

  // ============================================
  // HOOK: before_tool_call (PRE_TOOL stage)
  // Blocks tool calls that violate policy
  // ============================================
  api.on(
    "before_tool_call",
    async (
      event: PluginHookBeforeToolCallEvent,
      _ctx: PluginHookToolContext,
    ): Promise<PluginHookBeforeToolCallResult | void> => {
      const { toolName, params } = event;

      api.logger.debug?.(`[Sondera] before_tool_call: toolName=${toolName}`);

      const result = evaluator.evaluatePreTool(toolName, params);
      api.logger.debug?.(
        `[Sondera] PRE_TOOL decision for "${toolName}": ${result.decision} reason=${result.reason}`,
      );

      if (result.decision === "DENY") {
        return {
          block: true,
          blockReason: `Blocked by Sondera policy.${result.reason ? ` (${result.reason})` : ""}`,
        };
      }

      return {};
    },
  );

  // ============================================
  // HOOK: after_tool_call (observability)
  // Logs tool execution for monitoring
  // ============================================
  api.on(
    "after_tool_call",
    async (event: PluginHookAfterToolCallEvent, _ctx: PluginHookToolContext): Promise<void> => {
      const { toolName, error, durationMs } = event;

      if (error) {
        api.logger.debug?.(
          `[Sondera] after_tool_call: toolName=${toolName} error="${error}" duration=${durationMs}ms`,
        );
      } else {
        api.logger.debug?.(
          `[Sondera] after_tool_call: toolName=${toolName} duration=${durationMs}ms`,
        );
      }
    },
  );

  // ============================================
  // HOOK: tool_result_persist (POST_TOOL stage)
  // Redacts tool results that violate policy
  // ============================================
  api.on(
    "tool_result_persist",
    (
      event: PluginHookToolResultPersistEvent,
      _ctx: PluginHookToolResultPersistContext,
    ): PluginHookToolResultPersistResult | void => {
      const { toolName, message } = event;

      // Extract text content from the message
      const content = message.content;
      let textContent = "";
      if (typeof content === "string") {
        textContent = content;
      } else if (Array.isArray(content)) {
        textContent = content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");
      }

      const result = evaluator.evaluatePostTool(toolName ?? "unknown", textContent);
      api.logger.debug?.(`[Sondera] POST_TOOL decision for "${toolName}": ${result.decision}`);

      if (result.decision === "DENY") {
        const policyInfo = result.reason ? ` (${result.reason})` : "";
        api.logger.debug?.(
          `[Sondera] Tool result redacted by policy for "${toolName}"${policyInfo}`,
        );
        return {
          message: {
            ...message,
            content: [{ type: "text", text: `[REDACTED BY SONDERA POLICY]${policyInfo}` }],
          },
        };
      }

      return undefined;
    },
  );

  api.logger.debug?.("Sondera extension loaded.");
}
