import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { killPidIfAlive } from "../test-utils/process-tree.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

/**
 * Spawns a standalone "mini host" process that owns a real OpenClawStdioClientTransport
 * through the exact same production launch contract the Gateway uses - no synthetic
 * ServiceChildStart fields. The host spawns a leader that forks a detached grandchild
 * (mirroring a `uvx`-style launcher), reports both PIDs over its own stdout once the
 * transport is live, then idles forever without ever calling close()/retire().
 */
async function spawnHostOwningTransport(root: string) {
  const fixturePath = path.join(root, "host.mts");
  const transportUrl = new URL("./mcp-stdio-transport.ts", import.meta.url).href;
  const leaderScript =
    'const { spawn } = require("node:child_process"); ' +
    'const d = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); ' +
    'process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "fixture/descendant", params: { pid: d.pid } }) + "\\n"); ' +
    "setInterval(() => {}, 1000);";
  await fs.writeFile(
    fixturePath,
    `import { OpenClawStdioClientTransport } from ${JSON.stringify(transportUrl)};
const transport = new OpenClawStdioClientTransport({
  command: process.execPath,
  args: ["-e", ${JSON.stringify(leaderScript)}],
});
transport.stderr.resume();
transport.onmessage = (message) => {
  if (message && message.method === "fixture/descendant") {
    process.stdout.write(
      JSON.stringify({ anchorPid: transport.pid, descendantPid: message.params.pid }) + "\\n",
    );
  }
};
await transport.start();
// Idle forever: the outer test kills this process outright to simulate the
// owning Gateway host dying, deliberately never calling close()/retire().
await new Promise(() => {});
`,
    "utf8",
  );
  const host = spawn(process.execPath, resolveRuntimeWorkerArgv(pathToFileURL(fixturePath)), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  host.stderr?.resume();
  let stdout = "";
  const pids = await new Promise<{ anchorPid: number; descendantPid: number }>(
    (resolve, reject) => {
      host.once("error", reject);
      host.once("exit", (code, signal) => {
        reject(new Error(`host exited before reporting pids (code=${code}, signal=${signal})`));
      });
      host.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
        const line = stdout.split("\n").find((candidate) => candidate.includes("anchorPid"));
        if (line) {
          try {
            resolve(JSON.parse(line) as { anchorPid: number; descendantPid: number });
          } catch (error) {
            reject(error as Error);
          }
        }
      });
    },
  );
  return { host, ...pids };
}

// prepareServiceChildRelay only enables Linux subreaper ownership on Linux
// (service-child-relay-preparation.ts); macOS falls back to plain process-group
// ownership, which this test has not been verified against. Gate to Linux only.
describe.skipIf(process.platform !== "linux")("OpenClawStdioClientTransport host loss", () => {
  it(
    "reaps the anchor and its subreaper-owned descendant after the owning host process dies",
    { timeout: 20_000 },
    async () => {
      const root = tempDirs.make("mcp-stdio-host-loss-");
      const { host, anchorPid, descendantPid } = await spawnHostOwningTransport(root);
      try {
        expect(anchorPid).toBeGreaterThan(0);
        expect(descendantPid).toBeGreaterThan(0);
        expect(isPidAlive(anchorPid)).toBe(true);
        expect(isPidAlive(descendantPid)).toBe(true);
        // Simulate the owning Gateway process disappearing outright: not a clean
        // shutdown, and not a signal that reaches the anchor's own command tree.
        host.kill("SIGKILL");
        await new Promise<void>((resolve) => host.once("exit", () => resolve()));
        let stillAlive = true;
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          if (!isPidAlive(anchorPid) && !isPidAlive(descendantPid)) {
            stillAlive = false;
            break;
          }
          await delay(50);
        }
        expect(stillAlive).toBe(false);
        expect(isPidAlive(anchorPid)).toBe(false);
        expect(isPidAlive(descendantPid)).toBe(false);
      } finally {
        killPidIfAlive(host.pid ?? undefined);
        killPidIfAlive(anchorPid);
        killPidIfAlive(descendantPid);
      }
    },
  );
});
