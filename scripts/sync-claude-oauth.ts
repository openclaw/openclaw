import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readClaudeCliCredentials } from "../src/agents/cli-credentials.js";

const home = os.homedir();
if (!home) {
  console.error("Error: Could not determine home directory");
  process.exit(1);
}

const OPENCLAW_PROFILES = path.join(home, ".openclaw", "auth-profiles.json");
const AGENT_PROFILES = path.join(
  home,
  ".openclaw",
  "agents",
  "main",
  "agent",
  "auth-profiles.json",
);

type ProfileStore = {
  version: number;
  profiles: Record<string, unknown>;
  usageStats?: Record<
    string,
    {
      cooldownUntil?: number;
      disabledUntil?: number;
      disabledReason?: string;
      errorCount?: number;
      failureCounts?: Record<string, number>;
    }
  >;
};

// Read credentials via Keychain (macOS) with file fallback
const cred = readClaudeCliCredentials();
if (!cred) {
  console.error("Error: Could not read Claude Code credentials (tried Keychain and file).");
  console.error("Run Claude Code first to generate OAuth credentials.");
  process.exit(1);
}
if (cred.type !== "oauth") {
  console.error("Error: Claude Code credential is a token (no refresh token), cannot sync.");
  process.exit(1);
}

const profile = {
  type: "oauth" as const,
  provider: "anthropic",
  access: cred.access,
  refresh: cred.refresh,
  expires: cred.expires,
};

function clearCooldown(s: ProfileStore): void {
  const stats = s.usageStats?.["anthropic:default"];
  if (stats) {
    delete stats.cooldownUntil;
    delete stats.disabledUntil;
    delete stats.disabledReason;
    stats.errorCount = 0;
    stats.failureCounts = {};
  }
}

let store: ProfileStore;
if (fs.existsSync(OPENCLAW_PROFILES)) {
  store = JSON.parse(fs.readFileSync(OPENCLAW_PROFILES, "utf8")) as ProfileStore;
  store.profiles = store.profiles || {};
  store.profiles["anthropic:default"] = profile;
  clearCooldown(store);
} else {
  store = {
    version: 1,
    profiles: { "anthropic:default": profile },
  };
}

fs.writeFileSync(OPENCLAW_PROFILES, JSON.stringify(store, null, 2) + "\n");

// Also update the agent-specific store if it exists
if (fs.existsSync(AGENT_PROFILES)) {
  const agentStore = JSON.parse(fs.readFileSync(AGENT_PROFILES, "utf8")) as ProfileStore;
  agentStore.profiles = agentStore.profiles || {};
  agentStore.profiles["anthropic:default"] = profile;
  clearCooldown(agentStore);
  fs.writeFileSync(AGENT_PROFILES, JSON.stringify(agentStore, null, 2) + "\n");
  console.log("Updated agent store (agents/main/agent/auth-profiles.json)");
}

const expiresDate = profile.expires > 0 ? new Date(profile.expires).toISOString() : "unknown";
console.log(`Synced Claude Code OAuth to OpenClaw (anthropic:default)`);
console.log(`  Token expires: ${expiresDate}`);
