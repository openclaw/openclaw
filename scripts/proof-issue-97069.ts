/**
 * Proof script for issue #97069 fix.
 *
 * Demonstrates that the approval prompt now correctly distinguishes
 * between two reasons Allow Always is unavailable:
 * 1. ask === "always" → policy requires approval every time
 * 2. command is one-shot → shell redirection makes it non-persistable
 *
 * Exits with code 1 on any assertion failure.
 *
 * Usage: npx tsx scripts/proof-issue-97069.ts
 */
import { buildApprovalPendingMessage } from "../src/agents/bash-tools.exec-runtime.js";
import { buildExecApprovalRequestMessage } from "../src/infra/exec-approval-forwarder.js";
import { buildExecApprovalPendingReplyPayload } from "../src/infra/exec-approval-reply.js";

const failures: string[] = [];
function check(condition: boolean, label: string): void {
  if (!condition) {
    failures.push(`FAIL: ${label}`);
    console.log(`  ✗ ${label}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
}

const divider = "=".repeat(64);

console.log(divider);
console.log("PROOF: Context-aware approval prompt message — issue #97069");
console.log(divider);

// ── Agent foreground message ───────────────────────────────────────
console.log("\n1. Agent foreground message (buildApprovalPendingMessage)\n");

const policyMsg = buildApprovalPendingMessage({
  approvalSlug: "abc12",
  approvalId: "abc12345",
  allowedDecisions: ["allow-once", "deny"],
  allowAlwaysPersistenceKind: null,
  command: "openclaw --version",
  cwd: "/home/user",
  host: "gateway",
});
check(
  policyMsg.includes("effective approval policy requires approval every time"),
  "ask=always → policy message preserved",
);

const oneShotMsg = buildApprovalPendingMessage({
  approvalSlug: "def45",
  approvalId: "def45678",
  allowedDecisions: ["allow-once", "deny"],
  allowAlwaysPersistenceKind: "one-shot",
  command: "openclaw --version 2>&1",
  cwd: "/home/user",
  host: "gateway",
});
check(
  oneShotMsg.includes("cannot be saved and reused"),
  "one-shot → command non-persistable message",
);
check(
  !oneShotMsg.includes("effective approval policy requires approval every time"),
  "one-shot → policy message NOT shown",
);

// ── Reply payload ──────────────────────────────────────────────────
console.log("\n2. Reply payload (buildExecApprovalPendingReplyPayload)\n");

const replyPolicy = buildExecApprovalPendingReplyPayload({
  approvalId: "abc12345",
  approvalSlug: "abc12",
  ask: "always",
  command: "openclaw --version",
  host: "gateway",
});
check(
  replyPolicy.text?.includes("effective approval policy requires approval every time") ?? false,
  "reply ask=always → policy message preserved",
);

const replyMissingAsk = buildExecApprovalPendingReplyPayload({
  approvalId: "ghi34567",
  approvalSlug: "ghi34",
  allowedDecisions: ["allow-once", "deny"],
  command: "openclaw --version",
  host: "gateway",
});
check(
  replyMissingAsk.text?.includes("effective approval policy requires approval every time") ?? false,
  "reply ask=undefined → fallback to policy message",
);

const replyOneShot = buildExecApprovalPendingReplyPayload({
  approvalId: "def45678",
  approvalSlug: "def45",
  ask: "on-miss",
  allowedDecisions: ["allow-once", "deny"],
  command: "openclaw --version 2>&1",
  host: "gateway",
});
check(
  replyOneShot.text?.includes("cannot be saved and reused") ?? false,
  "reply ask≠always → one-shot message shown",
);

// ── Forwarder message ──────────────────────────────────────────────
console.log("\n3. Forwarder message (buildExecApprovalRequestMessage)\n");

const nowMs = Date.now();
const fwdPolicy = buildExecApprovalRequestMessage(
  {
    id: "abc12345",
    request: { ask: "always", command: "openclaw --version" },
    expiresAtMs: nowMs + 60000,
  },
  nowMs,
);
check(
  fwdPolicy.includes("effective policy requires approval every time"),
  "forwarder ask=always → policy message preserved",
);

const fwdMissingAsk = buildExecApprovalRequestMessage(
  {
    id: "ghi34567",
    request: { command: "openclaw --version", unavailableDecisions: ["allow-always"] },
    expiresAtMs: nowMs + 60000,
  },
  nowMs,
);
check(
  fwdMissingAsk.includes("effective policy requires approval every time"),
  "forwarder ask=undefined → fallback to policy message",
);

const fwdOneShot = buildExecApprovalRequestMessage(
  {
    id: "def45678",
    request: {
      ask: "on-miss",
      command: "openclaw --version 2>&1",
      unavailableDecisions: ["allow-always"],
    },
    expiresAtMs: nowMs + 60000,
  },
  nowMs,
);
check(
  fwdOneShot.includes("cannot be saved and reused"),
  "forwarder ask≠always → one-shot message shown",
);

// ── Summary ────────────────────────────────────────────────────────
console.log("\n" + divider);
if (failures.length === 0) {
  console.log("ALL CHECKS PASSED ✓");
  console.log("Fix covers: agent, reply, forwarder, missing-ask fallback");
  console.log(divider);
  process.exit(0);
} else {
  console.log(`${failures.length} CHECK(S) FAILED:`);
  for (const f of failures) {
    console.log(`  ${f}`);
  }
  console.log(divider);
  process.exit(1);
}
