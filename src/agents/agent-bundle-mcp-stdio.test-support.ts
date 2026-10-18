import { setTimeout as waitForRuntimeTick } from "node:timers/promises";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { fixtureReceiptClientSource } from "../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../test/helpers/promise.js";
import { writeExecutable } from "./bundle-mcp-shared.test-harness.js";

type FixtureTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  execution?: { taskSupport?: "forbidden" | "optional" | "required" };
  _meta?: Record<string, unknown>;
};

export async function writeListToolsMcpServer(
  params: {
    filePath: string;
    logPath: string;
    delayMs?: number;
    listToolsReleasePath?: string;
    initializeDelayMs?: number;
    initializeReleaseToken?: string;
    hang?: boolean;
    ignoreShutdown?: boolean;
    hangFirstInitializeMarkerPath?: string;
    inputSchema?: unknown;
    tools?: FixtureTool[];
    toolsByList?: FixtureTool[][];
    capabilities?: Record<string, unknown>;
    databasePath?: string;
    pidPath?: string;
    hangToolCallsUntilRestartMarkerPath?: string;
    notifyListChangedOnInitialized?: boolean;
    notifyListChangedOnInitializedReleaseToken?: string;
    notifyListChangedAfterFirstList?: boolean;
    notifyListChangedReleasePath?: string;
    exitOnListCall?: number;
    listToolsMethodNotFound?: boolean;
    listToolsJsonRpcErrorMessage?: string;
    toolPageCursors?: Array<string | null>;
    callToolJsonRpcError?: boolean;
    callToolJsonRpcErrorCode?: number;
    callToolResult?: CallToolResult;
    callToolReleasePath?: string;
    notifyListChangedOnToolCall?: boolean;
    resourcePageCursors?: Array<string | null>;
    resourceReadJsonRpcError?: boolean;
    resourceReadResult?: ReadResourceResult;
    promptPageCursors?: Array<string | null>;
    /** Holds resources/list and prompts/list replies until this file exists. */
    utilityListReleasePath?: string;
  },
  receiptEndpoint: string,
): Promise<void> {
  await writeExecutable(
    params.filePath,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import fs from "node:fs/promises";
import { createInterface } from "node:readline";

${fixtureReceiptClientSource(receiptEndpoint)}

const config = ${JSON.stringify(params)};
const { logPath, databasePath, pidPath, hangFirstInitializeMarkerPath } = config;
const delayMs = config.delayMs ?? 0;
const tools = config.tools ?? [{ name: "slow_tool", description: "Returned after a slow catalog response.", inputSchema: config.inputSchema ?? { type: "object", properties: {} } }];

const exists = (filePath) => fs.access(filePath).then(() => true, () => false);
async function waitForPath(filePath) {
  while (filePath && !(await exists(filePath))) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const listCounts = { tools: 0, resources: 0, prompts: 0 };
let pendingTimer;
let keepAlive;
let database;
let hangToolCallsUntilRestart = false;
const firstInitialize = hangFirstInitializeMarkerPath
  ? await fs.writeFile(hangFirstInitializeMarkerPath, String(process.pid), { flag: "wx" })
      .then(() => true, () => false)
  : false;
if (firstInitialize) {
  log("first initialize pid " + process.pid);
}
if (databasePath) {
  const { DatabaseSync } = await import("node:sqlite");
  database = new DatabaseSync(databasePath);
  database.exec("PRAGMA busy_timeout = 0; CREATE TABLE IF NOT EXISTS lock_probe (value TEXT); BEGIN IMMEDIATE; INSERT INTO lock_probe VALUES ('held')");
}
if (pidPath) {
  await fs.writeFile(pidPath, String(process.pid), "utf8");
}
if (config.hangToolCallsUntilRestartMarkerPath) {
  hangToolCallsUntilRestart = !(await exists(config.hangToolCallsUntilRestartMarkerPath));
  if (hangToolCallsUntilRestart) {
    await fs.writeFile(config.hangToolCallsUntilRestartMarkerPath, String(process.pid), "utf8");
  }
}
function log(line) {
  appendFileSync(logPath, line + "\\n", "utf8");
  sendReceipt(logPath, line);
}
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}
function notifyToolsChanged(context = "") {
  log("notify tools/list_changed" + context);
  send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
}
async function afterPath(filePath, callback) {
  await waitForPath(filePath);
  callback();
}
function hangRequest(method) {
  log("hang " + method);
  keepAlive = setInterval(() => {}, 1000);
}
function nextCursor(cursor) {
  return cursor !== undefined && cursor !== null ? { nextCursor: cursor } : {};
}
function handle(message) {
  if (!message || typeof message !== "object") {
    return;
  }
  log("recv " + String(message.method ?? "unknown"));
  if (message.method === "initialize") {
    if (firstInitialize) {
      log("slow first initialize");
      return;
    }
    if (hangFirstInitializeMarkerPath) {
      log("fast retry initialize");
    }
    const respond = () => reply(message.id, {
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities: config.capabilities ?? { tools: {} },
        serverInfo: { name: "test-list-tools", version: "1.0.0" },
    });
    if (config.initializeReleaseToken) {
      void awaitRelease(logPath, config.initializeReleaseToken).then(respond);
    } else if (config.initializeDelayMs > 0) {
      setTimeout(respond, config.initializeDelayMs);
    } else {
      respond();
    }
    return;
  }
  if (message.method === "notifications/initialized") {
    if (config.notifyListChangedOnInitialized) {
      void (async () => {
        if (config.notifyListChangedOnInitializedReleaseToken) {
          await awaitRelease(logPath, config.notifyListChangedOnInitializedReleaseToken);
        }
        notifyToolsChanged();
      })();
    }
    return;
  }
  if (message.method === "tools/list") {
    listCounts.tools += 1;
    log("tools/list cursor " + JSON.stringify(message.params?.cursor));
    if (listCounts.tools === config.exitOnListCall) {
      log("exit tools/list " + listCounts.tools);
      process.exit(1);
    }
    if (config.listToolsMethodNotFound) {
      log("reject tools/list method not found");
      fail(message.id, -32601, "Method not found");
      return;
    }
    if (config.listToolsJsonRpcErrorMessage) {
      log("reject tools/list with configured error");
      fail(message.id, -32000, config.listToolsJsonRpcErrorMessage);
      return;
    }
    if (config.hang) {
      hangRequest(message.method);
      return;
    }
    const currentListCount = listCounts.tools;
    log("delay tools/list " + delayMs);
    const sendListResponse = () => {
      reply(message.id, {
        tools: config.toolsByList
            ? config.toolsByList[Math.min(currentListCount - 1, config.toolsByList.length - 1)]
            : config.toolPageCursors
              ? tools.map((tool) => ({ ...tool, name: tool.name + "-" + currentListCount }))
              : tools,
        ...nextCursor(config.toolPageCursors?.[currentListCount - 1]),
      });
      if (config.notifyListChangedAfterFirstList && currentListCount === 1) {
        void afterPath(config.notifyListChangedReleasePath, () => notifyToolsChanged());
      }
    };
    void afterPath(config.listToolsReleasePath, () => {
      pendingTimer = setTimeout(sendListResponse, delayMs);
    });
  }
  if (message.method === "tools/call") {
    if (hangToolCallsUntilRestart) {
      hangRequest(message.method);
      return;
    }
    if (config.callToolJsonRpcError) {
      fail(message.id, config.callToolJsonRpcErrorCode ?? -32000, "tool request failed");
      return;
    }
    if (config.notifyListChangedOnToolCall) {
      notifyToolsChanged(" during tools/call");
    }
    void afterPath(config.callToolReleasePath, () => {
      reply(message.id, {
        isError: false,
        ...(config.callToolResult ?? { content: [{ type: "text", text: "tool ok" }] }),
      });
    });
  }
  if (message.method === "resources/list" || message.method === "prompts/list") {
    const resources = message.method === "resources/list";
    const page = ++listCounts[resources ? "resources" : "prompts"];
    const cursors = resources ? config.resourcePageCursors : config.promptPageCursors;
    log(message.method + " cursor " + JSON.stringify(message.params?.cursor));
    void afterPath(config.utilityListReleasePath, () => {
      reply(message.id, {
        ...(resources
          ? { resources: cursors ? [{ uri: "memo://page-" + page, name: "page-" + page }] : [] }
          : { prompts: [{ name: "prompt-" + page }] }),
        ...nextCursor(cursors?.[page - 1]),
      });
    });
    return;
  }
  if (message.method === "resources/read") {
    if (config.resourceReadJsonRpcError) {
      fail(message.id, -32000, "resource read failed");
      return;
    }
    reply(message.id, config.resourceReadResult ?? { contents: [{ uri: message.params?.uri, text: "resource ok" }] });
  }
}
function shutdown() {
  if (config.ignoreShutdown) {
    keepAlive ??= setInterval(() => {}, 60_000);
    return;
  }
  clearTimeout(pendingTimer);
  clearInterval(keepAlive);
  try {
    database?.exec("ROLLBACK");
  } catch {}
  database?.close();
  process.exit(0);
}
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (line.trim()) {
    handle(JSON.parse(line));
  }
});
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);`,
  );
}

// Runtime invalidation/recovery and App expiry expose no completion promise.
// A native tick also works while tests fake the product's RPC timers.
export async function waitForRuntimeState(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    for (;;) {
      signal.throwIfAborted();
      if (await withinTest(Promise.resolve().then(predicate), signal)) {
        return;
      }
      await waitForRuntimeTick(10, undefined, { signal });
    }
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`Timed out waiting for ${description}`, { cause: error });
    }
    throw error;
  }
}
