// Real behavior proof: startSshPortForward ignores stderr stream errors during
// teardown instead of crashing the gateway.
//
// The proof patches child_process.spawn so the ssh child is a real process that
// starts a local listener (so waitForLocalListener resolves) and has a stderr
// stream. After the tunnel is established, the proof emits an error on stderr
// and stops the tunnel. With the fix the stop resolves cleanly; without the
// stderr error listener the unhandled error would terminate the process.

import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process") as typeof import("node:child_process");
const originalSpawn = childProcess.spawn;

const servers: net.Server[] = [];
let currentChild: (NodeJS.EventEmitter & { stderr?: NodeJS.EventEmitter; kill?: (signal?: string) => boolean }) | null = null;

childProcess.spawn = (...args: Parameters<typeof originalSpawn>) => {
  const cmd = args[0] ?? "";
  const argv = args[1] as string[] | undefined;
  const child = originalSpawn.apply(childProcess, args);
  currentChild = child as typeof currentChild;

  if (cmd === "/usr/bin/ssh" && argv) {
    const forwardIndex = argv.indexOf("-L");
    const forwardSpec = forwardIndex >= 0 ? argv[forwardIndex + 1] : undefined;
    const localPort = forwardSpec ? Number(forwardSpec.split(":")[1]) : 0;
    if (localPort > 0) {
      const server = net.createServer();
      server.on("error", () => {});
      servers.push(server);
      server.listen(localPort, "127.0.0.1");
    }
  }

  return child;
};

const { startSshPortForward } = await import(path.join(repoRoot, "src/infra/ssh-tunnel.js"));

console.log("=== Proof: ssh-tunnel stderr stream error handling ===\n");

try {
  const tunnel = await startSshPortForward({
    target: "me@example.com:2222",
    localPortPreferred: 43210,
    remotePort: 18789,
    timeoutMs: 1000,
  });

  console.log(`Tunnel established on local port ${tunnel.localPort}.`);

  // Emit a stderr stream error; this must not crash the gateway.
  currentChild?.stderr?.emit("error", new Error("stderr EPIPE"));
  console.log("Emitted stderr stream error.");

  await tunnel.stop();
  console.log("\nPASS: stderr stream error was ignored and tunnel stopped cleanly.");
} catch (err) {
  console.error("\nFAIL: tunnel setup or stop rejected with:");
  console.error(err);
  process.exitCode = 1;
} finally {
  childProcess.spawn = originalSpawn;
  for (const server of servers) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}
