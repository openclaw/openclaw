// Run with node --import ./scripts/tsx.mjs; optional arguments select two owner modules.
// Synthetic browser-owner work only: no Gateway, database, or workspace I/O.
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ownerPath = "ui/src/pages/chat/chat-session-commands.ts";
const owners = await Promise.all(
  [process.argv[2] ?? ownerPath, process.argv[3] ?? ownerPath].map(
    (file) => import(pathToFileURL(resolve(file)).href),
  ),
);
const sessions = Array.from({ length: 5_000 }, (_, index) => ({
  key: `agent:main:synthetic-${index}`,
  sessionId: `synthetic-${index}`,
  sharingRole: "viewer",
  visibility: "shared",
  sendDisabledReason: "session is shared for this connection",
  spawnedCwd: `/workspace/synthetic-${index}`,
}));
const inspector = new Session();
inspector.connect();
console.log(JSON.stringify({ sessions: sessions.length, refreshes: 5_000, loadavg: loadavg() }));
try {
  for (let round = 0; round < 7; round += 1) {
    for (const [variant, owner] of owners.entries()) {
      let requests = 0;
      const host = {
        sessionKey: sessions.at(-1).key,
        sessionsResult: { sessions },
        client: {
          hello: { auth: { role: "operator", scopes: ["operator.read", "operator.write"] } },
          request: async () => {
            requests += 1;
            throw new Error("session is shared for this connection");
          },
        },
      };
      const coldStart = performance.now();
      await owner.refreshChatCommands(host);
      const coldMs = performance.now() - coldStart;
      const cpuStart = process.cpuUsage();
      const started = performance.now();
      for (let index = 0; index < 5_000; index += 1) {
        await owner.refreshChatCommands(host);
      }
      const wallMs = performance.now() - started;
      const cpu = process.cpuUsage(cpuStart);
      const timedRequests = requests;
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 512,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      for (let index = 0; index < 5_000; index += 1) {
        await owner.refreshChatCommands(host);
      }
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      const allocatedBytes = profile.samples.reduce((total, sample) => total + sample.size, 0);
      console.log(
        JSON.stringify({
          round,
          variant,
          coldMs,
          wallMs,
          cpuMs: (cpu.user + cpu.system) / 1_000,
          requests: timedRequests,
          allocatedBytes,
        }),
      );
    }
  }
} finally {
  inspector.disconnect();
}
