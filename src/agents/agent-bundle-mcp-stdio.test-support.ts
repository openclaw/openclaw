import { setTimeout as waitForRuntimeTick } from "node:timers/promises";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { fixtureReceiptClientSource } from "../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../test/helpers/promise.js";
import { writeExecutable } from "./bundle-mcp-shared.test-harness.js";

export async function writeListToolsMcpServer(
  params: {
    filePath: string;
    logPath: string;
    delayMs?: number;
    listToolsReleasePath?: string;
    initializeDelayMs?: number;
    hang?: boolean;
    ignoreShutdown?: boolean;
    hangFirstInitializeMarkerPath?: string;
    inputSchema?: unknown;
    tools?: Array<{
      name: string;
      description?: string;
      inputSchema?: unknown;
      outputSchema?: unknown;
      execution?: { taskSupport?: "forbidden" | "optional" | "required" };
      _meta?: Record<string, unknown>;
    }>;
    toolsByList?: Array<
      Array<{
        name: string;
        description?: string;
        inputSchema?: unknown;
        outputSchema?: unknown;
        execution?: { taskSupport?: "forbidden" | "optional" | "required" };
        _meta?: Record<string, unknown>;
      }>
    >;
    capabilities?: Record<string, unknown>;
    databasePath?: string;
    pidPath?: string;
    hangToolCallsUntilRestartMarkerPath?: string;
    notifyListChangedOnInitialized?: boolean;
    notifyListChangedAfterFirstList?: boolean;
    notifyListChangedReleasePath?: string;
    notifyListChangedBeforeEveryListResponse?: boolean;
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

${fixtureReceiptClientSource(receiptEndpoint)}

const {
  logPath, listToolsReleasePath, databasePath, pidPath, hangToolCallsUntilRestartMarkerPath,
  toolsByList, listToolsJsonRpcErrorMessage, toolPageCursors, callToolResult,
  callToolReleasePath, notifyListChangedReleasePath, resourcePageCursors,
  resourceReadResult, promptPageCursors, utilityListReleasePath, ignoreShutdown,
  hangFirstInitializeMarkerPath,
  delayMs = 0, initializeDelayMs = 0, hang = false, capabilities = { tools: {} },
  inputSchema = { type: "object", properties: {} },
  tools = [{ name: "slow_tool", description: "Returned after a slow catalog response.", inputSchema }],
  notifyListChangedOnInitialized = false, notifyListChangedAfterFirstList = false,
  notifyListChangedBeforeEveryListResponse = false, exitOnListCall = 0,
  listToolsMethodNotFound = false, callToolJsonRpcError = false,
  callToolJsonRpcErrorCode = -32000, notifyListChangedOnToolCall = false,
  resourceReadJsonRpcError = false,
} = ${JSON.stringify(params)};

async function waitForPath(filePath) {
  while (filePath) {
    const exists = await fs.access(filePath).then(() => true).catch(() => false);
    if (exists) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let buffer = "";
let listCount = 0;
let resourceListCount = 0;
let promptListCount = 0;
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
if (hangToolCallsUntilRestartMarkerPath) {
  hangToolCallsUntilRestart = !(await fs
    .access(hangToolCallsUntilRestartMarkerPath)
    .then(() => true)
    .catch(() => false));
  if (hangToolCallsUntilRestart) {
    await fs.writeFile(hangToolCallsUntilRestartMarkerPath, String(process.pid), "utf8");
  }
}
function log(line) {
  appendFileSync(logPath, line + "\\n", "utf8");
  sendReceipt(logPath, line);
}
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
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
    const response = {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities,
        serverInfo: { name: "test-list-tools", version: "1.0.0" },
      },
    };
    if (initializeDelayMs > 0) {
      setTimeout(() => send(response), initializeDelayMs);
    } else {
      send(response);
    }
    return;
  }
  if (message.method === "notifications/initialized") {
    if (notifyListChangedOnInitialized) {
      log("notify tools/list_changed");
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }
    return;
  }
  if (message.method === "tools/list") {
    listCount += 1;
    log("tools/list cursor " + JSON.stringify(message.params?.cursor));
    if (listCount === exitOnListCall) {
      log("exit tools/list " + listCount);
      process.exit(1);
    }
    if (listToolsMethodNotFound) {
      log("reject tools/list method not found");
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found" },
      });
      return;
    }
    if (listToolsJsonRpcErrorMessage) {
      log("reject tools/list with configured error");
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: listToolsJsonRpcErrorMessage },
      });
      return;
    }
    if (hang) {
      log("hang tools/list");
      keepAlive = setInterval(() => {}, 1000);
      return;
    }
    const currentListCount = listCount;
    const toolPageCursor = toolPageCursors?.[currentListCount - 1];
    log("delay tools/list " + delayMs);
    const sendListResponse = () => {
      if (notifyListChangedBeforeEveryListResponse) {
        log("notify tools/list_changed before response");
        send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      }
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: toolsByList
            ? toolsByList[Math.min(currentListCount - 1, toolsByList.length - 1)]
            : toolPageCursors
              ? tools.map((tool) => ({ ...tool, name: tool.name + "-" + currentListCount }))
              : tools,
          ...(toolPageCursor !== undefined && toolPageCursor !== null
            ? { nextCursor: toolPageCursor }
            : {}),
        },
      });
      if (notifyListChangedAfterFirstList && currentListCount === 1) {
        void (async () => {
          await waitForPath(notifyListChangedReleasePath);
          log("notify tools/list_changed");
          send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
        })();
      }
    };
    void (async () => {
      await waitForPath(listToolsReleasePath);
      pendingTimer = setTimeout(sendListResponse, delayMs);
    })();
  }
  if (message.method === "tools/call") {
    if (hangToolCallsUntilRestart) {
      log("hang tools/call");
      keepAlive = setInterval(() => {}, 1000);
      return;
    }
    if (callToolJsonRpcError) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: callToolJsonRpcErrorCode, message: "tool request failed" },
      });
      return;
    }
    if (notifyListChangedOnToolCall) {
      log("notify tools/list_changed during tools/call");
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }
    void (async () => {
      await waitForPath(callToolReleasePath);
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          isError: false,
          ...(callToolResult ?? {
            content: [{ type: "text", text: "tool ok" }],
          }),
        },
      });
    })();
  }
  if (message.method === "resources/list") {
    resourceListCount += 1;
    const page = resourceListCount;
    log("resources/list cursor " + JSON.stringify(message.params?.cursor));
    void (async () => {
      await waitForPath(utilityListReleasePath);
      const resourcePageCursor = resourcePageCursors?.[page - 1];
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          resources: resourcePageCursors
            ? [{ uri: "memo://page-" + page, name: "page-" + page }]
            : [],
          ...(resourcePageCursor !== undefined && resourcePageCursor !== null
            ? { nextCursor: resourcePageCursor }
            : {}),
        },
      });
    })();
    return;
  }
  if (message.method === "prompts/list") {
    promptListCount += 1;
    const page = promptListCount;
    log("prompts/list cursor " + JSON.stringify(message.params?.cursor));
    void (async () => {
      await waitForPath(utilityListReleasePath);
      const promptPageCursor = promptPageCursors?.[page - 1];
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          prompts: [{ name: "prompt-" + page }],
          ...(promptPageCursor !== undefined && promptPageCursor !== null
            ? { nextCursor: promptPageCursor }
            : {}),
        },
      });
    })();
    return;
  }
  if (message.method === "resources/read") {
    if (resourceReadJsonRpcError) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "resource read failed" },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: resourceReadResult ?? { contents: [{ uri: message.params?.uri, text: "resource ok" }] },
    });
  }
}
process.stdin.setEncoding("utf8");
function shutdown() {
  if (ignoreShutdown) {
    keepAlive ??= setInterval(() => {}, 60_000);
    return;
  }
  if (pendingTimer) {
    clearTimeout(pendingTimer);
  }
  if (keepAlive) {
    clearInterval(keepAlive);
  }
  try {
    database?.exec("ROLLBACK");
  } catch {}
  database?.close();
  process.exit(0);
}
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) {
      return;
    }
    const line = buffer.slice(0, newline).replace(/\\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line.trim()) {
      handle(JSON.parse(line));
    }
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
