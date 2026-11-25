import fs from "node:fs";
// Synthetic proof instrumentation only; observes V8 allocations, changes no owner decisions.
import inspector from "node:inspector";
const session = new inspector.Session();
session.connect();
session.post("HeapProfiler.startSampling", {
  samplingInterval: 65536,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
});
process.once("exit", () =>
  session.post("HeapProfiler.stopSampling", (error, result) => {
    if (error) throw error;
    const samples = result.profile.samples;
    fs.writeFileSync(
      process.env.OPENCLAW_CONTINUITY_ALLOCATION_DIR + "/" + process.pid + ".json",
      JSON.stringify({
        pid: process.pid,
        argv: process.argv.slice(0, 3),
        sampledAllocatedBytes: samples.reduce((n, s) => n + s.size, 0),
        samples: samples.length,
        interval: 65536,
        includesCollectedObjects: true,
      }) + "\n",
    );
    session.disconnect();
  }),
);
