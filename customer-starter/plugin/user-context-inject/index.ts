/**
 * User context inject plugin — multi-user context.
 * Reads users/<sanitized-session-key>.md from the workspace and returns it as
 * prependContext so the agent sees that user's preferences each turn.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import fs from "node:fs";
import path from "node:path";

/** Sanitize session key for use as a filename (e.g. agent:main:dm:alice -> dm_alice). */
function sanitizeSessionKey(sessionKey: string): string {
  const trimmed = sessionKey.trim();
  if (!trimmed) {
    return "";
  }
  // Take the part after agent:<agentId>: (e.g. dm:alice) and replace : with _
  const parts = trimmed.split(":");
  if (parts.length >= 4) {
    // agent:main:dm:alice -> dm_alice
    return parts.slice(2).join("_");
  }
  if (parts.length >= 2) {
    return parts.slice(1).join("_");
  }
  return trimmed.replace(/[^a-zA-Z0-9_-]/g, "_");
}

const plugin = {
  id: "user-context-inject",
  name: "User context inject",
  description: "Injects per-user preferences from users/<key>.md (multi-user context)",
  configSchema: {},

  register(api: OpenClawPluginApi) {
    api.on("before_agent_start", async (_event, ctx) => {
      const sessionKey = ctx?.sessionKey;
      const workspaceDir = ctx?.workspaceDir;
      if (!sessionKey || !workspaceDir) {
        return;
      }

      const sanitized = sanitizeSessionKey(sessionKey);
      if (!sanitized) {
        return;
      }

      const userFile = path.join(workspaceDir, "users", `${sanitized}.md`);
      try {
        if (!fs.existsSync(userFile)) {
          return;
        }
        const content = fs.readFileSync(userFile, "utf-8").trim();
        if (!content) {
          return;
        }
        return {
          prependContext: `## User context\n\n${content}`,
        };
      } catch {
        api.logger.warn?.(`user-context-inject: could not read ${userFile}`);
        return undefined;
      }
    });

    api.logger.info?.("user-context-inject: registered (inject users/<key>.md)");
  },
};

export default plugin;
