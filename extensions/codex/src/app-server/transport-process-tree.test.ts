// Real-process regression for Codex app-server hard-cancel process-group cleanup.
import { spawn, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { closeCodexAppServerTransportAndWait, type CodexAppServerTransport } from "./transport.js";

function processIsAlive(pid: number): boolean {
  const probe = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  const stat = probe.stdout.trim();
  return probe.status === 0 && stat.length > 0 && !stat.startsWith("Z");
}

describe("Codex app-server transport process-tree termination", () => {
  const posixIt = process.platform === "win32" ? it.skip : it;

  posixIt(
    "kills a child that would survive graceful app-server root exit",
    async () => {
      const descendantProgram = "setInterval(() => {}, 1000)";
      const rootProgram = [
        'const { spawn } = require("node:child_process")',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantProgram)}], { stdio: "ignore" })`,
        'process.stdout.write(String(child.pid) + "\\n")',
        "setInterval(() => {}, 1000)",
      ].join(";");
      const root = spawn(process.execPath, ["-e", rootProgram], {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const rootPid = root.pid;
      let descendantPid: number | undefined;
      try {
        if (!rootPid) {
          throw new Error("fixture root pid unavailable");
        }
        descendantPid = await new Promise<number>((resolve, reject) => {
          let stdout = "";
          const timeout = setTimeout(() => reject(new Error("fixture startup timeout")), 5_000);
          root.stdout.on("data", (chunk) => {
            stdout += String(chunk);
            const newline = stdout.indexOf("\n");
            if (newline < 0) {
              return;
            }
            clearTimeout(timeout);
            resolve(Number.parseInt(stdout.slice(0, newline), 10));
          });
          root.once("error", reject);
        });
        const transport = root as unknown as CodexAppServerTransport;
        transport.processGroupOwned = true;

        await expect(
          closeCodexAppServerTransportAndWait(transport, { processTreeTimeoutMs: 5_000 }),
        ).resolves.toBe(true);

        expect(processIsAlive(descendantPid)).toBe(false);
      } finally {
        if (rootPid) {
          try {
            process.kill(-rootPid, "SIGKILL");
          } catch {}
        }
        if (descendantPid) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {}
        }
      }
    },
    15_000,
  );
});
