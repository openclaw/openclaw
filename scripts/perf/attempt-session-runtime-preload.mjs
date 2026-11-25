import assert from "node:assert/strict";
// Synthetic Gateway attribution only; pair with transcript-broadcast-measure
// --turn-start-phases --gateway-preload scripts/perf/attempt-session-runtime-preload.mjs.
// Reservation publication runs in the requesting continuation, so these existing
// owner durations join the chat's run identity without another clock or SQL probe.
import { channel } from "node:diagnostics_channel";
import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  const directory = path.dirname(path.resolve(process.argv[1]));
  const built = !/\.[cm]?ts$/.test(process.argv[1]);
  const files = built
    ? readdirSync(directory).filter((file) => /^diagnostics-timeline-.*\.mjs$/.test(file))
    : [];
  const owners = await Promise.all(
    (built
      ? files.map((file) => pathToFileURL(path.join(directory, file)).href)
      : ["../../src/infra/diagnostics-timeline.ts"]
    ).map((file) => import(file)),
  );
  const records = new Set(
    owners.flatMap((owner) =>
      Object.values(owner).filter(
        (value) =>
          typeof value === "function" && value.name === "recordDiagnosticsTimelineDuration",
      ),
    ),
  );
  assert(records.size === 1, "Expected one measured-build duration observer");
  const [record] = records;
  channel("openclaw.agent-database.reservation").subscribe((event) => {
    if (event.caller === "history.hydration" || event.caller === "history.model-context") {
      record(`${event.caller}.queue`, event.queueWaitMs);
      record(`${event.caller}.execution`, event.writerExecutionMs);
    }
  });
}
