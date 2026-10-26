import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getSpawnBroker } from "../../process/spawn-broker/context.js";
import { isPidAlive } from "../../shared/pid-alive.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  disposeAllSessionMcpRuntimes,
  peekSessionMcpRuntime,
  retireSessionMcpRuntime,
} from "../agent-bundle-mcp-manager-api.js";
import { bindSessionMcpRuntimeTestScheduler } from "../agent-bundle-mcp-manager.test-support.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";
import {
  cliNativeMcpPolicyContext,
  prepareNativeMcpTestConfig,
} from "./bundle-mcp.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(bindSessionMcpRuntimeTestScheduler);
afterEach(disposeAllSessionMcpRuntimes);

it.skipIf(process.platform === "win32").each(["app-server", "cli"] as const)(
  "%s native MCP discovery keeps prepared servers usable until session end and retires excluded discovery servers",
  async (adapter) => {
    const workspaceDir = tempDirs.make("openclaw-mcp-discovery-");
    const pidPath = path.join(workspaceDir, "children.jsonl");
    const serverPath = path.join(workspaceDir, "server.mjs");
    await fs.writeFile(pidPath, "");
    await fs.writeFile(
      serverPath,
      `import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import readline from "node:readline";
const grandparent = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(process.ppid)], { encoding: "utf8" }).trim());
appendFileSync(process.argv[2], JSON.stringify({ server: process.argv[3], pids: [process.pid, process.ppid, grandparent] }) + "\\n");
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "discovery", version: "1" } });
  if (message.method === "tools/list") send(message.id, { tools: [{ name: "read_note", description: "Synthetic note", inputSchema: { type: "object", properties: {} } }] });
  if (message.method === "tools/call") send(message.id, { content: [{ type: "text", text: "session tool is still connected" }] });
});
`,
    );
    const children = async (): Promise<Array<{ server: string; pids: number[] }>> => {
      // Do not count the shared host/broker as a server-owned process.
      const hosts = new Set([process.pid, getSpawnBroker()?.pid]);
      return (await fs.readFile(pidPath, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const child = JSON.parse(line) as { server: string; pids: number[] };
          child.pids = child.pids.filter((pid) => !hosts.has(pid));
          return child;
        });
    };
    const sessions: string[] = [];
    await withEnvAsync({ OPENCLAW_STATE_DIR: workspaceDir }, async () => {
      try {
        for (const denied of [false, false, false, true]) {
          const sessionId = `${adapter}-discovery-${sessions.length}`;
          sessions.push(sessionId);
          const before = (await children()).length;
          const expectedServers = denied ? [] : ["alpha", "beta"];
          const config: OpenClawConfig = {
            plugins: { enabled: false },
            agents: {
              entries: {
                main: { tools: { deny: denied ? ["bundle-mcp"] : ["excluded__read_note"] } },
              },
            },
            mcp: {
              servers: Object.fromEntries(
                ["alpha", "beta", "excluded"].map((server) => [
                  server,
                  { command: process.execPath, args: [serverPath, pidPath, server] },
                ]),
              ),
            },
          };
          if (adapter === "app-server") {
            const patch = await prepareNativeMcpTestConfig({ workspaceDir, sessionId, config });
            expect(Object.keys(patch?.mcp_servers ?? {})).toEqual(expectedServers);
          } else {
            const prepared = await prepareCliBundleMcpConfig({
              enabled: true,
              mode: "codex-config-overrides",
              backend: { command: "codex", args: ["exec"] },
              workspaceDir,
              config,
              nativeMcpPolicy: cliNativeMcpPolicyContext(config, sessionId, workspaceDir),
            });
            try {
              const projected = prepared.backend.args?.find((arg) =>
                arg.startsWith("mcp_servers="),
              );
              expect(projected?.includes("read_note") ?? false).toBe(!denied);
            } finally {
              await prepared.cleanup?.();
            }
          }
          const runtime = peekSessionMcpRuntime({ sessionId });
          expect(runtime?.peekCatalog()?.tools.map((tool) => tool.serverName) ?? []).toEqual(
            expectedServers,
          );
          const started = (await children()).slice(before);
          expect(started).toHaveLength(denied ? 0 : 3);
          if (!denied) {
            expect(await runtime!.callTool("alpha", "read_note", {})).toMatchObject({
              content: [{ type: "text", text: "session tool is still connected" }],
            });
            const retained = started.filter((child) => child.server !== "excluded");
            expect(retained.flatMap((child) => child.pids).every(isPidAlive)).toBe(true);
            const excluded = started.find((child) => child.server === "excluded")!;
            expect(excluded.pids.filter(isPidAlive)).toEqual([]);
          }
          await retireSessionMcpRuntime({
            sessionId,
            reason: "session-end",
            preserveActiveLeases: true,
          });
          expect((await children()).flatMap((child) => child.pids).filter(isPidAlive)).toEqual([]);
        }
        expect(await children()).toHaveLength(9);
      } finally {
        for (const sessionId of sessions) {
          await retireSessionMcpRuntime({ sessionId, reason: "discovery-test-cleanup" });
        }
      }
    });
  },
);
