import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPidAlive } from "../../shared/pid-alive.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { peekSessionMcpRuntime, retireSessionMcpRuntime } from "../agent-bundle-mcp-manager-api.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
import { AuthStorage } from "../sessions/auth-storage.js";
import { ModelRegistry } from "../sessions/model-registry.js";
import { buildCodexUserMcpServersThreadConfigPatchForRun } from "./bundle-mcp-codex.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(process.platform === "win32")("native MCP discovery ownership", () => {
  it.each(["app-server", "cli"] as const)(
    "%s keeps prepared servers usable until session end and retires excluded discovery servers",
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
const relay = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(process.ppid)], { encoding: "utf8" }).trim());
appendFileSync(process.argv[2], JSON.stringify({ server: process.argv[3], pids: [process.pid, process.ppid, relay] }) + "\\n");
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "discovery", version: "1" } });
  if (message.method === "tools/list") send(message.id, { tools: [{ name: "read_note", description: "Synthetic note", inputSchema: { type: "object", properties: {} } }] });
  if (message.method === "tools/call") send(message.id, { content: [{ type: "text", text: "session tool is still connected" }] });
});
`,
      );
      const children = async (): Promise<Array<{ server: string; pids: number[] }>> =>
        (await fs.readFile(pidPath, "utf8"))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { server: string; pids: number[] });
      const sessions: string[] = [];
      const authStorage = AuthStorage.inMemory();
      await withEnvAsync({ OPENCLAW_STATE_DIR: workspaceDir }, async () => {
        try {
          for (const denied of [false, false, false, true]) {
            const sessionId = `${adapter}-discovery-${sessions.length}`;
            sessions.push(sessionId);
            const sessionKey = `agent:main:${sessionId}`;
            const before = (await children()).length;
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
              const patch = await buildCodexUserMcpServersThreadConfigPatchForRun({
                cwd: workspaceDir,
                run: {
                  agentId: "main",
                  sessionId,
                  sessionKey,
                  sessionFile: sessionKey,
                  workspaceDir,
                  config,
                  prompt: "hello",
                  timeoutMs: 5_000,
                  runId: sessionId,
                  provider: "openai",
                  modelId: "gpt-5.6-luna",
                  model: {
                    id: "gpt-5.6-luna",
                    name: "Test model",
                    api: "openai-responses",
                    provider: "openai",
                    baseUrl: "http://127.0.0.1:1",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 100_000,
                    maxTokens: 1_000,
                  },
                  authStorage,
                  authProfileStore: { version: 1, profiles: {} },
                  modelRegistry: ModelRegistry.inMemory(authStorage),
                  thinkLevel: "off",
                },
              });
              expect(Object.keys(patch?.mcp_servers ?? {})).toEqual(
                denied ? [] : ["alpha", "beta"],
              );
            } else {
              const prepared = await prepareCliBundleMcpConfig({
                enabled: true,
                mode: "codex-config-overrides",
                backend: { command: "codex", args: ["exec"] },
                workspaceDir,
                config,
                nativeMcpPolicy: {
                  sessionId,
                  sessionKey,
                  capabilityProfile: resolveConversationCapabilityProfile({
                    config,
                    agentId: "main",
                    sessionId,
                    sessionKey,
                    workspaceDir,
                  }),
                },
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
              denied ? [] : ["alpha", "beta"],
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
            expect((await children()).flatMap((child) => child.pids).filter(isPidAlive)).toEqual(
              [],
            );
          }
          const spawned = await children();
          expect(spawned).toHaveLength(9);
        } finally {
          for (const sessionId of sessions) {
            await retireSessionMcpRuntime({ sessionId, reason: "discovery-test-cleanup" });
          }
        }
      });
    },
  );
});
