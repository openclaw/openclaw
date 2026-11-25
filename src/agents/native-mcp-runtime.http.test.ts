import assert from "node:assert/strict";
import http from "node:http";
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, inputRequired, McpServer } from "@modelcontextprotocol/server";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { createSessionMcpRuntime } from "./agent-bundle-mcp-runtime.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { acquireNativeMcpServer, type NativeMcpServerView } from "./native-mcp-runtime.js";
import { context, options } from "./native-mcp-runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const requests: Array<Record<"method" | "name" | "tenant" | "enabled", string | null>> = [];
let mirrorCalls = 0;
let inputCalls = 0;
let sessionId = 0;
let runtime: SessionMcpRuntime | undefined;
let view: NativeMcpServerView | undefined;
let listener: Awaited<ReturnType<typeof reserveTestPortListener<http.Server>>>;
const textResult = (text: string) => ({ content: [{ type: "text" as const, text }] });
const inputSchema = z.object({
  tenant: z.string().meta({ "x-mcp-header": "Tenant" }),
  options: z.object({ enabled: z.boolean().meta({ "x-mcp-header": "Enabled" }) }),
});

const handler = createMcpHandler(
  ({ requestInfo }) => {
    const headers = requestInfo!.headers;
    const fields = {
      method: headers.get("mcp-method"),
      name: headers.get("mcp-name"),
      tenant: headers.get("mcp-param-tenant"),
      enabled: headers.get("mcp-param-enabled"),
    };
    requests.push(fields);
    const server = new McpServer({ name: "native-http-fixture", version: "1.0.0" });
    server.registerTool("mirror", { inputSchema }, async () => {
      mirrorCalls += 1;
      return textResult(JSON.stringify({ tenant: fields.tenant, enabled: fields.enabled }));
    });
    server.registerTool("needs-input", {}, async () => {
      inputCalls += 1;
      return inputRequired({
        requestState: "http-fixture-state",
        inputRequests: { roots: inputRequired.listRoots() },
      });
    });
    return server;
  },
  { legacy: "reject" },
);

beforeAll(async () => {
  const handle = toNodeHandler(handler);
  listener = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      http.createServer((request, response) => {
        void handle(request, response).catch((error: unknown) => {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
        });
      }),
  });
});
beforeEach(async () => {
  requests.length = 0;
  mirrorCalls = 0;
  inputCalls = 0;
  const server = {
    transport: "streamable-http" as const,
    url: "http://127.0.0.1:" + listener.claim.port + "/mcp",
  };
  runtime = createSessionMcpRuntime({
    sessionId: "native-http-" + ++sessionId,
    requesterScope: { requesterSenderId: "synthetic-http-requester" },
    workspaceDir: tempDirs.make("native-mcp-http-"),
    cfg: { plugins: { enabled: false }, mcp: { servers: { fixture: server } } },
  });
  const caller = { ...context(), capabilities: { roots: {} }, roots: { roots: [] } };
  view = await acquireNativeMcpServer(runtime, "fixture", caller);
});
afterEach(async () => {
  try {
    await view?.release();
  } finally {
    if (runtime) {
      await runtime.dispose();
      assert(runtime.joinCleanup, "MCP runtime must expose cleanup ownership");
      await runtime.joinCleanup();
    }
    runtime = undefined;
    view = undefined;
  }
});
afterAll(async () => {
  await handler.close();
  listener.listener.closeAllConnections();
  await listener.releaseListener();
  await listener.claim.release();
});

async function expectMirror(tenant: string, enabled: boolean, signal: AbortSignal) {
  expect(
    await view!.callTool(
      { name: "mirror", arguments: { tenant, options: { enabled } } },
      options(signal),
    ),
  ).toMatchObject({
    kind: "complete",
    result: textResult(JSON.stringify({ tenant, enabled: String(enabled) })),
  });
}

const requestsFor = (method: string) => requests.filter((request) => request.method === method);

it("mirrors schema headers with cold-cache recovery and changing warm arguments", async ({
  signal,
}) => {
  expect(view!.getProtocolEra()).toBe("modern");
  requests.length = 0;
  const expected: typeof requests = [
    { method: "tools/call", name: "mirror", tenant: null, enabled: null },
  ];
  for (const [tenant, enabled] of [
    ["tenant-a", true],
    ["tenant-b", false],
  ] as const) {
    await expectMirror(tenant, enabled, signal);
    expected.push({ method: "tools/call", name: "mirror", tenant, enabled: String(enabled) });
    expect(requestsFor("tools/call")).toEqual(expected);
    expect(requestsFor("tools/list")).toHaveLength(1);
    expect(mirrorCalls).toBe(expected.length - 1);
  }
  expect(requests.at(-1)).toEqual(expected.at(-1));
  expect(runtime!.activeLeases).toBe(0);
});

it("rejects HTTP input-required results without a continuation or retry", async ({ signal }) => {
  const call = view!.callTool({ name: "needs-input" }, options(signal));
  await expect(call).rejects.toBeInstanceOf(SdkError);
  await expect(call).rejects.toMatchObject({
    code: SdkErrorCode.UnsupportedResultType,
    data: { resultType: "input_required", method: "tools/call" },
  });
  expect(inputCalls).toBe(1);
  expect(requestsFor("tools/call")).toHaveLength(1);
  expect(runtime!.activeLeases).toBe(0);
});
