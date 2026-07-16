/**
 * Runtime proof for issue #109087.
 * Mirrors selectSession in ui/src/components/app-sidebar-session-navigation.ts:
 * selecting a session for another agent must update agentSelection so the
 * agent chip/select no longer no-ops re-clicks on the previous agent.
 *
 * Run: node scripts/proof-session-switcher-agent-sync.mjs
 */

function parseAgentSessionKey(sessionKey) {
  const m = /^agent:([^:]+):/.exec(sessionKey);
  return m ? { agentId: m[1] } : null;
}

// Pre-fix: only setSessionKey (chat updates, agent chip stays on previous agent).
function selectSessionBroken(ctx, sessionKey) {
  ctx.gateway.setSessionKey(sessionKey);
}

// Fixed: also sync agentSelection from the session key (matches chat-pane).
function selectSessionFixed(ctx, sessionKey) {
  const agentId = parseAgentSessionKey(sessionKey)?.agentId;
  if (agentId) {
    ctx.agentSelection.set(agentId);
  }
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
  // Operator is on agent main, then opens a research session from the switcher.
  selectSession(ctx, "agent:research:work");
  // Agent chip no-ops when re-selecting selectedId; after switch it must be research
  // so clicking main is not a no-op.
  const canReselectMain =
    ctx.agentSelection.selectedId === "research" && calls.sessionKey === "agent:research:work";
  return { calls, canReselectMain, selectedId: ctx.agentSelection.selectedId };
}

const before = runScenario(selectSessionBroken);
const after = runScenario(selectSessionFixed);

console.log("BEFORE (setSessionKey only):");
console.log(`  sessionKey=${before.calls.sessionKey}`);
console.log(`  agentSelection.selectedId=${before.selectedId}`);
console.log(`  agentId set called: ${before.calls.agentId}`);
console.log(`  can re-select previous agent after switch: ${before.canReselectMain}`);

console.log("\nAFTER (sync agentSelection from session key):");
console.log(`  sessionKey=${after.calls.sessionKey}`);
console.log(`  agentSelection.selectedId=${after.selectedId}`);
console.log(`  agentId set called: ${after.calls.agentId}`);
console.log(`  can re-select previous agent after switch: ${after.canReselectMain}`);

const fixed = !before.canReselectMain && after.canReselectMain;
console.log(`\nRESULT: ${fixed ? "PASS — session switch keeps agent chip in sync" : "FAIL"}`);
if (!fixed) {
  process.exit(1);
}
