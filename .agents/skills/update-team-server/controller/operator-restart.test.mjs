import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { events, makeReleaseFixture, runOwner } from "./worker-config-owner-fixture.mjs";

for (const KillMode of ["control-group", "mixed", "process", "none"]) {
  const boundedGroup = ["control-group", "mixed"].includes(KillMode);
  for (const overrides of boundedGroup ? [{}, { SendSIGKILL: "no" }, { TimeoutStopUSec: "infinity" }] : [{}]) {
    test(`operator restart shutdown policy ${KillMode} ${JSON.stringify(overrides)}`, (t) => {
      const f = makeReleaseFixture(t, "operator-no-response");
      writeFileSync(join(f.state, "stop-start-properties"), JSON.stringify({
        KillMode, SendSIGKILL: "yes", TimeoutStopUSec: "1min 30s", ...overrides,
      }));
      const result = runOwner(f, ["--operator-restart-current", "a".repeat(40), f.pid, f.start]);
      const accepted = boundedGroup && Object.keys(overrides).length === 0;
      const log = events(f);
      if (accepted) {
        assert.equal(result.status, 0, result.stderr + result.stdout);
        assert.equal(log.split("\n").filter((event) => event === "service.system.restart").length, 1);
        const receipt = readdirSync(join(f.serving, "journal")).find((name) => name.startsWith("operator-restart-"));
        assert.ok(receipt, "restart retains the operator receipt");
        assert.match(readFileSync(join(f.serving, "journal", receipt), "utf8"), /phase=verified rc=0/);
      } else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /operator restart requires bounded system-unit process-group shutdown/);
        assert.doesNotMatch(log, /service\.system\.(stop|start|restart)/);
      }
    });
  }
}
