import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { text } from "node:stream/consumers";
import { afterEach, beforeEach, type TestContext } from "vitest";
import { resetCodexTestBindingStore } from "./session-binding.test-helpers.js";
import { resetThreadLifecycleTestFixtures } from "./thread-lifecycle.test-fixtures.js";
import { listenForNativeResponses } from "./thread-native.test-support.js";

let currentTest: TestContext;
export let tempDir = "";

export function setupUserMcpServerTestHooks(): void {
  beforeEach(async (context) => {
    currentTest = context;
    if (!context.codexAttemptRuntime) {
      throw new Error("Codex MCP server tests require the shared extension runtime fixture");
    }
    await context.codexAttemptRuntime.start();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-80814-"));
    // Session identities survive fresh temp directories.
    resetCodexTestBindingStore();
  });

  afterEach(async (context) => {
    if (!context.codexAttemptRuntime) {
      throw new Error("Codex MCP server tests require the shared extension runtime fixture");
    }
    resetThreadLifecycleTestFixtures();
    await context.codexAttemptRuntime.stop();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
}

export async function startPolicyHttpServer(): Promise<string> {
  const port = await listenForNativeResponses(currentTest, (request, response) => {
    void (async () => {
      const body = await text(request);
      const message = (body ? JSON.parse(body) : {}) as {
        id?: string | number;
        method?: string;
      };
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "policy-http-probe", version: "1" },
            }
          : message.method === "tools/list"
            ? {
                tools: [
                  { name: "read_docs", description: "read", inputSchema: { type: "object" } },
                ],
              }
            : {};
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    })();
  });
  return `http://127.0.0.1:${port}/mcp`;
}

export async function writePolicyProbeServer(dir: string): Promise<string> {
  const filePath = path.join(dir, "policy-probe.mjs");
  await fs.writeFile(
    filePath,
    `import readline from "node:readline";
import { appendFileSync } from "node:fs";
if (process.env.OPENCLAW_POLICY_PROBE_STARTED) appendFileSync(process.env.OPENCLAW_POLICY_PROBE_STARTED, "started\\n");
const lines = readline.createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "policy-probe", version: "1" } });
  if (message.method === "tools/list") send(message.id, { tools: [
    { name: "read_docs", description: "read", inputSchema: { type: "object" } },
    { name: "delete_docs", description: "delete", inputSchema: { type: "object" } },
    { name: "task_docs", description: "task", inputSchema: { type: "object" }, execution: { taskSupport: "required" } },
    { name: "app_docs", description: "app", inputSchema: { type: "object" }, _meta: { ui: { visibility: ["app"] } } }
  ] });
});
`,
    "utf-8",
  );
  return filePath;
}
