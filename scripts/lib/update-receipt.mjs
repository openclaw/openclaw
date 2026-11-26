import assert from "node:assert/strict";

// Published updaters return a command result; release-aware updaters return
// the lifecycle record. A prepared release is not a successful activation.
export function assertCompletedUpdate(receipt) {
  if (receipt?.phase === undefined) {
    assert.equal(receipt?.status, "ok", "update did not report ok");
    return false;
  }
  assertTerminalUpdateReceipt(receipt, "succeeded");
  return true;
}

export function assertTerminalUpdateReceipt(receipt, status) {
  assert(
    receipt?.phase === "finished" &&
      receipt.status === status &&
      typeof receipt.runId === "string" &&
      receipt.runId.length > 0,
    `expected finished/${status} update receipt, got ${receipt?.phase}/${receipt?.status} (${receipt?.runId ?? "no run ID"})`,
  );
}
