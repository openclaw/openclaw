import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { getFreePort } from "../test-utils/ports.js";
import { killPidIfAlive, waitForPidFile } from "../test-utils/process-tree.js";
import {
  ensureProviderLocalService,
  getManagedProviderLocalServiceDiagnosticsForTest,
  stopManagedProviderLocalServices,
} from "./provider-local-service.js";
import { hasManagedProviderLocalServices } from "./provider-runtime-lifecycle.js";

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("missing test port"));
        }
      });
    });
  });
}

describe("provider local service shutdown", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(async () => {
    await stopManagedProviderLocalServices();
  });

  it.skipIf(process.platform === "win32").each(["wait", "cancel waiter"] as const)(
    "does not adopt a healthy listener during idle shutdown: %s",
    async (outcome) => {
      const port = await getFreePort();
      const baseUrl = `http://127.0.0.1:${port}/v1`;
      const healthUrl = `${baseUrl}/models`;
      const stoppingPath = path.join(tempDirs.make("local-service-idle-race-"), "stopping.pid");
      const providerId = `local-idle-${outcome}`;
      const service = {
        command: process.execPath,
        args: [
          "-e",
          [
            'const fs = require("node:fs");',
            'const http = require("node:http");',
            `const stoppingPath = ${JSON.stringify(stoppingPath)};`,
            "const server = http.createServer((req, res) => res.end(String(process.pid)));",
            `server.listen(${port}, "127.0.0.1");`,
            'process.on("SIGTERM", () => {',
            "  if (!fs.existsSync(stoppingPath)) {",
            "    fs.writeFileSync(stoppingPath, String(process.pid));",
            // The first child stays healthy until the owner's existing shutdown
            // deadline. A replacement child shuts down normally during cleanup.
            "    return;",
            "  }",
            "  server.close(() => process.exit(0));",
            "  server.closeAllConnections();",
            "});",
          ].join("\n"),
        ],
        healthUrl,
        readyTimeoutMs: 5_000,
        idleStopMs: 1,
      };
      const acquire = (signal?: AbortSignal) =>
        ensureProviderLocalService({ providerId, baseUrl, service }, signal);
      let firstPid: number | undefined;
      let replacementPid: number | undefined;

      try {
        const firstLease = await acquire();
        expect(firstLease).toBeDefined();
        firstPid = Number(await (await fetch(healthUrl)).text());
        expect(firstPid).toBeGreaterThan(0);
        firstLease?.release();
        expect(await waitForPidFile(stoppingPath)).toBe(firstPid);
        expect(Number(await (await fetch(healthUrl)).text())).toBe(firstPid);
        expect(hasManagedProviderLocalServices()).toBe(true);

        if (outcome === "cancel waiter") {
          const controller = new AbortController();
          const pending = acquire(controller.signal);
          controller.abort(new Error("next image cancelled"));
          await expect(pending).rejects.toBe(controller.signal.reason);
          expect(isPidAlive(firstPid)).toBe(true);
        }

        const replacementLease = await acquire();
        expect(replacementLease).toBeDefined();
        replacementPid = Number(await (await fetch(healthUrl)).text());
        expect(replacementPid).toBeGreaterThan(0);
        expect(replacementPid).not.toBe(firstPid);
        expect(isPidAlive(firstPid)).toBe(false);
        expect(getManagedProviderLocalServiceDiagnosticsForTest()).toEqual([
          expect.objectContaining({ providerId, pid: replacementPid }),
        ]);
        replacementLease?.release();
        await stopManagedProviderLocalServices();
        expect(isPidAlive(replacementPid)).toBe(false);
        expect(hasManagedProviderLocalServices()).toBe(false);
      } finally {
        killPidIfAlive(firstPid);
        killPidIfAlive(replacementPid);
      }
    },
  );

  it("waits for a stubborn descendant after its parent exits", async () => {
    const port = await freePort();
    const healthUrl = `http://127.0.0.1:${port}/v1/models`;
    const descendantPidPath = path.join(tempDirs.make("local-service-tree-"), "descendant.pid");
    let pid: number | undefined;
    let descendantPid: number | undefined;

    try {
      const lease = await ensureProviderLocalService({
        providerId: "local-stubborn-stop",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        service: {
          command: process.execPath,
          args: [
            "-e",
            `const {spawn}=require("node:child_process");const fs=require("node:fs");const http=require("node:http");const child=spawn(process.execPath,["-e",'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);'],{stdio:"ignore"});fs.writeFileSync(${JSON.stringify(descendantPidPath)},String(child.pid));http.createServer((req,res)=>res.end("ok")).listen(${port},"127.0.0.1");`,
          ],
          healthUrl,
          readyTimeoutMs: 5_000,
          idleStopMs: 0,
        },
      });
      if (!lease) {
        throw new Error("Expected provider local service lease");
      }
      pid = getManagedProviderLocalServiceDiagnosticsForTest()[0]?.pid;
      if (!pid) {
        throw new Error("Expected managed provider local service pid");
      }
      descendantPid = Number(await fs.readFile(descendantPidPath, "utf8"));

      await stopManagedProviderLocalServices();

      expect(isPidAlive(pid)).toBe(false);
      expect(isPidAlive(descendantPid)).toBe(false);
      lease.release();
    } finally {
      killPidIfAlive(descendantPid);
      killPidIfAlive(pid);
    }
  });
});
