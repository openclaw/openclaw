import type { ClaworksRobotConfig } from "@claworks/runtime";
import type { OpenClawPluginSecurityAuditCollector } from "openclaw/plugin-sdk/plugin-entry";

type Finding = {
  checkId: string;
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
  remediation?: string;
};

export function createClaworksRobotSecurityAuditCollector(
  readConfig: () => ClaworksRobotConfig | undefined,
): OpenClawPluginSecurityAuditCollector {
  return () => {
    const cfg = readConfig() ?? {};
    const findings: Finding[] = [];
    const apiKey = cfg.api?.api_key?.trim();
    const requireKey =
      cfg.api?.require_api_key === true ||
      cfg.security?.require_api_key === true ||
      process.env.CLAWORKS_REQUIRE_API_KEY === "1";

    if (!apiKey) {
      findings.push({
        checkId: "claworks.rest.api_key_missing",
        severity: requireKey ? "critical" : "warn",
        title: "ClaWorks REST API key is not configured",
        detail:
          "plugins.entries.claworks-robot.config.api.api_key is empty. Unauthenticated REST callers are treated as system/local.",
        remediation:
          "Run `pnpm claworks:init` with CLAWORKS_INIT_SECURE=1 or set plugins.entries.claworks-robot.config.api.api_key and gateway.auth token.",
      });
    }

    if (requireKey && !apiKey) {
      findings.push({
        checkId: "claworks.rest.require_key_without_secret",
        severity: "critical",
        title: "ClaWorks requires API key but none is configured",
        detail:
          "api.require_api_key is true while api.api_key is missing — all REST writes will be denied.",
        remediation: "Set api.api_key in claworks-robot plugin config.",
      });
    }

    if (cfg.a2a?.enabled && (!cfg.a2a.peers || cfg.a2a.peers.length === 0)) {
      findings.push({
        checkId: "claworks.a2a.peers_empty",
        severity: "info",
        title: "A2A enabled without configured peers",
        detail: "Robot exposes /a2a but no peers are listed for outbound delegation.",
      });
    }

    for (const peer of cfg.a2a?.peers ?? []) {
      const url = peer.url?.trim() ?? "";
      if (url.startsWith("http://") && !url.includes("127.0.0.1") && !url.includes("localhost")) {
        findings.push({
          checkId: "claworks.a2a.peer_plain_http",
          severity: "warn",
          title: `A2A peer "${peer.name}" uses plain HTTP`,
          detail: `Peer URL ${url} is not TLS-protected.`,
          remediation: "Use https:// for production A2A peers.",
        });
      }
    }

    if (cfg.im_bridge?.auto_on_message_received && !apiKey) {
      findings.push({
        checkId: "claworks.im_bridge.auto_without_api_key",
        severity: "warn",
        title: "IM auto-bridge enabled without REST API key",
        detail:
          "Every inbound channel message is routed into EventKernel while REST remains in open local mode.",
        remediation:
          "Configure api.api_key before enabling im_bridge.auto_on_message_received in production.",
      });
    }

    return findings;
  };
}
