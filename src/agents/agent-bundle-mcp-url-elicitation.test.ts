import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import { createSessionMcpRuntime } from "./agent-bundle-mcp-runtime.js";
import { readMcpConnectAction } from "./mcp-connect-action.js";
import { consumeMcpCodeModeGuestResult } from "./mcp-content.js";

const signInUrl = "https://tracker.example.test/signin?elicitation=renew-1";
const server = `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [log, mode] = process.argv.slice(2);
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const elicitation = { mode: "url", elicitationId: "renew-1", url: ${JSON.stringify(signInUrl)}, message: "Sign in again." };
let caps = {};
let call;
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    caps = m.params.capabilities;
    appendFileSync(log, JSON.stringify({ caps }) + "\\n");
    send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "tracker", version: "1" } } });
  } else if (m.method === "tools/list") {
    send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "list_issues", inputSchema: { type: "object" } }] } });
  } else if (m.method === "tools/call" && mode === "error") {
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32042, message: "Sign in again.", data: { elicitations: [elicitation] } } });
  } else if (m.method === "tools/call") {
    call = m.id;
    send({ jsonrpc: "2.0", id: 900, method: "elicitation/create", params: elicitation });
  } else if (m.id === 900) {
    appendFileSync(log, JSON.stringify({ answer: m.result }) + "\\n");
    send({ jsonrpc: "2.0", id: call, result: {
      content: [{ type: "text", text: "Only public issues are available." }],
      structuredContent: { issues: [{ id: "PUBLIC-1" }] },
    } });
  } else if (m.id !== undefined) {
    send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
`;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((task) => task()));
});

async function callTracker(mode: "request" | "error", chatType: "direct" | "group") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-url-elicitation-"));
  const serverPath = path.join(dir, "server.mjs");
  const logPath = path.join(dir, "server.log");
  await fs.writeFile(serverPath, server);
  const cfg = {
    mcp: { servers: { tracker: { command: process.execPath, args: [serverPath, logPath, mode] } } },
  };
  const runtime = createSessionMcpRuntime({
    sessionId: `url-elicitation-${mode}-${chatType}`,
    sessionKey: `agent:main:url-elicitation-${mode}-${chatType}`,
    workspaceDir: dir,
    cfg,
  });
  const tools = await materializeBundleMcpToolsForRun({
    runtime,
    operatorConnect: { cfg, senderIsOwner: true, chatType, isTurnTainted: () => false },
  });
  cleanup.push(async () => {
    await tools.dispose();
    await runtime.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const tool = tools.tools.find((entry) => entry.name === "tracker__list_issues")!;
  const result = await tool.execute("call-1", {}, undefined);
  const log = (await fs.readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { result, log };
}

it("answers URL elicitation with cancel and retains the completed fallback alongside Connect", async () => {
  const { result, log } = await callTracker("request", "direct");
  expect(log).toEqual([{ caps: { elicitation: { url: {} } } }, { answer: { action: "cancel" } }]);
  expect(readMcpConnectAction(result)).toEqual({
    serverName: "tracker",
    authorizationUrl: signInUrl,
  });
  expect(result).toMatchObject({
    content: [
      { type: "text", text: 'structuredContent:\n{"issues":[{"id":"PUBLIC-1"}]}' },
      { type: "text", text: "Only public issues are available." },
    ],
    details: { mcpTool: "list_issues", structuredContent: { issues: [{ id: "PUBLIC-1" }] } },
  });
  expect(consumeMcpCodeModeGuestResult(result)).toEqual({
    content: [{ type: "text", text: "Only public issues are available." }],
    structuredContent: { issues: [{ id: "PUBLIC-1" }] },
  });
});

it("shows a -32042 URL elicitation error as the Connect card", async () => {
  const { result } = await callTracker("error", "direct");
  expect(readMcpConnectAction(result)).toEqual({
    serverName: "tracker",
    authorizationUrl: signInUrl,
  });
});

it("gives group chats no sign-in link", async () => {
  const { result, log } = await callTracker("request", "group");
  expect(log.at(-1)).toEqual({ answer: { action: "cancel" } });
  expect(readMcpConnectAction(result)).toBeUndefined();
});
