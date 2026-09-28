import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { JSONRPCRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isPidAlive, isPidDefinitelyDead } from "../shared/pid-alive.js";
import { settlesWithin } from "../shared/settle-within.js";
import { killPidIfAlive } from "../test-utils/process-tree.js";
import {
  connectMcpClient,
  disposeMcpClient,
  McpClientConnectTimeoutError,
} from "./mcp-client-lifecycle.js";
import { OpenClawStdioClientTransport } from "./mcp-stdio-transport.js";
import { createAgentCleanupScope } from "./run-cleanup-timeout.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(process.platform === "win32")("OpenClaw stdio process-group ownership", () => {
  it(
    "contains a real SDK initialize timeout and reaps its descendants before reconnecting",
    { timeout: 45_000 },
    async () => {
      const root = tempDirs.make("mcp-stdio-initialize-timeout-");
      const nonce = randomUUID();
      const serverPath = path.join(root, "server.mjs");
      const timeoutMs = 10_000;
      const hostPid = process.pid;
      await fs.writeFile(
        serverPath,
        `import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
const [mode, role, nonce] = process.argv.slice(2);
const root = process.cwd();
const marker = (name) => path.join(root, mode + "-" + name);
fs.fstatSync(3);
// EOF and TERM must not satisfy cleanup before the owner escalates the whole group.
const ignoreTerm = () => {};
const keepAliveAfterEof = () => {};
process.on("SIGTERM", ignoreTerm);
process.stdin.on("end", keepAliveAfterEof);
const identity = {
  nonce, pid: process.pid, parentPid: process.ppid, cwd: root, lineageOpen: true,
  termHandlerInstalled: process.listeners("SIGTERM").includes(ignoreTerm),
  eofHandlerInstalled: process.stdin.listeners("end").includes(keepAliveAfterEof),
};
const record = (name, value) => {
  fs.writeFileSync(marker(name + ".pending"), JSON.stringify(value));
  fs.renameSync(marker(name + ".pending"), marker(name + ".json"));
};
// Self-exit bounds an orphan even if the test worker dies; reaching it is never proof.
setTimeout(() => {
  fs.writeFileSync(marker(role + ".hard-cap"), nonce);
  process.exit(72);
}, 30_000);
setInterval(() => {
  if (fs.existsSync(marker("release"))) process.exit(0);
}, 25);
if (role === "descendant") {
  record("descendant", identity);
} else {
  record("leader", identity);
  // No secret descriptor is requested: the owned anchor reserves command fd 3 for lineage.
  const child = spawn(process.execPath, [import.meta.filename, mode, "descendant", nonce], {
    cwd: root, env: process.env, detached: false, stdio: ["ignore", "ignore", "inherit", 3],
  });
  child.on("error", (error) => { throw error; });
  const ready = setInterval(() => {
    if (!fs.existsSync(marker("descendant.json"))) return;
    const descendant = JSON.parse(fs.readFileSync(marker("descendant.json"), "utf8"));
    if (descendant.nonce !== nonce || descendant.pid !== child.pid) process.exit(73);
    clearInterval(ready);
    const lines = createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      const request = JSON.parse(line);
      if (request.method === "initialize") {
        record("initialize", { ...identity, descendantPid: child.pid, request });
        if (mode === "stall") return;
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", id: request.id,
          result: {
            protocolVersion: request.params.protocolVersion,
            capabilities: {}, serverInfo: { name: "owned-process-fixture", version: "1" },
          },
        }) + "\\n");
      } else if (request.method === "ping") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");
      }
    });
  }, 25);
}
`,
        "utf8",
      );
      const createSession = (mode: "stall" | "healthy") => ({
        mode,
        client: new Client({ name: "initialize-timeout-proof", version: "1" }),
        transport: new OpenClawStdioClientTransport({
          command: process.execPath,
          args: [serverPath, mode, "leader", nonce],
          cwd: root,
          env: { HOME: root, TMPDIR: root },
          exactEnv: true,
          stderr: "inherit",
        }),
      });
      const stalled = createSession("stall");
      const healthy = createSession("healthy");
      const sessions = [stalled, healthy];
      const admittedPids = new Set<number>();
      const readIdentity = async (mode: string, role: string) => {
        const receipt: unknown = JSON.parse(
          await fs.readFile(path.join(root, `${mode}-${role}.json`), "utf8"),
        );
        if (!isRecord(receipt) || typeof receipt.pid !== "number") {
          throw new Error("Missing fixture process identity");
        }
        expect(receipt).toMatchObject({
          nonce,
          cwd: root,
          lineageOpen: true,
          termHandlerInstalled: true,
          eofHandlerInstalled: true,
        });
        expect(Number.isSafeInteger(receipt.pid)).toBe(true);
        expect(receipt.pid).toBeGreaterThan(0);
        expect(receipt.pid).not.toBe(hostPid);
        admittedPids.add(receipt.pid);
        return {
          pid: receipt.pid,
          parentPid: receipt.parentPid,
          descendantPid: receipt.descendantPid,
          request: receipt.request,
        };
      };
      const unhandled: unknown[] = [];
      const onUnhandled = (error: unknown) => {
        unhandled.push(error);
      };
      const pending: Promise<unknown>[] = [];
      const failures: unknown[] = [];
      const cleanupScope = createAgentCleanupScope();
      process.on("unhandledRejection", onUnhandled);
      try {
        let connectionSettled = false;
        const startedAt = performance.now();
        // Observe rejection immediately: readiness assertions must not orphan the SDK's promise.
        const connecting = cleanupScope
          .run(() =>
            connectMcpClient({
              client: stalled.client,
              transport: stalled.transport,
              timeoutMs,
            }),
          )
          .then(
            () => {
              connectionSettled = true;
              return undefined;
            },
            (error: unknown) => {
              connectionSettled = true;
              return error;
            },
          );
        pending.push(connecting);
        let leaderPid = 0;
        let descendantPid = 0;
        await vi.waitFor(
          async () => {
            const leader = await readIdentity("stall", "initialize");
            const descendant = await readIdentity("stall", "descendant");
            const initialize = JSONRPCRequestSchema.parse(leader.request);
            expect(initialize.method).toBe("initialize");
            // The SDK's first request ID is zero, not a truthy/positive sentinel.
            expect(initialize.id).toBe(0);
            expect(leader.pid).toBe(stalled.transport.pid);
            expect(leader.descendantPid).toBe(descendant.pid);
            expect(descendant.pid).not.toBe(leader.pid);
            expect(descendant.parentPid).toBe(leader.pid);
            leaderPid = leader.pid;
            descendantPid = descendant.pid;
            expect(isPidAlive(leaderPid)).toBe(true);
            expect(isPidAlive(descendantPid)).toBe(true);
            expect(connectionSettled).toBe(false);
            expect(performance.now() - startedAt).toBeLessThan(timeoutMs);
          },
          { timeout: 5_000, interval: 25 },
        );

        expect(await settlesWithin(connecting, timeoutMs + 3_000)).toBe(true);
        expect(await connecting).toBeInstanceOf(McpClientConnectTimeoutError);
        // These assertions precede all test-side close/release calls: only timeout disposal ran.
        expect(cleanupScope.outcome).toBe("closed");
        expect(stalled.transport.pid).toBeNull();
        expect(isPidDefinitelyDead(leaderPid)).toBe(true);
        expect(isPidDefinitelyDead(descendantPid)).toBe(true);
        expect((await fs.readdir(root)).filter((name) => name.endsWith(".hard-cap"))).toEqual([]);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(unhandled).toEqual([]);
        expect(process.pid).toBe(hostPid);
        expect(isPidAlive(hostPid)).toBe(true);

        await connectMcpClient({
          client: healthy.client,
          transport: healthy.transport,
          timeoutMs,
        });
        const healthyLeader = await readIdentity("healthy", "initialize");
        const healthyDescendant = await readIdentity("healthy", "descendant");
        expect(healthyLeader.pid).toBe(healthy.transport.pid);
        expect(healthyDescendant.parentPid).toBe(healthyLeader.pid);
        expect(healthy.client.getServerVersion()).toEqual({
          name: "owned-process-fixture",
          version: "1",
        });
        await expect(healthy.client.ping({ timeout: 2_000 })).resolves.toEqual({});
        await expect(
          disposeMcpClient({
            client: healthy.client,
            transport: healthy.transport,
            transportType: "stdio",
          }),
        ).resolves.toBe("closed");
        expect(isPidDefinitelyDead(healthyLeader.pid)).toBe(true);
        expect(isPidDefinitelyDead(healthyDescendant.pid)).toBe(true);
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          // Rescue addresses only owned handles and nonce-private markers, never recorded PIDs.
          const cleanup = Promise.allSettled([
            ...sessions.map(({ transport }) => transport.forceClose()),
            ...sessions.map(({ mode }) => fs.writeFile(path.join(root, `${mode}-release`), nonce)),
            ...pending,
          ]);
          expect(await settlesWithin(cleanup, 10_000), "fixture cleanup did not settle").toBe(true);
          for (const result of await cleanup) {
            if (result.status === "rejected") {
              failures.push(result.reason);
            }
          }
          await vi.waitFor(
            () => {
              for (const pid of admittedPids) {
                expect(isPidDefinitelyDead(pid), "fixture process survived owner cleanup").toBe(
                  true,
                );
              }
            },
            { timeout: 2_000, interval: 25 },
          );
          expect((await fs.readdir(root)).filter((name) => name.endsWith(".hard-cap"))).toEqual([]);
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(unhandled).toEqual([]);
        } catch (error) {
          failures.push(error);
        } finally {
          process.off("unhandledRejection", onUnhandled);
        }
      }
      // Report after teardown so cleanup cannot replace the original regression.
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "MCP timeout proof and cleanup failed");
      }
    },
  );

  it(
    "kills same-group descendants after the leader exits spontaneously",
    { timeout: 10_000 },
    async () => {
      const root = tempDirs.make("mcp-stdio-descendant-");
      const serverPath = path.join(root, "leader.mjs");
      const descendantPidPath = path.join(root, "descendant.pid");
      const exitMarkerPath = path.join(root, "exit.marker");
      await fs.writeFile(
        serverPath,
        `import {spawn} from "node:child_process"; import fs from "node:fs"; const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); fs.writeFileSync(${JSON.stringify(descendantPidPath)},String(child.pid)); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(exitMarkerPath)})){clearInterval(timer);process.exit(1)}},10);`,
        "utf8",
      );
      const transport = new OpenClawStdioClientTransport({
        command: process.execPath,
        args: [serverPath],
        stderr: "ignore",
      });
      const closed = new Promise<void>((resolve) => {
        // MCP transports expose callback properties rather than EventTarget listeners.
        // oxlint-disable-next-line unicorn/prefer-add-event-listener
        transport.onclose = resolve;
      });
      let descendantPid = 0;
      try {
        await transport.start();
        await vi.waitFor(async () => {
          descendantPid = Number(await fs.readFile(descendantPidPath, "utf8"));
          expect(isPidAlive(descendantPid)).toBe(true);
        });
        await fs.writeFile(exitMarkerPath, "exit", "utf8");
        await closed;
        await vi.waitFor(() => expect(isPidAlive(descendantPid)).toBe(false));

        await transport.close();
        expect(isPidAlive(descendantPid)).toBe(false);
      } finally {
        await transport.forceClose();
        killPidIfAlive(descendantPid || undefined);
      }
    },
  );

  it(
    "kills same-group descendants after a graceful leader shutdown",
    { timeout: 10_000 },
    async () => {
      const root = tempDirs.make("mcp-stdio-graceful-descendant-");
      const serverPath = path.join(root, "leader.mjs");
      const descendantPidPath = path.join(root, "descendant.pid");
      await fs.writeFile(
        serverPath,
        `import {spawn} from "node:child_process"; import fs from "node:fs"; const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); fs.writeFileSync(${JSON.stringify(descendantPidPath)},String(child.pid)); process.stdin.resume(); process.stdin.on("end",()=>process.exit(0));`,
        "utf8",
      );
      const transport = new OpenClawStdioClientTransport({
        command: process.execPath,
        args: [serverPath],
        stderr: "ignore",
      });
      let descendantPid = 0;
      try {
        await transport.start();
        await vi.waitFor(async () => {
          descendantPid = Number(await fs.readFile(descendantPidPath, "utf8"));
          expect(isPidAlive(descendantPid)).toBe(true);
        });

        await transport.close();

        await vi.waitFor(() => expect(isPidAlive(descendantPid)).toBe(false));
      } finally {
        await transport.forceClose();
        killPidIfAlive(descendantPid || undefined);
      }
    },
  );
});
