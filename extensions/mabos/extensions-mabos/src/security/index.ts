import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { InjectionScanner } from "./injection-scanner.js";
import { ToolGuard } from "./tool-guard.js";
import type { SecurityConfig } from "./types.js";
import { UrlValidator } from "./url-validator.js";

interface MabosSecurityConfig {
  securityEnabled?: boolean;
  security?: SecurityConfig;
}

const DEFAULT_DANGEROUS_TOOLS = [
  "execute_command",
  "shopify_delete_*",
  "send_payment",
  "send_email",
  "twilio_send_sms",
  "cloudflare_delete_*",
  "godaddy_delete_*",
];

export function createSecurityModule(api: OpenClawPluginApi, config: MabosSecurityConfig): void {
  if (config.securityEnabled === false) return;

  const secConfig = config.security ?? {};
  const log = api.logger;

  const scanner = new InjectionScanner();
  const guard = new ToolGuard({
    dangerousTools: secConfig.toolGuard?.dangerousTools ?? DEFAULT_DANGEROUS_TOOLS,
    autoApproveForRoles: secConfig.toolGuard?.autoApproveForRoles ?? ["admin", "operator"],
  });

  if (secConfig.injectionScanning?.enabled !== false) {
    api.on("before_tool_call", async (ctx: any) => {
      const argsText = JSON.stringify(ctx.args ?? {});
      const result = scanner.scan(argsText);
      if (!result.clean) {
        log.warn(
          `[security] Injection detected in ${ctx.toolName}: ${result.findings.map((f) => f.pattern).join(", ")}`,
        );
        if (secConfig.injectionScanning?.blockOnDetection !== false) {
          return {
            blocked: true,
            reason: `Security: potential injection detected (${result.highestThreat} threat) in tool "${ctx.toolName}". Patterns: ${result.findings.map((f) => f.pattern).join(", ")}`,
          };
        }
      }
    });
  }

  if (secConfig.toolGuard?.enabled !== false) {
    api.on("before_tool_call", async (ctx: any) => {
      const role = ctx.agentRole ?? ctx.senderRole ?? "agent";
      const approval = guard.checkApproval(ctx.toolName, ctx.args ?? {}, role);
      if (approval) {
        log.info(`[security] Tool guard: ${ctx.toolName} requires approval for role "${role}"`);
        ctx.meta = ctx.meta ?? {};
        ctx.meta.pendingApproval = approval;
      }
    });
  }

  log.info(
    "[security] Security module initialized (injection scanner + tool guard + URL validator)",
  );
}

export { InjectionScanner } from "./injection-scanner.js";
export { ToolGuard } from "./tool-guard.js";
export { UrlValidator } from "./url-validator.js";
