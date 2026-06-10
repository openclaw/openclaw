// Live proof: #89506 / #86199
// Shows abortActive() clears pendingOptimisticUserMessage on:
//  1. zero-run-ids path (both ids null, optimistic flag true)
//  2. active-run-only abort path (activeChatRunId present, pendingChatRunId null, flag stale)

import { createSessionActions } from "./src/tui/tui-session-actions.js";

function makeState(overrides) {
  return {
    statusLineText: "", localRunIds: null, chatMessage: "", chatAttachments: [],
    activeChatRunId: null, pendingChatRunId: null, pendingOptimisticUserMessage: false,
    activityStatus: null, connected: true, sessionsExpandedCheckpointKey: null,
    sessionKey: "test:main:main", chatSessionPickerResult: null, sessionsResult: null,
    headerDone: true, ...overrides,
  };
}

const chatLog = { addSystem: () => {}, clearAll: () => {} };
const tui = { requestRender: () => {} };

function makeActions(state) {
  return createSessionActions({
    client: { listSessions: async () => ({ sessions: [] }), abortChat: async () => ({ ok: true, aborted: true }) },
    chatLog, tui, opts: {},
    state,
    agentNames: new Map(),
    initialSessionInput: "", initialSessionAgentId: null,
    resolveSessionKey: (raw) => raw || "test:main:main",
    updateHeader: () => {}, updateFooter: () => {},
    updateAutocompleteProvider: () => {}, setActivityStatus: () => {},
    btw: { write: () => {}, clear: () => {} },
  });
}

let allPass = true;

console.log("=== Live Proof: #89506 / #86199 ===");
console.log("Fix: clear pendingOptimisticUserMessage on abort paths");
console.log("");

// Scenario 1: Both run IDs null, optimistic flag true
// The bug: Esc reports "no active run" but never clears the flag → next prompt blocked
console.log("--- Scenario 1: Zero run ids path ---");
const s1 = makeState({ pendingOptimisticUserMessage: true });
console.log("Before:  active=null pending=null flag=true");
await makeActions(s1).abortActive();
const s1Pass = !s1.pendingOptimisticUserMessage;
console.log(`After:   flag=${s1.pendingOptimisticUserMessage}  => ${s1Pass ? "CLEARED ✓" : "STALE ✗"}`);
allPass &&= s1Pass;

// Scenario 2: Active run present, pending run null, optimistic flag stale
// The bug: abort succeeds but flag not cleared because abortsPendingRun=false
console.log("\n--- Scenario 2: Active-only abort path ---");
const s2 = makeState({
  activeChatRunId: "run-active",
  pendingChatRunId: null,
  pendingOptimisticUserMessage: true,
});
console.log("Before:  active=run-active pending=null flag=true");
await makeActions(s2).abortActive();
const s2Pass = !s2.pendingOptimisticUserMessage;
console.log(`After:   flag=${s2.pendingOptimisticUserMessage}  => ${s2Pass ? "CLEARED ✓" : "STALE ✗"}`);
allPass &&= s2Pass;

// Scenario 3: Clean state regression check
console.log("\n--- Scenario 3: Clean state regression ---");
const s3 = makeState({ pendingOptimisticUserMessage: false });
await makeActions(s3).abortActive();
const s3Pass = s3.pendingOptimisticUserMessage === false;
console.log(`Flag stays false: ${s3Pass ? "PASS" : "FAIL"}`);
allPass &&= s3Pass;

console.log(`\n=== Live Proof #89506: ${allPass ? "ALL PASSED" : "FAILED"} ===`);
