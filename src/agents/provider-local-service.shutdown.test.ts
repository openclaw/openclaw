import { ChildProcess } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest, withTestTimeout } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { isPortFree } from "../test-utils/ports.js";
import { killPidIfAlive } from "../test-utils/process-tree.js";
import {
  ensureProviderLocalService,
  getManagedProviderLocalServiceDiagnosticsForTest,
  stopManagedProviderLocalServices,
} from "./provider-local-service.js";
import { createProviderLocalServiceTestFixture } from "./provider-local-service.test-support.js";
import { hasManagedProviderLocalServices } from "./provider-runtime-lifecycle.js";

function serviceTarget(
  port: number,
  providerId: string,
  script = `require("node:http").createServer((request,response)=>response.end("ready")).listen(${port},"127.0.0.1");`,
  idleStopMs = 0,
) {
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  return {
    providerId,
    baseUrl,
    service: {
      command: process.execPath,
      args: ["-e", script],
      healthUrl: `${baseUrl}/models`,
      readyTimeoutMs: 5_000,
      idleStopMs,
    },
  };
}

async function acquireService(target: ReturnType<typeof serviceTarget>) {
  const lease = await ensureProviderLocalService(target);
  if (!lease) {
    throw new Error("Expected provider local service lease");
  }
  return lease;
}

const servicePids = new Set<number>();
function captureServicePid(healthUrl: string): number {
  const pid = getManagedProviderLocalServiceDiagnosticsForTest().find(
    (service) => service.healthUrl === healthUrl,
  )?.pid;
  if (!pid) {
    throw new Error("Expected managed provider local service pid");
  }
  servicePids.add(pid);
  return pid;
}

const serviceClosures = new Map<ChildProcess, Promise<void>>();
// Retain the channel before the first spawn; Bun's channel registry holds it weakly.
const serviceSpawnChannel = channel("child_process");
const observeServiceSpawn = (message: unknown) => {
  if (
    message &&
    typeof message === "object" &&
    "process" in message &&
    message.process instanceof ChildProcess
  ) {
    const child = message.process;
    // Node publishes child_process from the constructor, before spawn assigns its PID.
    serviceClosures.set(
      child,
      new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      }),
    );
  }
};

async function killOwnedServices(pids: Set<number>, signal: AbortSignal): Promise<void> {
  for (const pid of pids) {
    killPidIfAlive(pid);
  }
  for (const pid of pids) {
    const closed = [...serviceClosures].find(([child]) => child.pid === pid)?.[1];
    if (!closed) {
      throw new Error(`Expected retained local service ${pid}`);
    }
    await withinTest(closed, signal);
    expect(isPidAlive(pid)).toBe(false);
  }
}

describe("provider local service shutdown", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const fixture = createProviderLocalServiceTestFixture();
  beforeEach(() => serviceSpawnChannel.subscribe(observeServiceSpawn));
  afterEach(async ({ signal }) => {
    await runQaGatewayFixture(
      fixture.cleanup,
      () => killOwnedServices(servicePids, signal),
      () => {
        serviceSpawnChannel.unsubscribe(observeServiceSpawn);
        serviceClosures.clear();
        servicePids.clear();
      },
    );
  });

  it("waits for a stubborn descendant after its parent exits", async () => {
    const port = await fixture.claimPort();
    const descendantPidPath = path.join(tempDirs.make("local-service-tree-"), "descendant.pid");
    let pid: number | undefined;
    let descendantPid: number | undefined;

    try {
      const lease = await acquireService(
        serviceTarget(
          port,
          "local-stubborn-stop",
          `const {spawn}=require("node:child_process");const fs=require("node:fs");const http=require("node:http");const child=spawn(process.execPath,["-e",'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);'],{stdio:"ignore"});fs.writeFileSync(${JSON.stringify(descendantPidPath)},String(child.pid));http.createServer((req,res)=>res.end("ok")).listen(${port},"127.0.0.1");`,
        ),
      );
      pid = captureServicePid(`http://127.0.0.1:${port}/v1/models`);
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
      const gate = createDeferred();
      const releaseGate = () => gate.resolve();
      const control = http.createServer((request, response) => {
        request.resume();
        stopping.resolve();
        void gate.promise.then(() => response.end("continue"));
      });
      control.listen(0, "127.0.0.1");
      await once(control, "listening");
      const address = control.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected local service control listener");
      }
      const controlUrl = `http://127.0.0.1:${address.port}/stopping`;
      const target = serviceTarget(
        port,
        "local-idle-stop-join",
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
        1,
      );
      const pending: Promise<unknown>[] = [];

      const capturePid = () => captureServicePid(healthUrl);
      await runQaGatewayFixture(
        async () => {
          const lease = await acquireService(target);
          const originalPid = capturePid();
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
          const replacement = acquireService(target)
            .then((nextLease) => {
              capturePid();
              return nextLease;
            })
            .finally(() => {
              acquisitionSettled = true;
            });
          pending.push(replacement);
          void replacement.catch(() => {});

          await nextEventLoopTurn();
          expect({ stopSettled, acquisitionSettled, alive: isPidAlive(originalPid) }).toEqual({
            stopSettled: false,
            acquisitionSettled: false,
            alive: true,
          });

          releaseGate();
          await stopped;
          const nextLease = await replacement;
          expect(capturePid()).not.toBe(originalPid);
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
    const target = serviceTarget(port, "local-late-lease-release");

    const capturePid = () => captureServicePid(healthUrl);
    const retiredLease = await acquireService(target);
    const retiredPid = capturePid();
    await stopManagedProviderLocalServices();
    expect(isPidAlive(retiredPid)).toBe(false);

    const replacementLease = await acquireService(target);
    const replacementPid = capturePid();
    expect(replacementPid).not.toBe(retiredPid);
    retiredLease.release();
    expect(hasManagedProviderLocalServices()).toBe(true);
    expect((await fetch(healthUrl)).ok).toBe(true);

    await stopManagedProviderLocalServices();
    expect(isPidAlive(replacementPid)).toBe(false);
    expect(await isPortFree(port)).toBe(true);
    replacementLease.release();
  });

  it("recovers on a later acquisition after a failed process-exit observation", async () => {
    const port = await fixture.claimPort();
    const healthUrl = `http://127.0.0.1:${port}/v1/models`;
    const target = serviceTarget(port, "local-stop-observation-recovery");

    const capturePid = () => captureServicePid(healthUrl);
    const lease = await acquireService(target);
    const originalPid = capturePid();
    const child = [...serviceClosures.keys()].find((spawned) => spawned.pid === originalPid);
    if (!child) {
      throw new Error("Expected the owned child process");
    }
    // Hold the platform's authoritative completion fact while the child really exits.
    let restoreObservation: () => void;
    if (process.platform === "win32") {
      const realEmit = child.emit.bind(child);
      let closeArgs: unknown[] | undefined;
      const emit = vi.spyOn(child, "emit").mockImplementation((event, ...args) => {
        if (event === "close") {
          closeArgs = args;
          return false;
        }
        return realEmit(event, ...args);
      });
      restoreObservation = () => {
        emit.mockRestore();
        if (closeArgs) {
          child.emit("close", ...closeArgs);
        }
      };
    } else {
      const realKill = process.kill.bind(process);
      const kill = vi.spyOn(process, "kill").mockImplementation((pid, processSignal) => {
        if (pid === -originalPid && processSignal === 0) {
          return true;
        }
        return realKill(pid, processSignal);
      });
      restoreObservation = () => kill.mockRestore();
    }
    const closed =
      process.platform === "win32"
        ? undefined
        : once(child, "close", { signal: AbortSignal.timeout(5_000) });
    try {
      if (closed) {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      }
      lease.release();
      const stopped = stopManagedProviderLocalServices();
      void stopped.catch(() => {});
      if (closed) {
        try {
          // Native close must finish before advancing the withheld observation's deadlines.
          await closed;
        } finally {
          await vi.runAllTimersAsync();
        }
      }
      await expect(stopped).rejects.toThrow(
        `Local model service process tree ${originalPid} did not stop`,
      );
      expect(hasManagedProviderLocalServices()).toBe(true);
    } finally {
      if (closed) {
        vi.useRealTimers();
      }
      restoreObservation();
    }

    expect(isPidAlive(originalPid)).toBe(false);
    const replacementLease = await acquireService(target);
    const replacementPid = capturePid();
    expect(replacementPid).not.toBe(originalPid);
    expect((await fetch(healthUrl)).ok).toBe(true);
    replacementLease.release();
    await stopManagedProviderLocalServices();
    expect(isPidAlive(replacementPid)).toBe(false);
    expect(hasManagedProviderLocalServices()).toBe(false);
    expect(await isPortFree(port)).toBe(true);
  });
});
