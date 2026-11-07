// Real Gateway, graceful SIGTERM, forty owned interrupted turns, public cron arrivals.
// node --import ./scripts/tsx.mjs scripts/perf/restart-lane-flood-measure.ts \
//   --checkout <built-checkout> --output <new.json> [--fixture <synthetic-fixture>]
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { measureRestartLaneFlood } from "../../test/gateway-restart-lane.test-support.js";

const { values } = parseArgs({
  options: {
    checkout: { type: "string" },
    output: { type: "string" },
    fixture: { type: "string" },
    profile: { type: "boolean" },
  },
});
assert(values.checkout && values.output);
assert(!existsSync(values.output));
const cwd = path.resolve(values.checkout);
assert(existsSync(path.join(cwd, "dist", "entry.js")), "Build the tested checkout first");
const profileDir = values.profile ? path.resolve(`${values.output}.profiles`) : undefined;
if (profileDir) {
  await mkdir(profileDir, { mode: 0o700 });
}
const result = await measureRestartLaneFlood({
  cwd,
  entrypoint: ["dist/entry.js"],
  output: values.output,
  fixture: values.fixture,
  profileDir,
  signal: AbortSignal.timeout(600_000),
  onProgress: (phase) => console.log(phase),
});
console.log(JSON.stringify(result));
