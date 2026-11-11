import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { hasErrnoCode } from "../infra/errno.js";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "../process/supervisor/cancellation-policy.js";
import * as processLineage from "../process/supervisor/inherited-process-lineage.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { createMcpStdioClient, type McpStdioClient } from "./mcp-stdio-client.js";

const fixture = vi.hoisted(() => ({ preload: "", relay: undefined as ChildProcess | undefined }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof spawn>) => {
      const [command, argv, options] = args;
      if (fixture.preload && argv?.some((arg) => arg.includes("service-child-relay"))) {
        const child = actual.spawn(command, ["--import", fixture.preload, ...argv], options);
        fixture.relay = child;
        return child;
      }
      return actual.spawn(...args);
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const clients: McpStdioClient[] = [];
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});
afterEach(async () => {
  vi.restoreAllMocks();
  const relay = fixture.relay;
  if (relay && relay.exitCode === null && relay.signalCode === null) {
    const exited = once(relay, "exit");
    relay.kill("SIGKILL");
    await exited;
  }
  await Promise.allSettled(clients.splice(0).map((client) => client.stop()));
  fixture.preload = "";
  fixture.relay = undefined;
});

async function createFixture(
  hold: "relay" | "blocked-relay" | "anchor" | "anchor-kill-fails" = "relay",
) {
  // These faults target the retained two-process POSIX relay. The inherited
  // native owner takes precedence over platform detection and has no relay to hold.
  vi.spyOn(processLineage, "getInheritedNativeProcessOwner").mockReturnValue(undefined);
  mockProcessPlatform("darwin");
  const root = tempDirs.make("mcp-relay-retirement-");
  const preload = path.join(root, "retain-relay.mjs");
  const heldPath = path.join(root, "held-anchor");
  const releasePath = path.join(root, "release-anchor");
  await fs.writeFile(
    preload,
    hold === "relay" || hold === "blocked-relay"
      ? // The real relay disconnects only after reaping its real anchor. Hold that last step.
        hold === "blocked-relay"
        ? "process.disconnect = () => { while (true) {} };"
        : "process.disconnect = () => { setInterval(() => {}, 1000); };"
      : `import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
${fixtureReceiptClientSource(receipts.endpoint)}
if (process.argv.some(arg => arg.includes("service-child-group-anchor"))) {
  const exit = process.exit;
  process.on("SIGTERM", () => {});
  process.disconnect = () => {
    process.kill(0, "SIGTERM");
    fs.writeFileSync(${JSON.stringify(heldPath)}, String(process.pid));
    sendReceipt(${JSON.stringify(heldPath)}, "held-exit");
    setInterval(() => {
      if (fs.existsSync(${JSON.stringify(releasePath)})) exit(0);
    }, 10);
  };
} else {
  const spawn = cp.spawn;
  cp.spawn = (command, args, options) => {
    const anchor = args.some(arg => arg.includes("service-child-group-anchor"));
    const child = spawn(command, anchor ? ["--import", import.meta.url, ...args] : args, options);
    if (anchor && ${hold === "anchor-kill-fails"}) child.kill = () => false;
    return child;
  };
  syncBuiltinESMExports();
}`,
  );
  fixture.preload = pathToFileURL(preload).href;
  const createClient = () => {
    const client = createMcpStdioClient({
      command: process.execPath,
      args: [
        "-e",
        `require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
          const request = JSON.parse(line);
          if (request.id === undefined) return;
          const result = request.method === "initialize"
            ? { protocolVersion: "2025-06-18" } : { ok: true };
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
        }).on("close", () => process.exit(0));`,
      ],
      env: {},
      clientInfo: { name: "cleanup-test", version: "1" },
      protocolVersion: "2025-06-18",
      startupTimeoutMs: 10_000,
      maxPendingRequests: 4,
      maxFrameBytes: 1024,
      errors: {
        unavailable: (message, cause) => new Error(`unavailable: ${message}`, { cause }),
        protocol: (message, cause) => new Error(`protocol: ${message}`, { cause }),
      },
    });
    clients.push(client);
    return client;
  };
  const client = createClient();
  await expect(client.request("ping", {}, { timeoutMs: 10_000 })).resolves.toEqual({ ok: true });
  assert(fixture.relay, "expected the real relay");
  return { client, relay: fixture.relay, createClient, heldPath, releasePath };
}

describe.skipIf(process.platform === "win32")("MCP retained relay cleanup", () => {
  it.each(["accepted", "reported failure", "blocked relay"] as const)(
    "confirms forced relay exit and permits a fresh client after graceful cleanup stalls (%s)",
    async (signalReport) => {
      const { client, relay, createClient } = await createFixture(
        signalReport === "blocked relay" ? "blocked-relay" : "relay",
      );

      if (signalReport === "reported failure") {
        const kill = relay.kill.bind(relay);
        // Report failed delivery while the native exit is still on its way to the owner.
        vi.spyOn(relay, "kill").mockImplementation((signal) => {
          kill(signal);
          return false;
        });
      }

      await client.stop();
      const result = client.cleanupResult;
      expect(result).toMatchObject({
        reason: "forced-relay-exit",
        signalRequested: "SIGKILL",
        ...(signalReport === "reported failure" ? { signalError: expect.any(Error) } : {}),
        exit: { code: null, signal: "SIGKILL" },
        durationMs: expect.any(Number),
        escalationAfterMs: expect.any(Number),
      });
      expect(result?.durationMs).toBeLessThan(GRACEFUL_CANCEL_TIMEOUT_MS);
      expect(result?.escalationAfterMs).toBeGreaterThanOrEqual(2_000);
      expect(relay.signalCode).toBe("SIGKILL");

      fixture.preload = "";
      const next = createClient();
      await expect(next.request("ping", {}, { timeoutMs: 10_000 })).resolves.toEqual({ ok: true });
      await next.stop();
    },
  );

  it("retains timing and closure evidence when SIGKILL cannot be delivered", async () => {
    const { client, relay } = await createFixture();
    // A real process cannot ignore SIGKILL. Fault only delivery; native pipes and joins remain real.
    const kill = vi.spyOn(relay, "kill").mockReturnValue(false);
    await expect(client.stop()).rejects.toMatchObject({
      message: "unavailable: proxy cleanup could not be confirmed",
      cause: {
        message: expect.stringContaining('"relayExit":true'),
        cause: {
          message: expect.stringMatching(
            /service child cleanup owner: .*"durationMs":\d+.*"escalationAfterMs":\d+/,
          ),
          cause: expect.any(Error),
        },
      },
    });
    expect(kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("escalates and reaps an anchor whose group persists after its closing receipt", async ({
    signal,
  }) => {
    const { client, relay, heldPath, releasePath } = await createFixture("anchor");
    const exited = once(relay, "exit");
    const stopping = client.stop();
    void stopping.catch(() => {});
    try {
      await withinTest(
        Promise.race([
          receipts.waitFor(heldPath, "held-exit"),
          // The PID record precedes the receipt; relay exit can beat its delivery.
          stopping.then(
            async () => {
              expect(Number(await fs.readFile(heldPath, "utf8"))).toBeGreaterThan(0);
            },
            async (error: unknown) => {
              const held = await fs.readFile(heldPath, "utf8").catch((readError: unknown) => {
                if (hasErrnoCode(readError, "ENOENT")) {
                  return "";
                }
                throw readError;
              });
              if (!(Number(held) > 0)) {
                throw error;
              }
            },
          ),
        ]),
        signal,
      );
      const anchorPid = Number(await fs.readFile(heldPath, "utf8"));
      expect(anchorPid).toBeGreaterThan(0);
      // This is a real still-live process group, not a mocked absence result.
      expect(() => process.kill(-anchorPid, 0)).not.toThrow();
      await withinTest(stopping, signal);
      await withinTest(exited, signal);
      expect(client.cleanupResult).toMatchObject({
        signalRequested: "SIGKILL",
        escalationAfterMs: expect.any(Number),
      });
      expect(client.cleanupResult?.durationMs).toBeLessThan(GRACEFUL_CANCEL_TIMEOUT_MS);
      expect(() => process.kill(-anchorPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    } finally {
      await fs.writeFile(releasePath, "release");
      await exited;
    }
  });

  it("releases the reaper after the hard deadline without turning late exit into success", async () => {
    const { client, relay, releasePath } = await createFixture("anchor-kill-fails");
    const exited = once(relay, "exit");
    try {
      await expect(client.stop()).rejects.toMatchObject({
        cause: {
          cause: {
            message: expect.stringMatching(
              /service child cleanup owner: .*"escalationAfterMs":\d+/,
            ),
            cause: expect.any(Error),
          },
        },
      });
      expect(relay.connected).toBe(false);
      expect(client.cleanupResult).toBeUndefined();
    } finally {
      if (relay.connected) {
        relay.disconnect();
      }
      await fs.writeFile(releasePath, "release");
      await exited;
    }
    await expect(client.stop()).rejects.toThrow("cleanup could not be confirmed");
  });
});
