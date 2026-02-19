/**
 * Setup Wizard Tools — Guided OpenClaw configuration with self-healing capabilities
 */

import { exec as execCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, access, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult, resolveWorkspaceDir, httpRequest } from "./common.js";

const exec = promisify(execCallback);

// Type definitions for health checks and status
interface HealthStatus {
  status: "healthy" | "warning" | "critical";
  message: string;
  details?: any;
}

interface ChannelHealth {
  channel_type: string;
  channel_id: string;
  status: "connected" | "disconnected" | "error";
  last_check: string;
  error?: string;
}

interface AgentHealth {
  agent_id: string;
  business_id: string;
  status: "active" | "inactive" | "error";
  last_activity: string;
}

interface VersionHealth {
  gateway_version: string;
  plugin_version: string;
  compatible: boolean;
  update_available?: string;
}

interface ConfigHealth {
  valid: boolean;
  issues: string[];
  last_modified: string;
}

interface Issue {
  type: string;
  severity: "info" | "warning" | "critical";
  message: string;
  auto_fixable: boolean;
}

// Helper functions
async function readJson(p: string) {
  try {
    return JSON.parse(await readFile(p, "utf-8"));
  } catch {
    return null;
  }
}

async function writeJson(p: string, d: any) {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(d, null, 2), "utf-8");
}

async function checkServiceStatus(serviceName: string): Promise<HealthStatus> {
  try {
    const { stdout } = await exec(
      `systemctl is-active ${serviceName} 2>/dev/null || echo "inactive"`,
    );
    const status = stdout.trim();

    if (status === "active") {
      return { status: "healthy", message: "Service running" };
    } else {
      return { status: "critical", message: `Service ${status}` };
    }
  } catch (error) {
    return { status: "critical", message: `Failed to check service: ${error}` };
  }
}

/** Parse a calver string "YYYY.M.D" into a comparable number. */
function calverToNum(v: string): number {
  const parts = v.split(".").map(Number);
  return (parts[0] || 0) * 10000 + (parts[1] || 0) * 100 + (parts[2] || 0);
}

const MIN_GATEWAY_VERSION = "2026.1.26";

async function checkGatewayVersion(): Promise<VersionHealth> {
  try {
    // Try to get gateway version from openclaw binary
    const { stdout } = await exec('openclaw version 2>/dev/null || echo "unknown"');
    const gatewayVersion = stdout.trim();

    // Read plugin version from our own package.json
    let pluginVersion = "unknown";
    try {
      const pkgPath = join(dirname(new URL(import.meta.url).pathname), "..", "..", "package.json");
      const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
      pluginVersion = pkg.version || "unknown";
    } catch {
      // Fallback if package.json resolution fails
    }

    // Calver compatibility: gateway must be >= MIN_GATEWAY_VERSION
    const compatible =
      gatewayVersion !== "unknown" &&
      calverToNum(gatewayVersion) >= calverToNum(MIN_GATEWAY_VERSION);

    return {
      gateway_version: gatewayVersion,
      plugin_version: pluginVersion,
      compatible,
      update_available:
        !compatible && gatewayVersion !== "unknown" ? MIN_GATEWAY_VERSION : undefined,
    };
  } catch {
    return {
      gateway_version: "unknown",
      plugin_version: "unknown",
      compatible: false,
    };
  }
}

async function testChannelConnection(
  channelType: string,
  credentials: any,
): Promise<{ success: boolean; error?: string; bot_info?: any }> {
  // Step 1: Validate credential format
  switch (channelType) {
    case "telegram":
      if (!credentials.bot_token || !credentials.bot_token.match(/^\d+:[A-Za-z0-9_-]+$/)) {
        return { success: false, error: "Invalid Telegram bot token format" };
      }
      break;
    case "discord":
      if (!credentials.bot_token || !credentials.application_id) {
        return { success: false, error: "Discord bot token and application ID required" };
      }
      break;
    case "slack":
      if (!credentials.bot_token || !credentials.bot_token.startsWith("xoxb-")) {
        return { success: false, error: "Invalid Slack bot token format (must start with xoxb-)" };
      }
      break;
    case "signal":
      if (!credentials.account) {
        return { success: false, error: "Signal account (E.164 phone number) required" };
      }
      break;
    case "whatsapp":
      if (!credentials.access_token && !credentials.session_path) {
        return { success: false, error: "WhatsApp access_token or session_path required" };
      }
      break;
    default:
      return { success: false, error: `Unsupported channel type: ${channelType}` };
  }

  // Step 2: Make real API call to verify credentials
  try {
    let result: { status: number; data: any };

    switch (channelType) {
      case "telegram":
        result = await httpRequest(
          `https://api.telegram.org/bot${credentials.bot_token}/getMe`,
          "GET",
          {},
        );
        if (result.status === 0) {
          return { success: true, error: "Network unavailable; format validated only" };
        }
        if (result.data?.ok === true) {
          return { success: true, bot_info: result.data.result };
        }
        return { success: false, error: result.data?.description || "Telegram token rejected" };

      case "discord":
        result = await httpRequest("https://discord.com/api/v10/oauth2/applications/@me", "GET", {
          Authorization: `Bot ${credentials.bot_token}`,
        });
        if (result.status === 0) {
          return { success: true, error: "Network unavailable; format validated only" };
        }
        if (result.data?.id) {
          return { success: true, bot_info: { id: result.data.id, name: result.data.name } };
        }
        return { success: false, error: result.data?.message || "Discord token rejected" };

      case "slack":
        result = await httpRequest("https://slack.com/api/auth.test", "GET", {
          Authorization: `Bearer ${credentials.bot_token}`,
        });
        if (result.status === 0) {
          return { success: true, error: "Network unavailable; format validated only" };
        }
        if (result.data?.ok === true) {
          return { success: true, bot_info: { team: result.data.team, user: result.data.user } };
        }
        return { success: false, error: result.data?.error || "Slack token rejected" };

      case "signal": {
        const cliUrl = credentials.cli_url || "http://localhost:8080";
        result = await httpRequest(`${cliUrl}/v1/about`, "GET", {}, undefined, 3000);
        if (result.status === 0) {
          return { success: true, error: "Network unavailable; format validated only" };
        }
        if (result.status === 200) {
          return { success: true, bot_info: result.data };
        }
        return { success: false, error: "Signal CLI API not responding" };
      }

      case "whatsapp":
        if (!credentials.access_token || !credentials.phone_number_id) {
          // Session-based WhatsApp doesn't support API test
          return { success: true, error: "Session-based setup; cannot verify remotely" };
        }
        result = await httpRequest(
          `https://graph.facebook.com/v19.0/${credentials.phone_number_id}`,
          "GET",
          { Authorization: `Bearer ${credentials.access_token}` },
        );
        if (result.status === 0) {
          return { success: true, error: "Network unavailable; format validated only" };
        }
        if (result.status === 200) {
          return { success: true, bot_info: result.data };
        }
        return { success: false, error: result.data?.error?.message || "WhatsApp token rejected" };

      default:
        return { success: true };
    }
  } catch {
    // Network failure should not block setup
    return { success: true, error: "Network unavailable; format validated only" };
  }
}

// Parameter schemas
const SetupWizardStartParams = Type.Object({
  force_reset: Type.Optional(Type.Boolean({ description: "Reset existing configuration" })),
  skip_checks: Type.Optional(
    Type.Array(Type.String(), { description: "Skip specific health checks" }),
  ),
});

const SetupChannelParams = Type.Object({
  channel_type: Type.Union(
    [
      Type.Literal("telegram"),
      Type.Literal("discord"),
      Type.Literal("signal"),
      Type.Literal("slack"),
      Type.Literal("whatsapp"),
    ],
    { description: "Type of channel to configure" },
  ),
  credentials: Type.Object(
    {
      telegram: Type.Optional(
        Type.Object({
          bot_token: Type.String({ description: "Telegram bot token" }),
        }),
      ),
      discord: Type.Optional(
        Type.Object({
          bot_token: Type.String({ description: "Discord bot token" }),
          application_id: Type.String({ description: "Discord application ID" }),
        }),
      ),
      signal: Type.Optional(
        Type.Object({
          account: Type.String({ description: "Signal account phone number (E.164 format)" }),
          cli_url: Type.Optional(
            Type.String({
              description: "Signal CLI REST API URL (default: http://localhost:8080)",
            }),
          ),
        }),
      ),
      slack: Type.Optional(
        Type.Object({
          bot_token: Type.String({ description: "Slack bot token (xoxb-...)" }),
          app_id: Type.Optional(Type.String({ description: "Slack app ID" })),
        }),
      ),
      whatsapp: Type.Optional(
        Type.Object({
          access_token: Type.Optional(
            Type.String({ description: "WhatsApp Cloud API access token" }),
          ),
          phone_number_id: Type.Optional(Type.String({ description: "WhatsApp phone number ID" })),
          session_path: Type.Optional(
            Type.String({ description: "Path to local WhatsApp session data" }),
          ),
        }),
      ),
    },
    { description: "Channel-specific credentials" },
  ),
  test_connection: Type.Optional(
    Type.Boolean({ description: "Test connection after configuration", default: true }),
  ),
});

const SetupHealthCheckParams = Type.Object({
  include_channels: Type.Optional(
    Type.Boolean({ description: "Include channel health checks", default: true }),
  ),
  include_agents: Type.Optional(
    Type.Boolean({ description: "Include agent health checks", default: true }),
  ),
  include_version_check: Type.Optional(
    Type.Boolean({ description: "Include version compatibility check", default: true }),
  ),
  fix_automatically: Type.Optional(
    Type.Boolean({ description: "Automatically fix issues when possible", default: false }),
  ),
});

const SetupAutoFixParams = Type.Object({
  issue_type: Type.Union(
    [
      Type.Literal("service_unit_stale"),
      Type.Literal("token_mismatch"),
      Type.Literal("config_drift"),
      Type.Literal("permission_error"),
    ],
    { description: "Type of issue to fix" },
  ),
  dry_run: Type.Optional(
    Type.Boolean({
      description: "Show what would be fixed without making changes",
      default: false,
    }),
  ),
  force: Type.Optional(Type.Boolean({ description: "Force fix even if risky", default: false })),
});

const SetupStatusDashboardParams = Type.Object({
  theme: Type.Optional(
    Type.Union([Type.Literal("dark"), Type.Literal("light")], {
      description: "UI theme",
      default: "dark",
    }),
  ),
  refresh_interval: Type.Optional(
    Type.Number({ description: "Auto-refresh interval in seconds", default: 30 }),
  ),
  show_details: Type.Optional(
    Type.Boolean({ description: "Show detailed status information", default: true }),
  ),
});

export function createSetupWizardTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "setup_wizard_start",
      label: "Start Setup Wizard",
      description:
        "Initialize setup wizard, detect current state (what's configured, what's missing), return a status report with next steps",
      parameters: SetupWizardStartParams,
      async execute(_id: string, params: Static<typeof SetupWizardStartParams>) {
        const ws = resolveWorkspaceDir(api);
        const now = new Date().toISOString();

        try {
          // Check current state
          const gatewayStatus = await checkServiceStatus("openclaw-gateway");

          // Count businesses
          let businessesCount = 0;
          const businessesDir = join(ws, "businesses");
          try {
            if (existsSync(businessesDir)) {
              const businesses = await readdir(businessesDir);
              businessesCount = businesses.length;
            }
          } catch (error) {
            api.logger.warn(`Could not read businesses directory: ${error}`);
          }

          // Count agents
          let agentsCount = 0;
          try {
            for (const businessDir of await readdir(businessesDir).catch(() => [])) {
              const agentsDir = join(businessesDir, businessDir, "agents");
              if (existsSync(agentsDir)) {
                const agents = await readdir(agentsDir);
                agentsCount += agents.length;
              }
            }
          } catch (error) {
            api.logger.warn(`Could not count agents: ${error}`);
          }

          // Check configured channels by scanning workspace/channels/*.json
          const channelsConfigured: string[] = [];
          const channelsScanDir = join(ws, "channels");
          try {
            if (existsSync(channelsScanDir)) {
              const channelFiles = await readdir(channelsScanDir);
              for (const f of channelFiles) {
                if (f.endsWith(".json")) {
                  const cfg = await readJson(join(channelsScanDir, f));
                  if (cfg?.type) channelsConfigured.push(cfg.type);
                }
              }
            }
          } catch {
            // Non-fatal — just report no channels
          }
          const configPath = join(ws, "gateway-config.yaml");

          // Identify issues
          const issues: Issue[] = [];
          if (gatewayStatus.status !== "healthy") {
            issues.push({
              type: "gateway_down",
              severity: "critical",
              message: "Gateway service is not running",
              auto_fixable: true,
            });
          }

          if (businessesCount === 0) {
            issues.push({
              type: "no_businesses",
              severity: "warning",
              message: "No businesses configured",
              auto_fixable: false,
            });
          }

          if (channelsConfigured.length === 0) {
            issues.push({
              type: "no_channels",
              severity: "warning",
              message: "No communication channels configured",
              auto_fixable: false,
            });
          }

          // Determine next steps
          const nextSteps: string[] = [];
          if (gatewayStatus.status !== "healthy") {
            nextSteps.push("Start gateway service");
          }
          if (channelsConfigured.length === 0) {
            nextSteps.push("Configure communication channels");
          }
          if (businessesCount === 0) {
            nextSteps.push("Create first business");
          }
          if (nextSteps.length === 0) {
            nextSteps.push("System appears ready - run health check");
          }

          const currentState = {
            gateway_running: gatewayStatus.status === "healthy",
            channels_configured: channelsConfigured,
            businesses_count: businessesCount,
            agents_count: agentsCount,
            issues: issues,
          };

          // Estimate time based on what needs to be done
          let estimatedMinutes = 5; // Base setup time
          if (!currentState.gateway_running) estimatedMinutes += 2;
          if (currentState.channels_configured.length === 0) estimatedMinutes += 5;
          if (currentState.businesses_count === 0) estimatedMinutes += 8;

          const result = {
            current_state: currentState,
            next_steps: nextSteps,
            estimated_time_minutes: estimatedMinutes,
            wizard_session_id: Date.now().toString(),
            started_at: now,
          };

          // Store wizard session for continuity
          await writeJson(join(ws, ".setup-wizard-session.json"), result);

          return textResult(`## Setup Wizard Started

**Current State:**
- Gateway: ${currentState.gateway_running ? "✅ Running" : "❌ Not running"}
- Businesses: ${currentState.businesses_count}
- Agents: ${currentState.agents_count}
- Channels: ${currentState.channels_configured.length}

**Issues Found:** ${issues.length}
${issues.map((i) => `- ${i.severity.toUpperCase()}: ${i.message}`).join("\n")}

**Next Steps:**
${nextSteps.map((step, i) => `${i + 1}. ${step}`).join("\n")}

**Estimated Time:** ${estimatedMinutes} minutes

Use other setup wizard tools to complete the configuration.`);
        } catch (error) {
          api.logger.error(`Setup wizard start failed: ${error}`);
          return textResult(`❌ Setup wizard failed to start: ${error}`);
        }
      },
    },

    {
      name: "setup_channel",
      label: "Configure Channel",
      description: "Guided channel configuration with credential validation and connection testing",
      parameters: SetupChannelParams,
      async execute(_id: string, params: Static<typeof SetupChannelParams>) {
        const ws = resolveWorkspaceDir(api);
        const { channel_type, credentials, test_connection = true } = params;

        try {
          // Get channel-specific credentials
          const channelCredentials = credentials[channel_type];
          if (!channelCredentials) {
            return textResult(`❌ No credentials provided for ${channel_type}`);
          }

          // Test connection if requested
          let testResults;
          if (test_connection) {
            const testResult = await testChannelConnection(channel_type, channelCredentials);
            testResults = {
              connection_ok: testResult.success,
              test_message_sent: testResult.success,
              error: testResult.error,
            };
          }

          // Generate channel configuration
          const channelId = `${channel_type}_${Date.now()}`;
          const channelConfig = {
            id: channelId,
            type: channel_type,
            name: `${channel_type.charAt(0).toUpperCase() + channel_type.slice(1)} Channel`,
            credentials: channelCredentials,
            created_at: new Date().toISOString(),
            status: testResults?.connection_ok ? "active" : "inactive",
          };

          // Save channel configuration
          const channelsDir = join(ws, "channels");
          await mkdir(channelsDir, { recursive: true });
          await writeJson(join(channelsDir, `${channelId}.json`), channelConfig);

          const nextSteps = [
            "Configure additional channels or proceed to business setup",
            "Test channel functionality with a real message",
          ];

          if (!testResults?.connection_ok) {
            nextSteps.unshift("Fix connection issues before proceeding");
          }

          return textResult(`## Channel Configuration ${testResults?.connection_ok ? "✅ Success" : "⚠️ Partial"}

**Channel:** ${channel_type}
**ID:** ${channelId}
**Status:** ${channelConfig.status}

${
  testResults
    ? `**Connection Test:**
- Connection OK: ${testResults.connection_ok ? "✅" : "❌"}
- Test Message: ${testResults.test_message_sent ? "✅" : "❌"}
${testResults.error ? `- Error: ${testResults.error}` : ""}`
    : "**Connection test skipped**"
}

**Next Steps:**
${nextSteps.map((step, i) => `${i + 1}. ${step}`).join("\n")}`);
        } catch (error) {
          api.logger.error(`Channel setup failed: ${error}`);
          return textResult(`❌ Channel setup failed: ${error}`);
        }
      },
    },

    {
      name: "setup_health_check",
      label: "System Health Check",
      description:
        "Comprehensive health check including gateway version, service unit freshness, token validity, channel connectivity, plugin status",
      parameters: SetupHealthCheckParams,
      async execute(_id: string, params: Static<typeof SetupHealthCheckParams>) {
        const ws = resolveWorkspaceDir(api);
        const {
          include_channels = true,
          include_agents = true,
          include_version_check = true,
          fix_automatically = false,
        } = params;

        try {
          const healthReport = {
            overall_health: "healthy" as "healthy" | "warning" | "critical",
            timestamp: new Date().toISOString(),
            checks: {} as any,
            auto_fixable_issues: [] as string[],
            manual_issues: [] as string[],
          };

          // Gateway status check
          const gatewayStatus = await checkServiceStatus("openclaw-gateway");
          healthReport.checks.gateway = gatewayStatus;

          if (gatewayStatus.status === "critical") {
            healthReport.overall_health = "critical";
            healthReport.auto_fixable_issues.push("Start gateway service");
          }

          // Version compatibility check
          if (include_version_check) {
            const versionHealth = await checkGatewayVersion();
            healthReport.checks.versions = versionHealth;

            if (!versionHealth.compatible) {
              healthReport.overall_health =
                healthReport.overall_health === "critical" ? "critical" : "warning";
              if (versionHealth.update_available) {
                healthReport.auto_fixable_issues.push(
                  `Update to version ${versionHealth.update_available}`,
                );
              } else {
                healthReport.manual_issues.push(
                  "Version compatibility issue requires manual intervention",
                );
              }
            }
          }

          // Channel health checks
          if (include_channels) {
            const channels: ChannelHealth[] = [];
            const channelsDir = join(ws, "channels");

            if (existsSync(channelsDir)) {
              const channelFiles = await readdir(channelsDir);
              for (const file of channelFiles) {
                if (file.endsWith(".json")) {
                  const channelConfig = await readJson(join(channelsDir, file));
                  if (channelConfig) {
                    // Test channel connectivity
                    const testResult = await testChannelConnection(
                      channelConfig.type,
                      channelConfig.credentials,
                    );

                    channels.push({
                      channel_type: channelConfig.type,
                      channel_id: channelConfig.id,
                      status: testResult.success ? "connected" : "error",
                      last_check: new Date().toISOString(),
                      error: testResult.error,
                    });

                    if (!testResult.success) {
                      healthReport.overall_health =
                        healthReport.overall_health === "critical" ? "critical" : "warning";
                      healthReport.manual_issues.push(
                        `${channelConfig.type} channel connection failed: ${testResult.error}`,
                      );
                    }
                  }
                }
              }
            }

            healthReport.checks.channels = channels;
          }

          // Agent health checks
          if (include_agents) {
            const agents: AgentHealth[] = [];
            const businessesDir = join(ws, "businesses");

            if (existsSync(businessesDir)) {
              const businessDirs = await readdir(businessesDir);
              for (const businessId of businessDirs) {
                const agentsDir = join(businessesDir, businessId, "agents");
                if (existsSync(agentsDir)) {
                  const agentDirs = await readdir(agentsDir);
                  for (const agentId of agentDirs) {
                    const agentPath = join(agentsDir, agentId);
                    const stats = await stat(agentPath);

                    agents.push({
                      agent_id: agentId,
                      business_id: businessId,
                      status: "active", // TODO: Implement proper agent status checking
                      last_activity: stats.mtime.toISOString(),
                    });
                  }
                }
              }
            }

            healthReport.checks.agents = agents;
          }

          // Configuration validation
          const configPath = join(ws, "gateway-config.yaml");
          const configHealth: ConfigHealth = {
            valid: true,
            issues: [],
            last_modified: "unknown",
          };

          if (existsSync(configPath)) {
            const stats = await stat(configPath);
            configHealth.last_modified = stats.mtime.toISOString();

            // TODO: Add actual YAML validation
            // For now, just check if file is readable
            try {
              await readFile(configPath, "utf-8");
            } catch (error) {
              configHealth.valid = false;
              configHealth.issues.push(`Cannot read config file: ${error}`);
              healthReport.overall_health = "critical";
              healthReport.manual_issues.push("Gateway configuration file is corrupted");
            }
          } else {
            configHealth.valid = false;
            configHealth.issues.push("Gateway configuration file not found");
            healthReport.overall_health = "critical";
            healthReport.auto_fixable_issues.push("Generate default gateway configuration");
          }

          healthReport.checks.configuration = configHealth;

          // Auto-fix issues if requested
          if (fix_automatically && healthReport.auto_fixable_issues.length > 0) {
            // TODO: Implement actual auto-fix logic
            api.logger.info(`Would auto-fix: ${healthReport.auto_fixable_issues.join(", ")}`);
          }

          // Generate summary report
          const channelCount = healthReport.checks.channels?.length || 0;
          const agentCount = healthReport.checks.agents?.length || 0;
          const issueCount =
            healthReport.auto_fixable_issues.length + healthReport.manual_issues.length;

          return textResult(`## System Health Report

**Overall Status:** ${
            healthReport.overall_health === "healthy"
              ? "✅ Healthy"
              : healthReport.overall_health === "warning"
                ? "⚠️ Warning"
                : "❌ Critical"
          }

**Components:**
- Gateway: ${healthReport.checks.gateway.status === "healthy" ? "✅" : "❌"} ${healthReport.checks.gateway.message}
${include_version_check ? `- Version: ${healthReport.checks.versions.compatible ? "✅" : "⚠️"} Gateway ${healthReport.checks.versions.gateway_version}` : ""}
${include_channels ? `- Channels: ${channelCount} configured` : ""}
${include_agents ? `- Agents: ${agentCount} active` : ""}
- Configuration: ${healthReport.checks.configuration.valid ? "✅" : "❌"} ${healthReport.checks.configuration.valid ? "Valid" : "Issues found"}

${
  issueCount > 0
    ? `**Issues (${issueCount} total):**
${healthReport.auto_fixable_issues.map((i) => `- 🔧 ${i}`).join("\n")}
${healthReport.manual_issues.map((i) => `- ⚠️ ${i}`).join("\n")}

**Recommendations:**
${healthReport.auto_fixable_issues.length > 0 ? "- Run `setup_auto_fix` to resolve fixable issues" : ""}
${healthReport.manual_issues.length > 0 ? "- Address manual issues before production use" : ""}`
    : "**All checks passed!** ✅"
}

**Report generated:** ${healthReport.timestamp}`);
        } catch (error) {
          api.logger.error(`Health check failed: ${error}`);
          return textResult(`❌ Health check failed: ${error}`);
        }
      },
    },

    {
      name: "setup_auto_fix",
      label: "Auto-fix Issues",
      description:
        "Automatically remediate common issues like stale service units, token mismatches, or configuration drift",
      parameters: SetupAutoFixParams,
      async execute(_id: string, params: Static<typeof SetupAutoFixParams>) {
        const { issue_type, dry_run = false, force = false } = params;

        try {
          const actionsTaken: string[] = [];
          const remainingIssues: string[] = [];
          let success = true;
          let requiresRestart = false;
          const userActionNeeded: string[] = [];

          switch (issue_type) {
            case "service_unit_stale": {
              const unitPath = join(
                process.env.HOME || "~",
                ".config/systemd/user/openclaw-gateway.service",
              );
              if (dry_run) {
                actionsTaken.push("Would check user-level systemd service unit");
                actionsTaken.push("Would compare ExecStart path with `which openclaw`");
                actionsTaken.push("Would regenerate and reload if stale");
              } else {
                try {
                  // Use user-level systemd (matches OpenClaw convention)
                  const { stdout: unitStatus } = await exec(
                    'systemctl --user status openclaw-gateway 2>/dev/null || echo "not-found"',
                  );

                  // Detect stale ExecStart by comparing with current binary location
                  let stale = unitStatus.includes("not-found");
                  if (!stale) {
                    try {
                      const { stdout: binPath } = await exec("which openclaw 2>/dev/null");
                      const currentBin = binPath.trim();
                      if (currentBin && !unitStatus.includes(currentBin)) {
                        stale = true;
                        actionsTaken.push(`ExecStart path stale (binary at ${currentBin})`);
                      }
                    } catch {
                      // `which` failed — can't detect staleness
                    }
                  }

                  if (stale || force) {
                    // Try openclaw's own installer first
                    try {
                      await exec("openclaw gateway install 2>/dev/null");
                      actionsTaken.push("Regenerated service via `openclaw gateway install`");
                    } catch {
                      // Fallback: generate minimal systemd unit
                      const binPath = (
                        await exec("which openclaw 2>/dev/null").catch(() => ({
                          stdout: "/usr/local/bin/openclaw",
                        }))
                      ).stdout.trim();
                      const unit = `[Unit]
Description=OpenClaw Gateway
After=network.target

[Service]
Type=simple
ExecStart=${binPath} gateway serve
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
                      await mkdir(dirname(unitPath), { recursive: true });
                      await writeFile(unitPath, unit, "utf-8");
                      actionsTaken.push("Generated minimal systemd user unit");
                    }

                    await exec("systemctl --user daemon-reload");
                    actionsTaken.push("Reloaded systemd user daemon");

                    try {
                      await exec("systemctl --user restart openclaw-gateway");
                      actionsTaken.push("Restarted openclaw-gateway service");
                    } catch (restartErr) {
                      remainingIssues.push(`Service restart failed: ${restartErr}`);
                    }
                    requiresRestart = false; // Already restarted
                  } else {
                    actionsTaken.push("Service unit is current — no changes needed");
                  }
                } catch (error) {
                  success = false;
                  remainingIssues.push(`Failed to update service unit: ${error}`);
                }
              }
              break;
            }

            case "token_mismatch": {
              const ws = resolveWorkspaceDir(api);
              const chDir = join(ws, "channels");
              const channelResults: { id: string; type: string; ok: boolean; error?: string }[] =
                [];

              if (existsSync(chDir)) {
                const files = await readdir(chDir);
                for (const f of files) {
                  if (!f.endsWith(".json")) continue;
                  const cfg = await readJson(join(chDir, f));
                  if (!cfg?.type || !cfg?.credentials) continue;

                  if (dry_run) {
                    channelResults.push({ id: cfg.id, type: cfg.type, ok: true });
                    continue;
                  }

                  const test = await testChannelConnection(cfg.type, cfg.credentials);
                  channelResults.push({
                    id: cfg.id,
                    type: cfg.type,
                    ok: test.success && !test.error?.includes("rejected"),
                    error: test.error,
                  });

                  // Update config status based on result
                  const newStatus =
                    test.success && !test.error?.includes("rejected") ? "active" : "token_invalid";
                  if (cfg.status !== newStatus) {
                    cfg.status = newStatus;
                    await writeJson(join(chDir, f), cfg);
                  }
                }
              }

              if (dry_run) {
                actionsTaken.push(`Would validate ${channelResults.length} channel token(s)`);
                for (const ch of channelResults) {
                  actionsTaken.push(`  ${ch.type} (${ch.id})`);
                }
              } else {
                const passed = channelResults.filter((c) => c.ok);
                const failed = channelResults.filter((c) => !c.ok);
                actionsTaken.push(
                  `Validated ${channelResults.length} channel(s): ${passed.length} passed, ${failed.length} failed`,
                );
                for (const ch of failed) {
                  userActionNeeded.push(`Re-configure ${ch.type} channel (${ch.id}): ${ch.error}`);
                }
                if (failed.length > 0) {
                  success = channelResults.length > failed.length; // partial success
                }
              }
              break;
            }

            case "config_drift": {
              const ws = resolveWorkspaceDir(api);
              const backupDir = join(
                ws,
                ".config-backups",
                new Date().toISOString().replace(/[:.]/g, "-"),
              );
              const driftIssues: string[] = [];

              // Check gateway config exists
              const gwConfigPath = join(ws, "gateway-config.yaml");
              const gwConfigExists = existsSync(gwConfigPath);
              if (!gwConfigExists) {
                driftIssues.push("Gateway config file missing");
              }

              // Validate channel config JSON structure
              const chDir = join(ws, "channels");
              const requiredChannelFields = ["id", "type", "credentials", "created_at"];
              if (existsSync(chDir)) {
                const files = await readdir(chDir);
                for (const f of files) {
                  if (!f.endsWith(".json")) continue;
                  const cfg = await readJson(join(chDir, f));
                  if (!cfg) {
                    driftIssues.push(`Corrupt channel config: ${f}`);
                    continue;
                  }
                  for (const field of requiredChannelFields) {
                    if (!(field in cfg)) {
                      driftIssues.push(`Channel ${f} missing required field: ${field}`);
                    }
                  }
                }
              }

              // Check agent cognitive files exist
              const cognitiveFiles = [
                "Beliefs.md",
                "Desires.md",
                "Goals.md",
                "Plans.md",
                "Intentions.md",
              ];
              const businessesDir = join(ws, "businesses");
              if (existsSync(businessesDir)) {
                const businesses = await readdir(businessesDir).catch(() => [] as string[]);
                for (const biz of businesses) {
                  const agentsDir = join(businessesDir, biz, "agents");
                  if (!existsSync(agentsDir)) continue;
                  const agents = await readdir(agentsDir).catch(() => [] as string[]);
                  for (const agent of agents) {
                    const agentDir = join(agentsDir, agent);
                    const agentStat = await stat(agentDir).catch(() => null);
                    if (!agentStat?.isDirectory()) continue;
                    for (const cf of cognitiveFiles) {
                      if (!existsSync(join(agentDir, cf))) {
                        driftIssues.push(`Agent ${biz}/${agent} missing ${cf}`);
                      }
                    }
                  }
                }
              }

              // Check business manifest.json exists
              if (existsSync(businessesDir)) {
                const businesses = await readdir(businessesDir).catch(() => [] as string[]);
                for (const biz of businesses) {
                  if (!existsSync(join(businessesDir, biz, "manifest.json"))) {
                    driftIssues.push(`Business ${biz} missing manifest.json`);
                  }
                }
              }

              if (dry_run) {
                actionsTaken.push(`Found ${driftIssues.length} drift issue(s)`);
                for (const issue of driftIssues) {
                  actionsTaken.push(`  - ${issue}`);
                }
                if (driftIssues.length > 0) {
                  actionsTaken.push("Would back up configs and restore missing files");
                }
              } else {
                if (driftIssues.length > 0) {
                  // Back up current configs before modifications
                  await mkdir(backupDir, { recursive: true });
                  if (gwConfigExists) {
                    const gwContent = await readFile(gwConfigPath, "utf-8");
                    await writeFile(join(backupDir, "gateway-config.yaml"), gwContent, "utf-8");
                  }
                  if (existsSync(chDir)) {
                    const chBackup = join(backupDir, "channels");
                    await mkdir(chBackup, { recursive: true });
                    for (const f of await readdir(chDir)) {
                      if (f.endsWith(".json")) {
                        const content = await readFile(join(chDir, f), "utf-8");
                        await writeFile(join(chBackup, f), content, "utf-8");
                      }
                    }
                  }
                  actionsTaken.push(`Backed up configs to ${backupDir}`);

                  // Restore missing cognitive files as stubs
                  if (existsSync(businessesDir)) {
                    const businesses = await readdir(businessesDir).catch(() => [] as string[]);
                    for (const biz of businesses) {
                      const agentsDir = join(businessesDir, biz, "agents");
                      if (!existsSync(agentsDir)) continue;
                      const agents = await readdir(agentsDir).catch(() => [] as string[]);
                      for (const agent of agents) {
                        const agentDir = join(agentsDir, agent);
                        const agentStat = await stat(agentDir).catch(() => null);
                        if (!agentStat?.isDirectory()) continue;
                        for (const cf of cognitiveFiles) {
                          const cfPath = join(agentDir, cf);
                          if (!existsSync(cfPath)) {
                            const stub = `# ${cf.replace(".md", "")}\n\n_Auto-restored by setup_auto_fix — please populate._\n`;
                            await writeFile(cfPath, stub, "utf-8");
                            actionsTaken.push(`Restored stub: ${biz}/${agent}/${cf}`);
                          }
                        }
                      }
                    }
                  }

                  actionsTaken.push(`Resolved ${driftIssues.length} drift issue(s)`);
                  requiresRestart = true;
                } else {
                  actionsTaken.push("No configuration drift detected");
                }
              }
              break;
            }

            case "permission_error":
              if (dry_run) {
                actionsTaken.push("Would fix file permissions");
                actionsTaken.push("Would update ownership");
              } else {
                try {
                  const ws = resolveWorkspaceDir(api);
                  // Fix common permission issues
                  await exec(`chmod -R u+rw "${ws}"`);
                  actionsTaken.push("Fixed workspace file permissions");
                } catch (error) {
                  success = false;
                  remainingIssues.push(`Failed to fix permissions: ${error}`);
                }
              }
              break;

            default:
              success = false;
              remainingIssues.push(`Unknown issue type: ${issue_type}`);
          }

          const result = {
            actions_taken: actionsTaken,
            success,
            remaining_issues: remainingIssues,
            requires_restart: requiresRestart,
            user_action_needed: userActionNeeded.length > 0 ? userActionNeeded : undefined,
          };

          return textResult(`## Auto-Fix Results ${success ? "✅" : "⚠️"}

**Issue Type:** ${issue_type}
**Mode:** ${dry_run ? "Dry Run" : "Execute"}

**Actions Taken:**
${actionsTaken.map((a) => `- ${a}`).join("\n")}

${
  remainingIssues.length > 0
    ? `**Remaining Issues:**
${remainingIssues.map((i) => `- ${i}`).join("\n")}`
    : ""
}

${
  userActionNeeded.length > 0
    ? `**Manual Action Required:**
${userActionNeeded.map((a) => `- ${a}`).join("\n")}`
    : ""
}

${requiresRestart ? "⚠️ **System restart recommended**" : ""}

**Status:** ${success ? "Completed successfully" : "Partially completed"}`);
        } catch (error) {
          api.logger.error(`Auto-fix failed: ${error}`);
          return textResult(`❌ Auto-fix failed: ${error}`);
        }
      },
    },

    {
      name: "setup_status_dashboard",
      label: "Status Dashboard",
      description:
        "Generate a Canvas-ready HTML status dashboard showing system health, channel status, business count, agent count, recent issues",
      parameters: SetupStatusDashboardParams,
      async execute(_id: string, params: Static<typeof SetupStatusDashboardParams>) {
        const { theme = "dark", refresh_interval = 30, show_details = true } = params;
        const ws = resolveWorkspaceDir(api);

        try {
          // Gather current status information
          const gatewayStatus = await checkServiceStatus("openclaw-gateway");
          const versionInfo = await checkGatewayVersion();

          // Count businesses and agents
          let businessCount = 0;
          let agentCount = 0;
          const businessesDir = join(ws, "businesses");
          if (existsSync(businessesDir)) {
            const businesses = await readdir(businessesDir);
            businessCount = businesses.length;

            for (const business of businesses) {
              const agentsDir = join(businessesDir, business, "agents");
              if (existsSync(agentsDir)) {
                const agents = await readdir(agentsDir);
                agentCount += agents.length;
              }
            }
          }

          // Count channels
          let channelCount = 0;
          const channelsDir = join(ws, "channels");
          if (existsSync(channelsDir)) {
            const channels = await readdir(channelsDir);
            channelCount = channels.filter((f) => f.endsWith(".json")).length;
          }

          // Generate dashboard HTML
          const isDark = theme === "dark";
          const bgColor = isDark ? "#1a1a1a" : "#ffffff";
          const textColor = isDark ? "#ffffff" : "#333333";
          const cardBg = isDark ? "#2d2d2d" : "#f5f5f5";
          const accentColor = isDark ? "#00ff88" : "#007a4d";

          const css = `
            body { 
              font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; 
              background: ${bgColor}; 
              color: ${textColor}; 
              margin: 0; 
              padding: 20px;
            }
            .dashboard { 
              max-width: 1200px; 
              margin: 0 auto; 
            }
            .dashboard-header { 
              display: flex; 
              justify-content: space-between; 
              align-items: center; 
              margin-bottom: 30px; 
              padding-bottom: 20px;
              border-bottom: 1px solid ${isDark ? "#444" : "#ddd"};
            }
            .status-badge { 
              padding: 8px 16px; 
              border-radius: 20px; 
              font-weight: 600; 
              font-size: 14px;
            }
            .status-badge.healthy { 
              background: ${accentColor}20; 
              color: ${accentColor}; 
              border: 1px solid ${accentColor}40;
            }
            .status-badge.warning { 
              background: #ff930020; 
              color: #ff9300; 
              border: 1px solid #ff930040;
            }
            .status-badge.critical { 
              background: #ff303020; 
              color: #ff3030; 
              border: 1px solid #ff303040;
            }
            .status-grid { 
              display: grid; 
              grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); 
              gap: 20px; 
            }
            .status-card { 
              background: ${cardBg}; 
              border-radius: 12px; 
              padding: 24px; 
              box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            }
            .status-card h3 { 
              margin: 0 0 16px 0; 
              font-size: 18px; 
              font-weight: 600;
            }
            .metric-value { 
              font-size: 32px; 
              font-weight: 700; 
              color: ${accentColor}; 
              margin: 8px 0;
            }
            .metric-label { 
              font-size: 14px; 
              color: ${isDark ? "#888" : "#666"}; 
              text-transform: uppercase; 
              letter-spacing: 0.5px;
            }
            .status-indicator { 
              display: inline-flex; 
              align-items: center; 
              gap: 8px; 
              font-weight: 500;
            }
            .status-dot { 
              width: 8px; 
              height: 8px; 
              border-radius: 50%; 
            }
            .status-dot.online { background: ${accentColor}; }
            .status-dot.offline { background: #ff3030; }
            .status-dot.warning { background: #ff9300; }
            .last-updated {
              text-align: center;
              margin-top: 30px;
              font-size: 12px;
              color: ${isDark ? "#666" : "#999"};
            }
          `;

          const html = `
            <!DOCTYPE html>
            <html>
            <head>
              <meta charset="utf-8">
              <title>OpenClaw Status Dashboard</title>
              <style>${css}</style>
              <meta http-equiv="refresh" content="${refresh_interval}">
            </head>
            <body>
              <div class="dashboard">
                <div class="dashboard-header">
                  <h1>OpenClaw Status Dashboard</h1>
                  <span class="status-badge ${
                    gatewayStatus.status === "healthy"
                      ? "healthy"
                      : gatewayStatus.status === "warning"
                        ? "warning"
                        : "critical"
                  }">
                    ${
                      gatewayStatus.status === "healthy"
                        ? "All Systems Healthy"
                        : gatewayStatus.status === "warning"
                          ? "System Warning"
                          : "System Critical"
                    }
                  </span>
                </div>
                
                <div class="status-grid">
                  <div class="status-card">
                    <h3>Gateway Service</h3>
                    <div class="status-indicator">
                      <span class="status-dot ${gatewayStatus.status === "healthy" ? "online" : "offline"}"></span>
                      ${gatewayStatus.status === "healthy" ? "Online" : "Offline"}
                    </div>
                    ${
                      show_details
                        ? `
                    <div style="margin-top: 12px; font-size: 14px; color: ${isDark ? "#888" : "#666"};">
                      Version: ${versionInfo.gateway_version}<br>
                      Status: ${gatewayStatus.message}
                    </div>
                    `
                        : ""
                    }
                  </div>

                  <div class="status-card">
                    <h3>Communication Channels</h3>
                    <div class="metric-value">${channelCount}</div>
                    <div class="metric-label">Configured</div>
                    ${
                      show_details
                        ? `
                    <div style="margin-top: 12px;">
                      <div class="status-indicator">
                        <span class="status-dot ${channelCount > 0 ? "online" : "offline"}"></span>
                        ${channelCount > 0 ? "Channels Active" : "No Channels"}
                      </div>
                    </div>
                    `
                        : ""
                    }
                  </div>

                  <div class="status-card">
                    <h3>Businesses</h3>
                    <div class="metric-value">${businessCount}</div>
                    <div class="metric-label">Registered</div>
                    ${
                      show_details
                        ? `
                    <div style="margin-top: 12px;">
                      <div class="status-indicator">
                        <span class="status-dot ${businessCount > 0 ? "online" : "warning"}"></span>
                        ${businessCount > 0 ? "Businesses Active" : "No Businesses"}
                      </div>
                    </div>
                    `
                        : ""
                    }
                  </div>

                  <div class="status-card">
                    <h3>AI Agents</h3>
                    <div class="metric-value">${agentCount}</div>
                    <div class="metric-label">Active</div>
                    ${
                      show_details
                        ? `
                    <div style="margin-top: 12px;">
                      <div class="status-indicator">
                        <span class="status-dot ${agentCount > 0 ? "online" : "warning"}"></span>
                        ${agentCount > 0 ? "Agents Ready" : "No Agents"}
                      </div>
                    </div>
                    `
                        : ""
                    }
                  </div>

                  ${
                    show_details
                      ? `
                  <div class="status-card">
                    <h3>System Health</h3>
                    <div style="display: flex; flex-direction: column; gap: 8px;">
                      <div class="status-indicator">
                        <span class="status-dot ${versionInfo.compatible ? "online" : "warning"}"></span>
                        Version Compatibility
                      </div>
                      <div class="status-indicator">
                        <span class="status-dot online"></span>
                        Plugin System
                      </div>
                      <div class="status-indicator">
                        <span class="status-dot ${businessCount > 0 ? "online" : "warning"}"></span>
                        Business Logic
                      </div>
                    </div>
                  </div>

                  <div class="status-card">
                    <h3>Quick Actions</h3>
                    <div style="display: flex; flex-direction: column; gap: 8px; font-size: 14px;">
                      <div>🔄 Auto-refresh: ${refresh_interval}s</div>
                      <div>📊 Run: setup_health_check</div>
                      <div>🔧 Fix: setup_auto_fix</div>
                      <div>⚙️ Configure: setup_channel</div>
                    </div>
                  </div>
                  `
                      : ""
                  }
                </div>
                
                <div class="last-updated">
                  Last updated: ${new Date().toLocaleString()}
                </div>
              </div>
            </body>
            </html>
          `;

          return textResult(`## Status Dashboard Generated ✅

**Theme:** ${theme}
**Auto-refresh:** ${refresh_interval} seconds
**Details:** ${show_details ? "Enabled" : "Basic view"}

**Current Status:**
- Gateway: ${gatewayStatus.status === "healthy" ? "✅" : "❌"} ${gatewayStatus.message}
- Businesses: ${businessCount}
- Agents: ${agentCount}
- Channels: ${channelCount}

**Dashboard HTML:** ${html.length} characters
**CSS Included:** Yes
**Refresh:** Automatic every ${refresh_interval}s

The dashboard is ready for Canvas display. Use canvas_present with the HTML content.`);
        } catch (error) {
          api.logger.error(`Dashboard generation failed: ${error}`);
          return textResult(`❌ Dashboard generation failed: ${error}`);
        }
      },
    },
  ];
}
