/**
 * Synthetic built-Gateway retention diagnostic; usage: queued-input-retention.md.
 * Captures the existing controller registry without importing a second source copy.
 * Heap capture runs after the last verified chat round. Its synchronous pause is
 * included in the harness diagnostics: use this pass for retention, never timing.
 */
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { writeHeapSnapshot } from "node:v8";
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  assert(process.argv.includes("gateway"), "Retention preload requires an isolated Gateway");
  const root = process.env.OPENCLAW_STATE_DIR;
  assert(root, "Retention preload requires an explicit synthetic state directory");
  const fixture = JSON.parse(readFileSync(path.join(root, "team-shape-summary.json"), "utf8"));
  assert.equal(fixture.format, "openclaw-team-shape-v1", "Use a generated synthetic fixture");

  function census() {
    const state = globalThis[Symbol.for("openclaw.sessionControllers")];
    const totals = {
      controllers: 0,
      effects: 0,
      operations: 0,
      recentSources: 0,
      mailboxInputs: 0,
      mailboxClaims: 0,
      sourcePhases: {},
    };
    for (const entry of state?.controllers.values() ?? []) {
      totals.controllers++;
      totals.effects += entry.lifecycle?.effects.size ?? 0;
      totals.operations += entry.lifecycle?.operations.size ?? 0;
      totals.recentSources += entry.mailbox?.recentSources.size ?? 0;
      totals.mailboxInputs += entry.mailbox?.entries.length ?? 0;
      totals.mailboxClaims += entry.mailbox?.claim ? 1 : 0;
      for (const record of entry.mailbox?.recentSources.values() ?? []) {
        // Compare the old input-owning representation with the identity-only candidate.
        const phase = record.input?.phase ?? "identity-only";
        totals.sourcePhases[phase] = (totals.sourcePhases[phase] ?? 0) + 1;
      }
    }
    appendFileSync(
      path.join(root, "controller-census.jsonl"),
      `${JSON.stringify({ at: Date.now(), ...totals })}\n`,
    );
  }

  process.on("message", (message) => {
    if (message?.channel !== "openclaw-gateway-bench-profile") {
      return;
    }
    const settled =
      message.kind === "diagnostics" &&
      message.action === "stop" &&
      message.captureId === "whole-chat";
    if (message.kind === "resource-usage" || settled) {
      census();
    }
    if (settled) {
      const started = Date.now();
      // V8 collects before producing the snapshot; no source-only constructor census.
      writeHeapSnapshot(path.join(root, "queued-settled.heapsnapshot"));
      writeFileSync(
        path.join(root, "queued-settled-memory.json"),
        JSON.stringify({
          at: Date.now(),
          snapshotMs: Date.now() - started,
          memory: process.memoryUsage(),
        }),
      );
    }
  });
}
