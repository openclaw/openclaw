/**
 * Configuration Security Auditor
 *
 * Checks OpenClaw configuration against security best practices.
 * Ported from openclaw-security-guard by Miloud Belarebia.
 *
 * @see https://github.com/miloudbelarebia/openclaw-security-guard
 * @author Miloud Belarebia <https://2pidata.com>
 * @license MIT
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";

export type AuditFinding = {
  ruleId: string;
  category: string;
  severity: "critical" | "high" | "medium" | "low";
  message: string;
  detail: string;
  fix: string;
};

type AuditRule = {
  id: string;
  category: string;
  severity: "critical" | "high" | "medium" | "low";
  check: (config: OpenClawConfig) => boolean;
  message: string;
  detail: string;
  fix: string;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const asAny = (config: OpenClawConfig): any => config as any;

const SECURITY_RULES: AuditRule[] = [
  // Gateway
  {
    id: "gateway-bind",
    category: "gateway",
    severity: "critical",
    check: (c) => {
      const bind = asAny(c).gateway?.bind;
      return bind === "loopback" || bind === "127.0.0.1" || !bind;
    },
    message: "Gateway should bind to loopback only",
    detail: "Binding to 0.0.0.0 or a public IP exposes the gateway to the network",
    fix: 'Set gateway.bind to "loopback"',
  },
  {
    id: "gateway-auth-token",
    category: "gateway",
    severity: "high",
    check: (c) => {
      const gw = asAny(c).gateway;
      return !!gw?.auth?.token || gw?.bind === "loopback";
    },
    message: "Gateway should have authentication token configured",
    detail: "Without a token, anyone on the network can connect",
    fix: "Set gateway.auth.token or use loopback binding",
  },

  // Sandbox
  {
    id: "sandbox-mode",
    category: "sandbox",
    severity: "critical",
    check: (c) => asAny(c).agents?.defaults?.sandbox?.mode === "always",
    message: 'Sandbox mode should be "always"',
    detail: "Without sandboxing, the agent can run arbitrary commands on the host",
    fix: 'Set agents.defaults.sandbox.mode to "always"',
  },

  // Channel DM policies
  {
    id: "whatsapp-dm-policy",
    category: "channels",
    severity: "critical",
    check: (c) => asAny(c).channels?.whatsapp?.dmPolicy !== "open",
    message: 'WhatsApp DM policy should not be "open"',
    detail: "Open DM policy allows anyone to interact with your assistant",
    fix: 'Set channels.whatsapp.dmPolicy to "pairing"',
  },
  {
    id: "telegram-dm-policy",
    category: "channels",
    severity: "critical",
    check: (c) => asAny(c).channels?.telegram?.dmPolicy !== "open",
    message: 'Telegram DM policy should not be "open"',
    detail: "Open DM policy allows anyone to interact with your bot",
    fix: 'Set channels.telegram.dmPolicy to "pairing"',
  },
  {
    id: "discord-dm-policy",
    category: "channels",
    severity: "critical",
    check: (c) => asAny(c).channels?.discord?.dm?.policy !== "open",
    message: 'Discord DM policy should not be "open"',
    detail: "Open DM policy allows anyone to DM your bot",
    fix: 'Set channels.discord.dm.policy to "pairing"',
  },

  // Elevated mode
  {
    id: "elevated-disabled",
    category: "tools",
    severity: "high",
    check: (c) => asAny(c).agents?.defaults?.tools?.elevated?.enabled !== true,
    message: "Elevated mode should be disabled by default",
    detail: "Elevated mode grants additional system permissions",
    fix: "Set agents.defaults.tools.elevated.enabled to false",
  },

  // Rate limiting
  {
    id: "rate-limiting",
    category: "security",
    severity: "medium",
    check: (c) => asAny(c).gateway?.auth?.rateLimit?.maxAttempts !== undefined,
    message: "Gateway auth rate limiting should be configured",
    detail: "Without rate limiting, brute force attacks are easier",
    fix: "Configure gateway.auth.rateLimit.maxAttempts",
  },
];

/**
 * Run all security rules against the current config.
 */
export function auditConfig(config: OpenClawConfig): {
  findings: AuditFinding[];
  score: number;
  summary: { critical: number; high: number; medium: number; low: number };
} {
  const findings: AuditFinding[] = [];
  const summary = { critical: 0, high: 0, medium: 0, low: 0 };

  for (const rule of SECURITY_RULES) {
    if (!rule.check(config)) {
      findings.push({
        ruleId: rule.id,
        category: rule.category,
        severity: rule.severity,
        message: rule.message,
        detail: rule.detail,
        fix: rule.fix,
      });
      summary[rule.severity]++;
    }
  }

  // Calculate score
  let score = 100;
  score -= summary.critical * 15;
  score -= summary.high * 7;
  score -= summary.medium * 3;
  score -= summary.low * 1;

  return {
    findings,
    score: Math.max(0, Math.min(100, score)),
    summary,
  };
}
