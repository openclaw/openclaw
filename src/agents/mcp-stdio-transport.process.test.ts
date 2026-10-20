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

async function fixture(shutdown: (marker: string) => string) {
  const root = tempDirs.make("mcp-stdio-descendant-");
  const serverPath = path.join(root, "leader.mjs");
  const marker = path.join(root, "exit.marker");
  await fs.writeFile(
    serverPath,
    `import {spawn} from "node:child_process"; import fs from "node:fs"; const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"fixture/descendant",params:{pid:child.pid}})+"\\n"); ${shutdown(marker)}`,
    "utf8",
  );
  const transport = new OpenClawStdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    stderr: "ignore",
  });
  const closed = createDeferred();
  const descendant = createDeferred<number>();
  // MCP transports expose callback properties rather than EventTarget listeners.
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  transport.onclose = () => closed.resolve();
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  transport.onmessage = (message) => {
    if ("method" in message && message.method === "fixture/descendant") {
      const pid = message.params?.pid;
      if (typeof pid === "number") {
        descendant.resolve(pid);
      }
    }
  };
  return { transport, marker, closed: closed.promise, descendant: descendant.promise };
}

async function withDescendant(
  signal: AbortSignal,
  shutdown: (marker: string) => string,
  run: (fixture: Awaited<ReturnType<typeof fixture>>, pid: number) => Promise<void>,
) {
  const f = await fixture(shutdown);
  let pid = 0;
  try {
    await f.transport.start();
    pid = await withinTest(f.descendant, signal);
    expect(isPidAlive(pid)).toBe(true);
    await run(f, pid);
    expect(isPidAlive(pid)).toBe(false);
  } finally {
    await f.transport.forceClose();
    killPidIfAlive(pid || undefined);
  }
}

describe.skipIf(process.platform === "win32")("OpenClaw stdio process-group ownership", () => {
  it(
    "kills same-group descendants after the leader exits spontaneously",
    { timeout: 10_000 },
    async ({ signal }) =>
      withDescendant(
        signal,
        (marker) =>
          `const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(timer);process.exit(1)}},10);`,
        async ({ transport, marker, closed }, pid) => {
          await fs.writeFile(marker, "exit", "utf8");
          await withinTest(closed, signal);
          // Observe automatic group cleanup before close() could initiate it itself.
          while (isPidAlive(pid)) {
            await delay(10, undefined, { signal });
          }
          await transport.close();
        },
      ),
  );

  it(
    "kills same-group descendants after a graceful leader shutdown",
    { timeout: 10_000 },
    async ({ signal }) =>
      withDescendant(
        signal,
        () => 'process.stdin.resume(); process.stdin.on("end",()=>process.exit(0));',
        async ({ transport }) => transport.close(),
      ),
  );
});
