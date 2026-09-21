import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { isPortFree } from "../test-utils/ports.js";
import { killPidIfAlive, waitForPidToExit } from "../test-utils/process-tree.js";
import {
  ensureProviderLocalService,
  getManagedProviderLocalServiceDiagnosticsForTest,
  stopManagedProviderLocalServices,
} from "./provider-local-service.js";
import { createProviderLocalServiceTestFixture } from "./provider-local-service.test-support.js";
import { hasManagedProviderLocalServices } from "./provider-runtime-lifecycle.js";

function captureServicePid(healthUrl: string, pids: Set<number>): number {
  const pid = getManagedProviderLocalServiceDiagnosticsForTest().find(
    (service) => service.healthUrl === healthUrl,
  )?.pid;
  if (!pid) {
    throw new Error("Expected managed provider local service pid");
  }
  pids.add(pid);
  return pid;
}

async function killOwnedServices(pids: Set<number>): Promise<void> {
  for (const pid of pids) {
    killPidIfAlive(pid);
  }
  for (const pid of pids) {
    expect(await waitForPidToExit(pid)).toBe(true);
  }
}

describe("provider local service shutdown", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const fixture = createProviderLocalServiceTestFixture();
  afterEach(fixture.cleanup);

  it("waits for a stubborn descendant after its parent exits", async () => {
    const port = await fixture.claimPort();
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

  // Windows terminates SIGTERM targets directly, so it cannot exercise a gated signal handler.
  it.runIf(process.platform !== "win32")(
    "joins an idle stop before shutdown or same-key acquisition can finish",
    async () => {
      const port = await fixture.claimPort();
      const healthUrl = `http://127.0.0.1:${port}/v1/models`;
      const stopping = createDeferred();
      let heldResponse: http.ServerResponse | undefined;
      let gateReleased = false;
      const releaseGate = () => {
        gateReleased = true;
        heldResponse?.end("continue");
        heldResponse = undefined;
      };
      const control = http.createServer((request, response) => {
        request.resume();
        if (gateReleased) {
          response.end("continue");
          return;
        }
        heldResponse = response;
        stopping.resolve();
      });
      await new Promise<void>((resolve, reject) => {
        control.once("error", reject);
        control.listen(0, "127.0.0.1", () => {
          control.off("error", reject);
          resolve();
        });
      });
      const address = control.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected local service control listener");
      }
      const controlUrl = `http://127.0.0.1:${address.port}/stopping`;
      const target = {
        providerId: "local-idle-stop-join",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        service: {
          command: process.execPath,
          args: [
            "-e",
            [
              'const http = require("node:http");',
              "let stopping = false;",
              "const server = http.createServer((request, response) => {",
              "  response.writeHead(stopping ? 503 : 200);",
              '  response.end("ready");',
              "});",
              'process.once("SIGTERM", () => {',
              "  stopping = true;",
              `  http.get(${JSON.stringify(controlUrl)}, { agent: false }, (response) => {`,
              "    response.resume();",
              '    response.once("end", () => {',
              "      server.close(() => process.exit(0));",
              "      server.closeAllConnections();",
              "    });",
              '  }).once("error", () => process.exit(1));',
              "});",
              `server.listen(${port}, "127.0.0.1");`,
            ].join("\n"),
          ],
          healthUrl,
          readyTimeoutMs: 5_000,
          idleStopMs: 1,
        },
      };
      const pids = new Set<number>();
      const pending: Promise<unknown>[] = [];

      await runQaGatewayFixture(
        async () => {
          const lease = await ensureProviderLocalService(target);
          if (!lease) {
            throw new Error("Expected initial provider local service lease");
          }
          const originalPid = captureServicePid(healthUrl, pids);
          lease.release();
          await withTestTimeout(stopping.promise, 5_000, "Provider did not enter SIGTERM handler");
          expect(hasManagedProviderLocalServices()).toBe(true);

          let stopSettled = false;
          const stopped = stopManagedProviderLocalServices().finally(() => {
            stopSettled = true;
          });
          pending.push(stopped);
          void stopped.catch(() => {});
          let acquisitionSettled = false;
          const replacement = ensureProviderLocalService(target)
            .then((nextLease) => {
              if (nextLease) {
                captureServicePid(healthUrl, pids);
              }
              return nextLease;
            })
            .finally(() => {
              acquisitionSettled = true;
            });
          pending.push(replacement);
          void replacement.catch(() => {});

          await nextEventLoopTurn();
          expect(stopSettled).toBe(false);
          expect(acquisitionSettled).toBe(false);
          expect(isPidAlive(originalPid)).toBe(true);

          releaseGate();
          await stopped;
          const nextLease = await replacement;
          if (!nextLease) {
            throw new Error("Expected replacement provider local service lease");
          }
          expect(captureServicePid(healthUrl, pids)).not.toBe(originalPid);
          expect(isPidAlive(originalPid)).toBe(false);
          expect((await fetch(healthUrl)).ok).toBe(true);
          nextLease.release();
          await stopManagedProviderLocalServices();
          expect(hasManagedProviderLocalServices()).toBe(false);
          expect(await isPortFree(port)).toBe(true);
        },
        async () => {
          releaseGate();
          await Promise.allSettled(pending);
          await stopManagedProviderLocalServices();
        },
        () => killOwnedServices(pids),
        () =>
          new Promise<void>((resolve, reject) => {
            control.close((error) => (error ? reject(error) : resolve()));
          }),
      );
    },
  );

  it("keeps a replacement service owned when a retired lease releases late", async () => {
    const port = await fixture.claimPort();
    const healthUrl = `http://127.0.0.1:${port}/v1/models`;
    const pids = new Set<number>();
    const target = {
      providerId: "local-late-lease-release",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      service: {
        command: process.execPath,
        args: [
          "-e",
          `require("node:http").createServer((request,response)=>response.end("ready")).listen(${port},"127.0.0.1");`,
        ],
        healthUrl,
        readyTimeoutMs: 5_000,
        idleStopMs: 0,
      },
    };

    await runQaGatewayFixture(
      async () => {
        const retiredLease = await ensureProviderLocalService(target);
        if (!retiredLease) {
          throw new Error("Expected initial provider local service lease");
        }
        const retiredPid = captureServicePid(healthUrl, pids);
        await stopManagedProviderLocalServices();
        expect(isPidAlive(retiredPid)).toBe(false);

        const replacementLease = await ensureProviderLocalService(target);
        if (!replacementLease) {
          throw new Error("Expected replacement provider local service lease");
        }
        const replacementPid = captureServicePid(healthUrl, pids);
        expect(replacementPid).not.toBe(retiredPid);
        retiredLease.release();
        expect(hasManagedProviderLocalServices()).toBe(true);
        expect((await fetch(healthUrl)).ok).toBe(true);

        await stopManagedProviderLocalServices();
        expect(isPidAlive(replacementPid)).toBe(false);
        expect(await isPortFree(port)).toBe(true);
        replacementLease.release();
      },
      stopManagedProviderLocalServices,
      () => killOwnedServices(pids),
    );
  });

  it("recovers on a later acquisition after a failed process-exit observation", async () => {
    const port = await fixture.claimPort();
    const healthUrl = `http://127.0.0.1:${port}/v1/models`;
    const pids = new Set<number>();
    const target = {
      providerId: "local-stop-observation-recovery",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      service: {
        command: process.execPath,
        args: [
          "-e",
          `require("node:http").createServer((request,response)=>response.end("ready")).listen(${port},"127.0.0.1");`,
        ],
        healthUrl,
        readyTimeoutMs: 5_000,
        idleStopMs: 0,
      },
    };

    await runQaGatewayFixture(
      async () => {
        const lease = await ensureProviderLocalService(target);
        if (!lease) {
          throw new Error("Expected initial provider local service lease");
        }
        const originalPid = captureServicePid(healthUrl, pids);
        lease.release();
        // The child really exits; only its owner's liveness observation stays stale.
        const probeTarget = process.platform === "win32" ? originalPid : -originalPid;
        const realKill = process.kill.bind(process);
        const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
          if (pid === probeTarget && signal === 0) {
            return true;
          }
          return realKill(pid, signal);
        });
        try {
          await expect(stopManagedProviderLocalServices()).rejects.toThrow(
            `Local model service process tree ${originalPid} did not stop`,
          );
          expect(hasManagedProviderLocalServices()).toBe(true);
        } finally {
          kill.mockRestore();
        }

        expect(isPidAlive(originalPid)).toBe(false);
        const replacementLease = await ensureProviderLocalService(target);
        if (!replacementLease) {
          throw new Error("Expected recovered provider local service lease");
        }
        const replacementPid = captureServicePid(healthUrl, pids);
        expect(replacementPid).not.toBe(originalPid);
        expect((await fetch(healthUrl)).ok).toBe(true);
        replacementLease.release();
        await stopManagedProviderLocalServices();
        expect(isPidAlive(replacementPid)).toBe(false);
        expect(hasManagedProviderLocalServices()).toBe(false);
        expect(await isPortFree(port)).toBe(true);
      },
      stopManagedProviderLocalServices,
      () => killOwnedServices(pids),
    );
  });
});
