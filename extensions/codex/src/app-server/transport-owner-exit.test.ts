import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolveTestNodeExecPath } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";

const fixture = fileURLToPath(new URL("./transport-owner-exit.test-helper.ts", import.meta.url));
const nodeExecPath = resolveTestNodeExecPath();

async function ownedProcesses(marker: string): Promise<string[]> {
  const ps = spawn("ps", ["-axo", "pid=,ppid=,stat=,command="], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const closed = once(ps, "close");
  const rows: string[] = [];
  for await (const line of createInterface({ input: ps.stdout })) {
    if (line.includes(marker)) {
      rows.push(line);
    }
  }
  expect((await closed)[0]).toBe(0);
  return rows;
}

describe.skipIf(process.platform === "win32")("Codex transport owner exit", () => {
  it.for(["native-killed", "hosted-native-stopped"])(
    "does not strand stopped Codex processes when the owner exits at %s",
    async (exitAt, context) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-owner-exit-"));
      const marker = path.join(root, "launcher");
      const owner = spawn(nodeExecPath, ["--import", "tsx", fixture, marker, exitAt], {
        env: { HOME: root, PATH: process.env.PATH, TMPDIR: root, NODE_ENV: "test" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      owner.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
      owner.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
      const closed = once(owner, "close");
      context.onTestFinished(async () => {
        owner.kill("SIGKILL");
        for (const row of await ownedProcesses(marker)) {
          try {
            process.kill(Number(row.trim().split(/\s+/)[0]), "SIGKILL");
          } catch {
            // The test-owned process may have exited between the census and signal.
          }
        }
        await closed;
        await fs.rm(root, { recursive: true, force: true });
      });
      expect(await closed, output).toEqual([0, null]);
      expect(output).toMatch(/\bT/);
      await expect.poll(() => ownedProcesses(marker), { timeout: 2_000 }).toEqual([]);
    },
  );
});
