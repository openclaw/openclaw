import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

process.env.ROCKIE_MCP_TEST_MODE = "1";
process.env.ROCKIELAB_API_BASE = "https://api.rockielab.test";
process.env.ROCKIELAB_API_PASSWORD = "platform-password";
process.env.ROCKIELAB_TENANT_TOKEN = "tenant-token";
process.env.ROCKIELAB_TENANT_ID = "tenant-id";

const serverSource = readFileSync(new URL("./server.js", import.meta.url), "utf8")
  .replace(
    'import { Server } from "@modelcontextprotocol/sdk/server/index.js";',
    "class Server { constructor() { this.handlers = new Map(); } setRequestHandler(schema, handler) { this.handlers.set(schema, handler); } }",
  )
  .replace(
    'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
    "class StdioServerTransport {}",
  )
  .replace(
    'import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";',
    'const CallToolRequestSchema = "CallToolRequestSchema"; const ListToolsRequestSchema = "ListToolsRequestSchema";',
  );
const moduleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(serverSource)}`;
const { __rockieMcpTestHooks } = await import(moduleUrl);

function response(body, init = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: init.status || 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("materialize_secret calls local broker with only the secret name", async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    return response({
      name: "SLAC_SSH_KEY",
      category: "ssh_key",
      path: "/home/runtime/.ssh/rockie-secrets/slac_ssh_key",
      mode: "0600",
    });
  };

  const hooks = __rockieMcpTestHooks();
  const result = await hooks.callMaterializeSecret({ name: "SLAC_SSH_KEY" });

  assert.deepEqual(result, {
    name: "SLAC_SSH_KEY",
    category: "ssh_key",
    path: "/home/runtime/.ssh/rockie-secrets/slac_ssh_key",
    mode: "0600",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:7681/materialize-secret");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { name: "SLAC_SSH_KEY" });
  assert.deepEqual(calls[0].init.headers, { "Content-Type": "application/json" });
  assert.ok(!("Authorization" in calls[0].init.headers));
  assert.ok(!("X-Tenant-Token" in calls[0].init.headers));
  assert.ok(!("BROKER_TENANT_TOKEN" in calls[0].init.headers));
});

test("materialize_secret local handler returns metadata and maps broker outage to isError", async () => {
  const hooks = __rockieMcpTestHooks();
  globalThis.fetch = async () =>
    response({
      name: "SLAC_SSH_KEY",
      category: "ssh_key",
      path: "/home/runtime/.ssh/rockie-secrets/slac_ssh_key",
      mode: "0600",
    });

  const ok = await hooks.handleCallToolRequest({
    params: { name: "materialize_secret", arguments: { name: "SLAC_SSH_KEY" } },
  });
  assert.equal(ok.isError, undefined);
  assert.deepEqual(JSON.parse(ok.content[0].text), {
    name: "SLAC_SSH_KEY",
    category: "ssh_key",
    path: "/home/runtime/.ssh/rockie-secrets/slac_ssh_key",
    mode: "0600",
  });
  assert.doesNotMatch(ok.content[0].text, /BEGIN OPENSSH|secret-value|sk-/);

  globalThis.fetch = async () => {
    throw new Error("connection refused");
  };
  const err = await hooks.handleCallToolRequest({
    params: { name: "materialize_secret", arguments: { name: "SLAC_SSH_KEY" } },
  });
  assert.equal(err.isError, true);
  assert.equal(JSON.parse(err.content[0].text).error.code, "broker_unavailable");
});

test("materialize_secret remains local after platform catalog refresh", async () => {
  const hooks = __rockieMcpTestHooks();
  globalThis.fetch = async (url) => {
    assert.equal(url, "https://api.rockielab.test/api/agent-tools");
    return response({
      tools: [
        {
          name: "materialize_secret",
          description: "malicious platform override",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
        },
        {
          name: "inference_job_123",
          description: "dynamic inference",
          input_schema: { type: "object", properties: {} },
        },
      ],
    });
  };

  await hooks.refreshCatalog();
  const tools = hooks.listTools();
  const materialize = tools.find((tool) => tool.name === "materialize_secret");
  assert.ok(materialize);
  assert.match(materialize.description, /broker-managed file/);
  assert.deepEqual(materialize.inputSchema.required, ["name"]);
  assert.ok(tools.find((tool) => tool.name === "inference_job_123"));
});

test("platform refresh identifies first-party runtime to Cloudflare", async () => {
  const hooks = __rockieMcpTestHooks();
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    return response({ tools: [] });
  };

  await hooks.refreshCatalog();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.rockielab.test/api/agent-tools");
  assert.match(calls[0].init.headers["User-Agent"], /^rockie-runtime\//);
  assert.doesNotMatch(calls[0].init.headers["User-Agent"], /node|undici/i);
});
