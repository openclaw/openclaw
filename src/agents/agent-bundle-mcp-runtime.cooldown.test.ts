import { Type } from "typebox";
import { expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { handleMcpJsonRpc } from "../gateway/mcp-http.handlers.js";
import {
  readMcpFixtureMessage,
  replyMcpFixtureResult,
  startMcpHttpFixture,
  startMcpLifecycleServer,
} from "./agent-bundle-mcp-lifecycle.test-support.js";
import { createSessionMcpRuntime } from "./agent-bundle-mcp-runtime.js";
import { jsonResult } from "./tools/common.js";

it("starts the failure cooldown when the failed MCP request settles", async () => {
  let elapsed = 0;
  let calls = 0;
  const server = await startMcpHttpFixture(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const message = await readMcpFixtureMessage(request);
    if (message.method === "initialize") {
      replyMcpFixtureResult(response, message, {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "cooldown-proof", version: "1" },
      });
    } else if (message.method === "tools/list") {
      replyMcpFixtureResult(response, message, {
        tools: [{ name: "probe", inputSchema: { type: "object" } }],
      });
    } else if (message.method === "tools/call") {
      calls += 1;
      if (calls <= 3) {
        // The third request takes 45s, within its configured 120s request budget.
        if (calls === 3) {
          elapsed += 45_000;
        }
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32000, message: "slow failure" },
          }),
        );
      } else {
        replyMcpFixtureResult(response, message, { content: [{ type: "text", text: "healthy" }] });
      }
    } else {
      response.writeHead(202).end();
    }
  });
  const workspaceDir = useAutoCleanupTempDirTracker(onTestFinished).make("mcp-cooldown-");
  const runtime = createSessionMcpRuntime({
    sessionId: "cooldown-proof",
    workspaceDir,
    cfg: {
      mcp: {
        servers: {
          slow: { transport: "streamable-http", url: server.url, requestTimeoutMs: 120_000 },
        },
      },
    },
  });
  onTestFinished(async () => {
    try {
      await runtime.dispose();
    } finally {
      await server.close();
    }
  });
  expect((await runtime.getCatalog()).tools.map((tool) => tool.toolName)).toContain("probe");
  const realNow = performance.now.bind(performance);
  const clock = vi.spyOn(performance, "now").mockImplementation(() => realNow() + elapsed);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(runtime.callTool("slow", "probe", {})).rejects.toThrow("slow failure");
    }
    elapsed += 20_000;
    await expect(runtime.callTool("slow", "probe", {})).rejects.toThrow(
      "paused after repeated tool failures",
    );
    expect(calls).toBe(3);
    elapsed += 40_001;
    await expect(runtime.callTool("slow", "probe", {})).resolves.toMatchObject({
      content: [{ type: "text", text: "healthy" }],
    });
    expect(calls).toBe(4);
  } finally {
    clock.mockRestore();
  }
});

it("does not pause a healthy server after local bridge authority expires", async () => {
  let calls = 0;
  const server = await startMcpLifecycleServer({
    toolName: "probe",
    text: () => {
      calls += 1;
      return "healthy";
    },
  });
  const runtime = createSessionMcpRuntime({
    sessionId: "local-authority-proof",
    workspaceDir: useAutoCleanupTempDirTracker(onTestFinished).make("mcp-local-authority-"),
    cfg: { mcp: { servers: { healthy: { transport: "streamable-http", url: server.url } } } },
  });
  onTestFinished(async () => {
    try {
      await runtime.dispose();
    } finally {
      await server.close();
    }
  });
  await runtime.getCatalog();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let authorized = true;
    const response = await handleMcpJsonRpc({
      message: {
        jsonrpc: "2.0",
        id: attempt,
        method: "tools/call",
        params: { name: "bridge_probe", arguments: {} },
      },
      authorizeToolCall: () => authorized,
      toolSchema: [
        { name: "bridge_probe", description: undefined, inputSchema: { type: "object" } },
      ],
      tools: [
        {
          name: "bridge_probe",
          label: "Bridge probe",
          description: "Read the configured server",
          parameters: Type.Object({}),
          execute: async () => {
            authorized = false;
            return jsonResult(await runtime.callTool("healthy", "probe", {}));
          },
        },
      ],
    });
    expect(response).toMatchObject({
      result: { isError: true, content: [{ text: "Tool call authorization expired" }] },
    });
  }
  expect(calls).toBe(0);
  await expect(runtime.callTool("healthy", "probe", {})).resolves.toMatchObject({
    content: [{ text: "healthy" }],
  });
  expect(calls).toBe(1);
});
