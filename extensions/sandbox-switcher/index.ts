/**
 * Sandbox Mode Quick Switcher Extension
 *
 * Quick switching between agents with different sandbox configurations.
 * Main use case: Same model (e.g., qwen3:8b) with/without Docker sandbox.
 *
 * Usage:
 *   /agent <agent-id>  - Open new terminal with specified agent
 *   /agent             - Show selector with available agents
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface AgentConfig {
  id: string;
  name?: string;
  model?: { primary: string };
  sandbox?: { mode: string };
  workspace?: string;
}

function loadConfig() {
  try {
    const cfg = readFileSync(join(homedir(), ".openclaw/openclaw.json"), "utf-8");
    return JSON.parse(cfg);
  } catch {
    return null;
  }
}

function getAgents(config: any): AgentConfig[] {
  const agents: AgentConfig[] = [];
  if (config?.agents?.defaults) {
    agents.push({ id: "main", name: "Main", ...config.agents.defaults });
  }
  if (config?.agents?.list) {
    agents.push(...config.agents.list);
  }
  return agents;
}

/**
 * Escape a string for use in AppleScript
 * Doubles backslashes and quotes to prevent injection
 */
function escapeAppleScript(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("agent", {
    description: "Switch between agents (opens new terminal)",
    handler: async (args, ctx) => {
      const config = loadConfig();
      if (!config) {
        ctx.ui.notify("Failed to load config", "error");
        return;
      }

      const agents = getAgents(config);
      let targetId = args ? args.trim() : "";

      // Show list if no agent specified
      if (!targetId) {
        const items = agents.map((a) => {
          const model = a.model?.primary?.split("/").pop() || "unknown";
          const sandbox = a.sandbox?.mode || "off";
          const name = a.name || a.id;
          return `  • ${a.id} - ${name}\n    Model: ${model}\n    Sandbox: ${sandbox}`;
        });

        const list = "Available agents:\n\n" + items.join("\n\n") + "\n\nUsage: /agent <agent-id>";
        ctx.ui.notify(list, "info");
        return;
      }

      const agent = agents.find((a) => a.id === targetId);
      if (!agent) {
        ctx.ui.notify(`Agent "${targetId}" not found`, "error");
        return;
      }

      // Check Docker if sandbox mode enabled
      const sandboxMode = agent.sandbox?.mode || "off";
      if (sandboxMode !== "off") {
        try {
          const result = await pi.exec("docker", ["info"], { timeout: 5000 });
          if (result.code !== 0) {
            ctx.ui.notify(`Warning: Sandbox enabled but Docker not running`, "warning");
          }
        } catch {
          ctx.ui.notify(`Warning: Could not check Docker status`, "warning");
        }
      }

      // Create unique session key for proper isolation
      // Format: agent:{agentId}:{sessionType}:{uniqueId}
      const uniqueId = randomUUID().substring(0, 8);
      const sessionKey = `agent:${targetId}:main:${uniqueId}`;
      const workspace = agent.workspace || ctx.cwd;

      // Escape strings to prevent AppleScript injection
      const escapedSession = escapeAppleScript(sessionKey);
      const escapedWorkspace = escapeAppleScript(workspace);
      const cmd = `openclaw --session "${escapedSession}" --workspace "${escapedWorkspace}"`;

      const script = `tell application "Terminal"\n\tactivate\n\tdo script "${escapeAppleScript(cmd)}"\nend tell`;

      try {
        await pi.exec("osascript", ["-e", script], { timeout: 5000 });
        ctx.ui.notify(`Opened ${targetId} (${sandboxMode})`, "info");
      } catch (error) {
        ctx.ui.notify(`Failed to open terminal: ${error}`, "error");
      }
    },
  });
}
