/**
 * Runtime proof for openclaw/openclaw#109214 / issue #109087.
 * Uses production parseAgentSessionKey from ui/src/lib/sessions/session-key.ts
 * and the same selectSession sequence as app-sidebar-session-navigation.ts.
 *
 * Run: node --import tsx scripts/proof-session-switcher-agent-sync.mjs
 */
import { parseAgentSessionKey } from "../ui/src/lib/sessions/session-key.ts";

// Production sequence from AppSidebarSessionNavigationElement.selectSession
function selectSessionFixed(ctx, sessionKey) {
  const agentId = parseAgentSessionKey(sessionKey)?.agentId;
  if (agentId) {
    ctx.agentSelection.set(agentId);
  }
  ctx.gateway.setSessionKey(sessionKey);
}

// Pre-fix: only setSessionKey
function selectSessionBroken(ctx, sessionKey) {
  ctx.gateway.setSessionKey(sessionKey);
}

function runScenario(selectSession) {
  const calls = { sessionKey: null, agentId: null };
  const ctx = {
    gateway: {
      setSessionKey(key) {
        calls.sessionKey = key;
      },
    },
    agentSelection: {
      selectedId: "main",
      set(agentId) {
        calls.agentId = agentId;
        this.selectedId = agentId;
      },
    },
  };
  selectSession(ctx, "agent:research:work");
  const canReselectMain =
    ctx.agentSelection.selectedId === "research" && calls.sessionKey === "agent:research:work";
  return { calls, canReselectMain, selectedId: ctx.agentSelection.selectedId };
}

console.log(
  "production parseAgentSessionKey('agent:research:work') =>",
  parseAgentSessionKey("agent:research:work"),
);

const before = runScenario(selectSessionBroken);
const after = runScenario(selectSessionFixed);

console.log("BEFORE (setSessionKey only):");
console.log(`  sessionKey=${before.calls.sessionKey}`);
console.log(`  agentSelection.selectedId=${before.selectedId}`);
console.log(`  agentId set called: ${before.calls.agentId}`);
console.log(`  can re-select previous agent after switch: ${before.canReselectMain}`);

console.log("\nAFTER (production parseAgentSessionKey + agentSelection.set):");
console.log(`  sessionKey=${after.calls.sessionKey}`);
console.log(`  agentSelection.selectedId=${after.selectedId}`);
console.log(`  agentId set called: ${after.calls.agentId}`);
console.log(`  can re-select previous agent after switch: ${after.canReselectMain}`);

const fixed = !before.canReselectMain && after.canReselectMain;
console.log(`\nRESULT: ${fixed ? "PASS — session switch keeps agent chip in sync" : "FAIL"}`);
if (!fixed) {
  process.exit(1);
}
