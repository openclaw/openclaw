import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The explicit waiver only arms after the drain budget and leaves a receipt.
const source = readFileSync(new URL("./openclaw-release-deploy", import.meta.url), "utf8");

test("waiver is opt-in and off by default", () => {
  assert.match(source, /^waive_terminal_persistence=0$/m);
  assert.match(source, /^terminal_persistence_waiver_armed=0$/m);
  assert.match(source, /--waive-stale-terminal-persistence\)\n[^\n]*\n\s+waive_terminal_persistence=1/);
});

test("waiver only arms after the drain budget and writes a receipt", () => {
  const arm = source.match(/if \(\(\$\{waive_terminal_persistence:-0\} && !\$\{terminal_persistence_waiver_armed:-0\}\)\) &&\n\s+\[\[ "\$suspension_state" == DRAINING \]\] && \(\(interrupt_after_drain && drain_budget_elapsed\)\); then[\s\S]*?TERMINAL_PERSISTENCE_WAIVED activeCount=%s blockers=%s custody=%s/);
  assert.ok(arm, "arming block with receipt present");
  // Without the waiver the terminal-persistence fence and custody fence are unchanged.
  assert.match(source, /\[\[ ",\$suspension_blockers," != \*,terminal-persistence:\* \]\] \|\| \(\(\$\{waive_terminal_persistence:-0\}\)\)/);
  assert.match(source, /\(\(\$\{waive_terminal_persistence:-0\} && \$\{terminal_persistence_waiver_armed:-0\}\)\)/);
});
