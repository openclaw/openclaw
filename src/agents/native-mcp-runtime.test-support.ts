import fs from "node:fs/promises";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { fixtureReceiptClientSource } from "../../test/helpers/fixture-receipts.js";
import { createSessionMcpRuntime } from "./agent-bundle-mcp-runtime.js";
import type {
  NativeMcpClientContext,
  NativeMcpRequestOptions,
  NativeMcpResponse,
} from "./native-mcp-runtime.js";

export function createFixtureRuntime(directory: string, file: string, requester: string) {
  return createSessionMcpRuntime({
    sessionId: `projection-${requester}`,
    requesterScope: { requesterSenderId: requester },
    workspaceDir: directory,
    cfg: {
      plugins: { enabled: false },
      mcp: { servers: { fixture: { command: process.execPath, args: [file] } } },
    },
  });
}

export function context(
  root = "file:///workspace/a",
  capabilityContext = {},
): NativeMcpClientContext {
  return {
    capabilityContext,
    roots: { roots: [{ uri: root, name: "Workspace" }], _meta: { source: "caller" } },
    capabilities: { roots: { listChanged: true } },
    assertCurrent() {},
  };
}

export function options(signal: AbortSignal): NativeMcpRequestOptions {
  return { signal, assertCurrent() {} };
}

export function payload(response: NativeMcpResponse<CallToolResult>): unknown {
  if (response.kind !== "complete" || response.result.content[0]?.type !== "text") {
    throw new Error("Expected complete text fixture response");
  }
  return JSON.parse(response.result.content[0].text);
}

export function processId(value: unknown): number {
  if (
    typeof value !== "object" ||
    value === null ||
    !("pid" in value) ||
    typeof value.pid !== "number"
  ) {
    throw new Error("Expected real child process identity");
  }
  return value.pid;
}

/** Independent wire peer: legacy callbacks and modern SDK continuations share fixed data. */
export async function writeNativeMcpFixture(
  file: string,
  endpoint: string,
  era: "legacy" | "modern",
): Promise<void> {
  await fs.writeFile(
    file,
    `import { appendFileSync } from "node:fs";
${fixtureReceiptClientSource(endpoint)}
const source = ${JSON.stringify(file)};
function record(line) {
  appendFileSync(source + ".log", line + "\\n");
  sendReceipt(source, line);
}
announce(source + ":" + process.pid);
record("started " + process.pid);
const metadata = { fixture: "kept", nested: { value: 7 } };
const tool = { name: "probe", title: "Probe title", description: "Typed probe", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true }, _meta: metadata };
function page(method, params = {}, roots = { roots: [] }, capabilities = {}) {
  const second = params.cursor === "page:2";
  const envelope = { _meta: metadata, ...(second ? {} : { nextCursor: "page:2" }) };
  if (method === "tools/list") return { ...envelope, tools: second ? [] : [{ ...tool, description: JSON.stringify({ roots, capabilities }) }] };
  if (method === "resources/list") return { ...envelope, resources: second ? [] : [{ uri: "fixture://note", name: "Note", mimeType: "text/plain", _meta: metadata }] };
  if (method === "resources/templates/list") return { ...envelope, resourceTemplates: second ? [] : [{ uriTemplate: "fixture://{name}", name: "Template", _meta: metadata }] };
  if (method === "prompts/list") return { ...envelope, prompts: second ? [] : [{ name: "greeting", description: "Greeting prompt", arguments: [{ name: "name", required: true }], _meta: metadata }] };
}
function result(value) { return { content: [{ type: "text", text: JSON.stringify(value) }], _meta: metadata }; }
const era = ${JSON.stringify(era)};
if (era === "modern") {
  const { Server } = await import(${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server"))});
  const { serveStdio } = await import(${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server/stdio"))});
  serveStdio(() => {
    const server = new Server({ name: "typed-fixture", version: "1.0.0" }, { capabilities: { tools: { listChanged: true }, resources: {}, prompts: {}, completions: {} }, instructions: "Keep the full envelope." });
    for (const method of ["tools/list", "resources/list", "resources/templates/list", "prompts/list"]) {
      server.setRequestHandler(method, (request) => page(method, request.params));
    }
    server.setRequestHandler("tools/call", (request, ctx) => {
      record("call " + request.params.name);
      if (!ctx.mcpReq.inputResponses) return { resultType: "input_required", requestState: "fixture-state", inputRequests: { roots: { method: "roots/list" } }, _meta: metadata };
      record("resumed " + ctx.mcpReq.requestState());
      return result({ pid: process.pid, responses: ctx.mcpReq.inputResponses });
    });
    return server;
  }, { legacy: "reject" });
} else {
  let buffer = "";
  let capabilities = {};
  let roots = { roots: [] };
  let urlElicitationId;
  let id = 1000;
  const pending = new Map();
  function send(message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n"); }
  function request(method, params) {
    const key = ++id;
    send({ id: key, method, params });
    return new Promise((resolve, reject) => pending.set(key, { resolve, reject }));
  }
  async function reportRoots(reason) {
    await awaitRelease(source, "request-roots-" + reason);
    try { record("roots " + reason + " " + JSON.stringify({ result: await request("roots/list", {}) })); }
    catch (error) { record("roots " + reason + " " + JSON.stringify({ error: error.message })); }
    record("roots settled " + reason);
  }
  async function receive(message) {
    if (!message.method) {
      const reply = pending.get(message.id);
      if (!reply) return;
      pending.delete(message.id);
      if (message.error) { record("callback refused"); reply.reject(new Error(message.error.message)); }
      else { record("callback delivered"); reply.resolve(message.result); }
      return;
    }
    const params = message.params ?? {};
    record("recv " + message.method);
    if (message.method === "notifications/cancelled") { record("cancelled"); return; }
    if (message.method === "notifications/initialized" && capabilities.roots) void reportRoots("idle");
    if (message.method === "notifications/roots/list_changed") void reportRoots("changed");
    if (message.method.startsWith("notifications/")) return;
    try {
      let value;
      if (message.method === "initialize") {
        capabilities = params.capabilities;
        if (capabilities.extensions?.["io.openclaw.test/refuse-startup"]) {
          record("initialize refused capabilities");
          send({ id: message.id, error: { code: -32000, message: "Fixture refused client capability context" } });
          return;
        }
        value = { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true }, completions: {}, logging: {} }, serverInfo: { name: "typed-fixture", version: "1.0.0" }, instructions: "Keep the full envelope." };
      } else if (message.method.endsWith("/list")) {
        if (message.method === "tools/list" && !params.cursor && capabilities.roots) roots = await request("roots/list", {});
        if (message.method === "tools/list" && !params.cursor && capabilities.extensions?.["io.openclaw.test/sample-during-list"]) {
          const sample = await request("sampling/createMessage", { messages: [{ role: "user", content: { type: "text", text: "Catalog request" } }], maxTokens: 1 });
          record("listed sample " + sample.content.text);
        }
        value = page(message.method, params, roots, capabilities);
      } else if (message.method === "completion/complete") {
        value = { completion: { values: ["Ada", "Alan"], total: 3, hasMore: true }, _meta: metadata };
      } else if (message.method === "resources/read") {
        value = { contents: [{ uri: params.uri, mimeType: "text/plain", text: "full resource", _meta: metadata }], _meta: metadata };
      } else if (message.method === "prompts/get") {
        value = { description: "Complete greeting", messages: [{ role: "user", content: { type: "text", text: "Hello Ada", _meta: metadata } }], _meta: metadata };
      } else if (message.method === "tools/call") {
        if (params.name === "crash") { record("crashing"); process.exit(23); }
        if (params.name === "roots") roots = await request("roots/list", {});
        if (params.name === "elicit") value = result(await request("elicitation/create", { mode: "form", message: "Choose", requestedSchema: { type: "object", properties: { choice: { type: "string" } } } }));
        if (params.name === "url") {
          urlElicitationId = "fixture-url";
          value = result(await request("elicitation/create", { mode: "url", url: "https://example.invalid/authorize", elicitationId: urlElicitationId, message: "Authorize the fixture" }));
        }
        if (params.name === "completeUrl") send({ method: "notifications/elicitation/complete", params: { elicitationId: urlElicitationId } });
        if (params.name === "sample") value = result(await request("sampling/createMessage", { messages: [{ role: "user", content: { type: "text", text: "Reply once" } }], maxTokens: 1 }));
        if (params.name === "elicitCustom") value = result(await request("openai/elicitation/create", { message: "Rich form", fields: [{ id: "choice", options: ["a", "b"] }], _meta: { fixture: "custom" } }));
        if (params.name === "notify") {
          send({ method: "notifications/message", params: { level: "info", data: "request-local" } });
          send({ method: "notifications/tools/list_changed" });
        }
        if (params.name === "hold") {
          send({ method: "notifications/progress", params: { progressToken: params._meta.progressToken, progress: 1, total: 2, message: "waiting" } });
          record("holding");
          const releaseToken = params.arguments?.releaseToken ?? "finish";
          await awaitRelease(source, releaseToken);
          record("finished " + releaseToken);
        }
        value ??= result({ pid: process.pid, roots, capabilities, arguments: params.arguments });
      } else {
        send({ id: message.id, error: { code: -32601, message: "Method not found" } });
        return;
      }
      send({ id: message.id, result: value });
    } catch (error) {
      send({ id: message.id, error: { code: -32603, message: error.message } });
    }
  }
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (line) void receive(JSON.parse(line));
    }
  });
}
`,
  );
}
