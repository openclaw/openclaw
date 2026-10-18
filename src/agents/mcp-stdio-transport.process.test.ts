import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { killPidIfAlive } from "../test-utils/process-tree.js";
import { OpenClawStdioClientTransport } from "./mcp-stdio-transport.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(process.platform === "win32")("OpenClaw stdio process-group ownership", () => {
  it(
    "kills same-group descendants after the leader exits spontaneously",
    { timeout: 10_000 },
    async ({ signal }) => {
      const root = tempDirs.make("mcp-stdio-descendant-");
      const serverPath = path.join(root, "leader.mjs");
      const exitMarkerPath = path.join(root, "exit.marker");
      await fs.writeFile(
        serverPath,
        `import {spawn} from "node:child_process"; import fs from "node:fs"; const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"fixture/descendant",params:{pid:child.pid}})+"\\n"); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(exitMarkerPath)})){clearInterval(timer);process.exit(1)}},10);`,
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
      const descendant = createDeferred<number>();
      // MCP transports expose callback properties rather than EventTarget listeners.
      // oxlint-disable-next-line unicorn/prefer-add-event-listener
      transport.onmessage = (message) => {
        if ("method" in message && message.method === "fixture/descendant") {
          const pid = message.params?.pid;
          if (typeof pid === "number") {
            descendant.resolve(pid);
          }
        }
      };
      let descendantPid = 0;
      try {
        await transport.start();
        descendantPid = await withinTest(descendant.promise, signal);
        expect(isPidAlive(descendantPid)).toBe(true);
        await fs.writeFile(exitMarkerPath, "exit", "utf8");
        await withinTest(closed, signal);
        // The transport reaps the group on its own here; its cleanup promise is private, so
        // observe the effect without calling close(), which would start that cleanup itself.
        while (isPidAlive(descendantPid)) {
          await delay(10, undefined, { signal });
        }

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
    async ({ signal }) => {
      const root = tempDirs.make("mcp-stdio-graceful-descendant-");
      const serverPath = path.join(root, "leader.mjs");
      await fs.writeFile(
        serverPath,
        `import {spawn} from "node:child_process"; const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"fixture/descendant",params:{pid:child.pid}})+"\\n"); process.stdin.resume(); process.stdin.on("end",()=>process.exit(0));`,
        "utf8",
      );
      const transport = new OpenClawStdioClientTransport({
        command: process.execPath,
        args: [serverPath],
        stderr: "ignore",
      });
      const descendant = createDeferred<number>();
      // MCP transports expose callback properties rather than EventTarget listeners.
      // oxlint-disable-next-line unicorn/prefer-add-event-listener
      transport.onmessage = (message) => {
        if ("method" in message && message.method === "fixture/descendant") {
          const pid = message.params?.pid;
          if (typeof pid === "number") {
            descendant.resolve(pid);
          }
        }
      };
      let descendantPid = 0;
      try {
        await transport.start();
        descendantPid = await withinTest(descendant.promise, signal);
        expect(isPidAlive(descendantPid)).toBe(true);

        await transport.close();

        expect(isPidAlive(descendantPid)).toBe(false);
      } finally {
        await transport.forceClose();
        killPidIfAlive(descendantPid || undefined);
      }
    },
  );
});
