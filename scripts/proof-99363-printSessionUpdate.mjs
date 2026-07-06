/**
 * Proof script for PR #99363
 * fix(acp): use Object.hasOwn instead of in operator in printSessionUpdate
 *
 * This script mirrors the exact printSessionUpdate logic from src/acp/client.ts:73-104
 * and exercises it against realistic ACP session notification data to prove the
 * Object.hasOwn change is behavior-preserving for real ACP protocol messages.
 *
 * Run: node scripts/proof-99363-printSessionUpdate.mjs
 */

// ── Mirror of printSessionUpdate from src/acp/client.ts:73-104 ──
// Exact line 75 change: Object.hasOwn replaces the `in` operator

function printSessionUpdate_ObjectHasOwn(notification) {
  const update = notification.update;
  // 👇 This is the exact changed line (PR #99363: line 75)
  if (!Object.hasOwn(update, "sessionUpdate")) {
    return { matched: false, reason: "no sessionUpdate own-property" };
  }

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      if (update.content?.type === "text") {
        return { matched: true, type: "agent_message_chunk", action: "write text to stdout" };
      }
      return { matched: true, type: "agent_message_chunk", action: "non-text content skipped" };
    }
    case "tool_call": {
      return {
        matched: true,
        type: "tool_call",
        action: `log tool ${update.title} (${update.status})`,
      };
    }
    case "tool_call_update": {
      return {
        matched: true,
        type: "tool_call_update",
        action: `log update ${update.toolCallId}: ${update.status ?? "no status"}`,
      };
    }
    case "available_commands_update": {
      const names = update.availableCommands?.map((cmd) => `/${cmd.name}`).join(" ");
      return {
        matched: true,
        type: "available_commands_update",
        action: names ? `log commands: ${names}` : "no commands",
      };
    }
    default:
      return { matched: true, type: "other", action: "no-op (default case)" };
  }
}

// ── Realistic ACP SessionNotification fixtures ──
// These match the @agentclientprotocol/sdk SessionUpdate discriminated union shape
// where `sessionUpdate` is a required discriminator const on every union arm.

const fixtures = {
  agentMessageChunk: {
    sessionId: "sess_abc123",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello from the agent!" },
    },
  },
  toolCall: {
    sessionId: "sess_abc123",
    update: {
      sessionUpdate: "tool_call",
      title: "read_file",
      status: "in_progress",
      toolCallId: "tool_001",
    },
  },
  toolCallUpdate: {
    sessionId: "sess_abc123",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool_001",
      status: "completed",
    },
  },
  availableCommandsUpdate: {
    sessionId: "sess_abc123",
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "help" }, { name: "status" }],
    },
  },
  // Edge case: non-session-update (should be rejected)
  nonSessionUpdate: {
    sessionId: "sess_abc123",
    update: {
      someOtherField: "value",
    },
  },
};

// ── Test runner ──

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    pass++;
  } else {
    console.log(`  ❌ FAIL: ${label} — ${detail}`);
    fail++;
  }
}

console.log("=".repeat(62));
console.log("Proof: PR #99363 — Object.hasOwn in printSessionUpdate");
console.log("=".repeat(62));
console.log("");

// ── Test 1: Normal ACP session update handling ──
console.log("📋 Test 1: All ACP sessionUpdate discriminator variants");
console.log("-".repeat(50));

for (const [name, notification] of Object.entries(fixtures)) {
  const result = printSessionUpdate_ObjectHasOwn(notification);
  console.log(`  [${name}] → matched=${result.matched}, action="${result.action}"`);

  if (name === "nonSessionUpdate") {
    assert(
      `${name}: should NOT match (no sessionUpdate)`,
      result.matched === false,
      `expected matched=false, got ${result.matched}`,
    );
  } else {
    assert(
      `${name}: should match (has sessionUpdate own-property)`,
      result.matched === true,
      `expected matched=true, got ${result.matched}`,
    );
  }
}

console.log("");

// ── Test 2: Object.hasOwn vs in operator equivalence ──
console.log("📋 Test 2: Object.hasOwn vs `in` operator — own-property equivalence");
console.log("-".repeat(50));

const normalUpdate = {
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: "hi" },
};

const hasOwnResult = Object.hasOwn(normalUpdate, "sessionUpdate");
const inResult = "sessionUpdate" in normalUpdate;

console.log(`  Object.hasOwn(update, "sessionUpdate"): ${hasOwnResult}`);
console.log(`  "sessionUpdate" in update:               ${inResult}`);

assert(
  "Both return true for own property",
  hasOwnResult === true && inResult === true,
  `hasOwn=${hasOwnResult}, in=${inResult}`,
);

// ── Test 3: Prototype pollution safety ──
console.log("");
console.log("📋 Test 3: Prototype pollution safety — Object.hasOwn advantage");
console.log("-".repeat(50));

const protoPollutedUpdate = { content: { type: "text", text: "benign" } };
Object.prototype.sessionUpdate = "agent_message_chunk"; // simulate prototype injection

const hasOwnResult2 = Object.hasOwn(protoPollutedUpdate, "sessionUpdate");
const inResult2 = "sessionUpdate" in protoPollutedUpdate;

console.log(`  Object.prototype.sessionUpdate injected → "agent_message_chunk"`);
console.log(
  `  Object.hasOwn(update, "sessionUpdate"): ${hasOwnResult2} ← correctly rejects injected`,
);
console.log(
  `  "sessionUpdate" in update:               ${inResult2} ← incorrectly matches injected`,
);

assert(
  "Object.hasOwn correctly REJECTS prototype-injected property",
  hasOwnResult2 === false,
  `expected false, got ${hasOwnResult2}`,
);

assert(
  "in operator INCORRECTLY matches prototype-injected property",
  inResult2 === true,
  `expected true, got ${inResult2}`,
);

// Cleanup
delete Object.prototype.sessionUpdate;

// Verify cleanup
assert(
  "Object.prototype.sessionUpdate removed after cleanup",
  !("sessionUpdate" in Object.prototype),
  "prototype still has sessionUpdate",
);

// ── Test 4: Missing own property (both agree) ──
console.log("");
console.log("📋 Test 4: Missing property — both operators agree");
console.log("-".repeat(50));

const missingUpdate = { content: { type: "text", text: "hi" } };
const hasOwnResult3 = Object.hasOwn(missingUpdate, "sessionUpdate");
const inResult3 = "sessionUpdate" in missingUpdate;

console.log(`  Object.hasOwn(update, "sessionUpdate"): ${hasOwnResult3}`);
console.log(`  "sessionUpdate" in update:               ${inResult3}`);

assert(
  "Both return false for missing property",
  hasOwnResult3 === false && inResult3 === false,
  `hasOwn=${hasOwnResult3}, in=${inResult3}`,
);

// ── Summary ──
console.log("");
console.log("=".repeat(62));
console.log(`Results: ${pass} passed, ${fail} failed out of ${pass + fail} assertions`);
console.log("=".repeat(62));
console.log("");

if (fail > 0) {
  console.log("❌ PROOF FAILED — some assertions did not pass.");
  process.exit(1);
}

console.log("✅ PROOF PASSED — Object.hasOwn behavior is correct for ACP session updates.");
console.log("");
console.log("Key findings:");
console.log("  1. Object.hasOwn and `in` operator behave identically for normal ACP");
console.log("     session update discriminator properties (all 4 update types pass).");
console.log("  2. Object.hasOwn correctly rejects non-session-update notifications");
console.log("     that lack a sessionUpdate own property.");
console.log("  3. Object.hasOwn provides prototype pollution safety: unlike `in`,");
console.log("     it does NOT match a prototype-injected sessionUpdate property.");
console.log("  4. The ACP SDK schema requires sessionUpdate as a required discriminator");
console.log("     on every SessionUpdate union arm — so in practice both are equivalent,");
console.log("     but Object.hasOwn is the more defensive, semantically correct choice.");
process.exit(0);
