import * as fs from "node:fs";
import * as path from "node:path";

const CLAUDE_CREDS = path.join(process.env.HOME!, ".claude", ".credentials.json");
const OPENCLAW_PROFILES = path.join(process.env.HOME!, ".openclaw", "auth-profiles.json");
const AGENT_PROFILES = path.join(process.env.HOME!, ".openclaw", "agents", "main", "agent", "auth-profiles.json");

if (!fs.existsSync(CLAUDE_CREDS)) {
  console.error(`Error: Claude Code credentials not found at ${CLAUDE_CREDS}`);
  console.error("Run Claude Code first to generate OAuth credentials.");
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(CLAUDE_CREDS, "utf8"));
const oauth = raw.claudeAiOauth;
if (!oauth?.accessToken || !oauth?.refreshToken) {
  console.error("Error: Missing accessToken or refreshToken in Claude Code credentials");
  process.exit(1);
}

const profile = {
  type: "oauth" as const,
  provider: "anthropic",
  access: oauth.accessToken,
  refresh: oauth.refreshToken,
  expires: oauth.expiresAt || 0,
};

let store: Record<string, unknown>;
if (fs.existsSync(OPENCLAW_PROFILES)) {
  store = JSON.parse(fs.readFileSync(OPENCLAW_PROFILES, "utf8"));
  (store as any).profiles = (store as any).profiles || {};
  (store as any).profiles["anthropic:default"] = profile;

  // Clear any cooldown for this profile
  const stats = (store as any).usageStats?.["anthropic:default"];
  if (stats) {
    delete stats.cooldownUntil;
    delete stats.disabledUntil;
    stats.errorCount = 0;
  }
} else {
  store = {
    version: 1,
    profiles: { "anthropic:default": profile },
  };
}

fs.writeFileSync(OPENCLAW_PROFILES, JSON.stringify(store, null, 2) + "\n");

// Also update the agent-specific store if it exists
if (fs.existsSync(AGENT_PROFILES)) {
  const agentStore = JSON.parse(fs.readFileSync(AGENT_PROFILES, "utf8")) as Record<string, unknown>;
  (agentStore as any).profiles = (agentStore as any).profiles || {};
  (agentStore as any).profiles["anthropic:default"] = profile;

  // Clear cooldown/disabled state
  const stats = (agentStore as any).usageStats?.["anthropic:default"];
  if (stats) {
    delete stats.cooldownUntil;
    delete stats.disabledUntil;
    delete stats.disabledReason;
    stats.errorCount = 0;
    stats.failureCounts = {};
  }
  fs.writeFileSync(AGENT_PROFILES, JSON.stringify(agentStore, null, 2) + "\n");
  console.log("Updated agent store (agents/main/agent/auth-profiles.json)");
}

const expiresDate = new Date(profile.expires).toISOString();
console.log(`Synced Claude Code OAuth to OpenClaw (anthropic:default)`);
console.log(`  Token expires: ${expiresDate}`);
