/** Tests connected node-hosted plugin tool materialization. */

import { CallToolResultSchema } from "@modelcontextprotocol/core";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithAgentToolExecutionContext } from "../../packages/agent-core/src/tool-execution-context.js";
import type { NodePluginToolDescriptor } from "../../packages/gateway-protocol/src/index.js";
import {
  listConnectedNodePluginTools,
  removeConnectedNodePluginTools,
  replaceConnectedNodePluginTools,
} from "../gateway/node-plugin-tool-snapshot.js";
import { appendRuntimePluginToolGrant } from "../plugins/tool-grant-allowlist.js";
import { getPluginToolMeta, setPluginToolMeta } from "../plugins/tool-metadata.js";
import {
  applyCodeModeCatalog,
  buildCodeModeCatalogPrompt,
  createCodeModeTools,
} from "./code-mode.js";
import { testing } from "./code-mode.test-support.js";
import { consumeMcpCodeModeGuestResult } from "./mcp-content.js";
import { createNodePluginTools } from "./node-plugin-tools.js";
import { makeAssistantMessageFixture } from "./test-helpers/assistant-message-fixtures.js";
import { isToolResultError } from "./tool-result-error.js";
import { compactToolSearchCatalogEntry } from "./tool-search-catalog.js";
import { snapshotToolSearchTargetTranscriptResult } from "./tool-search-transcript.js";
import { createToolSearchCatalogRef } from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";
import { callGatewayTool } from "./tools/gateway.js";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const remoteEcho: NodePluginToolDescriptor = {
  pluginId: "remote-demo",
  name: "remote_echo",
  description: "Echo through a remote node",
  command: "remote.echo",
};

function connectTool(
  descriptor: NodePluginToolDescriptor = remoteEcho,
  {
    registered = false,
    ...node
  }: Partial<Omit<Parameters<typeof replaceConnectedNodePluginTools>[0], "tools">> & {
    registered?: boolean;
  } = {},
) {
  replaceConnectedNodePluginTools({
    nodeId: "node-1",
    ...node,
    tools: [{ descriptor, registered }],
  });
}

function docsTool(
  tool: string,
  description: string,
  parameters?: NodePluginToolDescriptor["parameters"],
) {
  return {
    pluginId: "node-mcp",
    name: `docs_${tool}`,
    description,
    parameters,
    command: "mcp.tools.call.v1",
    mcp: { server: "docs", tool },
  };
}

function firstTool(params: Parameters<typeof createNodePluginTools>[0] = {}) {
  return expectDefined(createNodePluginTools(params)[0], "node tool");
}

function toolNames(params: Parameters<typeof createNodePluginTools>[0] = {}) {
  return createNodePluginTools(params).map((tool) => tool.name);
}

function respond(payload: unknown) {
  vi.mocked(callGatewayTool).mockResolvedValueOnce({ payload });
}

const textBlock = (text: string) => ({ type: "text", text });

function richMcpContent() {
  return [
    {
      type: "text",
      text: "found",
      annotations: { audience: ["assistant"] },
      _meta: { source: "text-block" },
    },
    { type: "image", data: "aW1hZ2U=", mimeType: "image/png", _meta: { source: "image-block" } },
    { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
    { type: "resource_link", uri: "memo://one", name: "memo" },
    { type: "resource", resource: { uri: "memo://two", text: "memo body" } },
  ];
}

function malformedMcpContent() {
  return [
    {
      type: "image",
      data: 42,
      mimeType: "image/png",
      annotations: { audience: ["assistant"], canary: "malformed-annotations" },
      _meta: { canary: "malformed-meta" },
    },
    {
      type: "text",
      text: "node-b",
      annotations: { canary: "text-annotations" },
      _meta: { canary: "text-meta" },
    },
  ];
}

function expectInvocation(
  params: unknown,
  { mcp = false, signal }: { mcp?: boolean; signal?: unknown } = {},
) {
  expect(callGatewayTool).toHaveBeenCalledWith(
    "node.invoke",
    { timeoutMs: mcp ? 125_000 : 35_000 },
    params,
    { scopes: ["operator.write"], ...(signal ? { signal } : {}) },
  );
}

function createCodeModeHarness(tools: AnyAgentTool[]) {
  const catalogRef = createToolSearchCatalogRef();
  const config = { tools: { codeMode: { enabled: true, timeoutMs: 120_000 } } } as never;
  const ctx = {
    config,
    runtimeConfig: config,
    sessionId: "session-node-mcp-code-mode",
    sessionKey: "agent:main:node-mcp-code-mode",
    runId: "run-node-mcp-code-mode",
    catalogRef,
  };
  const codeModeTools = createCodeModeTools(ctx);
  applyCodeModeCatalog({
    tools: [...codeModeTools, ...tools],
    config,
    catalogRef,
  });
  return { catalogRef, codeModeTools, ctx };
}

async function runCodeMode(codeModeTools: AnyAgentTool[], code: string) {
  const execute = async (index: number, id: string, params: Record<string, unknown>) =>
    (await expectDefined(codeModeTools[index], "code mode tool").execute(id, params))
      .details as Record<string, unknown>;
  let details = await execute(0, "code-node-mcp", { code });
  for (let index = 0; index < 8 && details.status === "waiting"; index += 1) {
    details = await execute(1, `wait-node-mcp-${index}`, { runId: details.runId });
  }
  expect(details.status, JSON.stringify(details)).toBe("completed");
  return details;
}

function gatewayMcpTool(serverName: string): AnyAgentTool {
  const tool: AnyAgentTool = {
    name: `${serverName}__status`,
    label: "status",
    description: `Read ${serverName} status`,
    parameters: { type: "object", properties: {} },
    execute: vi.fn(async () => jsonResult({ source: "gateway" })),
  };
  setPluginToolMeta(tool, {
    pluginId: "bundle-mcp",
    optional: false,
    mcp: {
      serverName,
      safeServerName: serverName,
      toolName: "status",
      operation: "tool",
    },
  });
  return tool;
}

afterEach(() => {
  for (const nodeId of new Set(listConnectedNodePluginTools().map((tool) => tool.nodeId))) {
    removeConnectedNodePluginTools(nodeId);
  }
  vi.mocked(callGatewayTool).mockReset();
  testing.activeRuns.clear();
  testing.resumingRunIds.clear();
});

describe("createNodePluginTools", () => {
  it("scopes reused call IDs by turnId and preserves replay keys", async () => {
    connectTool();
    vi.mocked(callGatewayTool).mockResolvedValue({ payload: { ok: true } });
    const tool = firstTool();
    const calls = ["first", "second"].map((text, index) => {
      const toolCall = {
        type: "toolCall" as const,
        id: "exec_0",
        name: tool.name,
        arguments: { text },
      };
      return {
        toolCall,
        assistantMessage: makeAssistantMessageFixture({
          turnId: `turn-${index + 1}`,
          stopReason: "toolUse",
          content: [toolCall],
        }),
      };
    });
    const first = expectDefined(calls[0], "first assistant turn");
    for (const context of [...calls, first]) {
      await runWithAgentToolExecutionContext(context, () =>
        tool.execute(context.toolCall.id, context.toolCall.arguments),
      );
    }

    expect(vi.mocked(callGatewayTool).mock.calls.map((call) => call[2])).toMatchObject([
      { idempotencyKey: "turn-1:exec_0", params: { text: "first" } },
      { idempotencyKey: "turn-2:exec_0", params: { text: "second" } },
      { idempotencyKey: "turn-1:exec_0", params: { text: "first" } },
    ]);
  });

  it("materializes connected node plugin tools and invokes their node command", async () => {
    connectTool(
      {
        ...remoteEcho,
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
        },
        mcp: {
          server: "remote-demo",
          tool: "echo",
        },
      },
      { nodeId: "node-1", displayName: "Studio Node" },
    );
    respond({ content: [textBlock("pong")], details: { ok: true } });

    const tools = createNodePluginTools({
      existingToolNames: new Set(["read"]),
      agentSessionKey: "agent:main:canvas",
    });
    const tool = expectDefined(tools[0], "remote echo tool");
    const result = await tool.execute("call-1", { text: "ping" });

    expect(tools.map((entry) => entry.name)).toEqual(["remote_echo"]);
    expect(tool.resultContentSource).toBeUndefined();
    expect(tool.description).toContain("Studio Node");
    expect(getPluginToolMeta(tool)).toMatchObject({
      pluginId: "remote-demo",
      mcp: {
        serverName: "remote-demo",
        toolName: "echo",
        operation: "tool",
      },
    });
    expectInvocation({
      nodeId: "node-1",
      command: "remote.echo",
      params: { text: "ping" },
      timeoutMs: 30_000,
      idempotencyKey: "call-1",
      sessionKey: "agent:main:canvas",
    });
    expect(result.content).toEqual([textBlock("pong")]);
    respond({
      content: [textBlock("pong from Code Mode")],
      details: { ok: true, privateState: "must-not-leak" },
    });
    respond({
      content: [textBlock("remote command failed")],
      details: { status: "error", privateState: "must-not-leak" },
    });
    const { codeModeTools } = createCodeModeHarness(tools);
    const guest = await runCodeMode(
      codeModeTools,
      'return { success: await MCP.remoteDemo.echo({ text: "ping" }), failure: await MCP.remoteDemo.echo({ text: "fail" }) };',
    );
    expect(guest.value).toEqual({
      success: { content: [textBlock("pong from Code Mode")], isError: false },
      failure: { content: [textBlock("remote command failed")], isError: true },
    });
    expect(JSON.stringify(guest.value)).not.toContain("privateState");
  });

  it("propagates caller cancellation through node gateway invocations", async () => {
    connectTool();
    vi.mocked(callGatewayTool).mockImplementationOnce(async (_method, _opts, _params, extra) => {
      extra?.signal?.throwIfAborted();
      return { payload: { ok: true } };
    });
    const controller = new AbortController();
    const abortError = new DOMException("node call cancelled", "AbortError");
    controller.abort(abortError);
    const tool = firstTool();

    await expect(tool.execute("call-aborted", { text: "ping" }, controller.signal)).rejects.toBe(
      abortError,
    );
    expectInvocation(
      {
        nodeId: "node-1",
        command: "remote.echo",
        params: { text: "ping" },
        idempotencyKey: "call-aborted",
        timeoutMs: 30_000,
      },
      { signal: controller.signal },
    );
  });

  it("snapshots successful node MCP text once", async () => {
    const text = "ordinary report line\n".repeat(25_000);
    const payload = CallToolResultSchema.parse({
      content: [
        { type: "text", text },
        { type: "resource_link", uri: "memo://report", name: "Report" },
        { type: "text", text: "résumé\n東京", _meta: { source: "report" } },
        {
          type: "image",
          data: "aW1hZ2U=",
          mimeType: "image/png",
          annotations: { audience: ["assistant"] },
          _meta: { detailCanary: "must-not-leak" },
        },
      ],
      isError: false,
    });
    connectTool(docsTool("read", "Read node-local reports"));
    respond(payload);
    const tool = firstTool();
    const result = snapshotToolSearchTargetTranscriptResult(await tool.execute("report", {}));

    expect(result.content).toEqual([
      { type: "text", text },
      { type: "text", text: "[Report] memo://report" },
      { type: "text", text: "résumé\n東京" },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    ]);
    expect(isToolResultError(result)).toBe(false);
    expect(consumeMcpCodeModeGuestResult(result)).toEqual(payload);
    const contentBytes = Buffer.byteLength(JSON.stringify(result.content));
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(contentBytes + 1_024);
  });

  it("projects node MCP schemas and calls through the exact namespace catalog entry", async () => {
    connectTool(
      docsTool("search", "Search node-local docs", {
        type: "object",
        properties: {
          query: { type: "string", description: "Search phrase" },
        },
        required: ["query"],
      }),
      { nodeId: "node-1", displayName: "Studio Node" },
    );
    respond({
      content: richMcpContent(),
      structuredContent: { hits: 1 },
      isError: false,
      _meta: { privateAppState: "must-not-leak" },
    });

    const nodeTools = createNodePluginTools({ agentSessionKey: "agent:main:node-mcp-code-mode" });
    const nodeTool = expectDefined(nodeTools[0], "node MCP tool");
    expect(nodeTool.executionMode).toBe("sequential");
    expect(nodeTool.resultContentSource).toBe("network");
    expect(getPluginToolMeta(nodeTool)?.mcp?.node).toEqual({
      id: "node-1",
      displayName: "Studio Node",
    });
    const { catalogRef, codeModeTools, ctx } = createCodeModeHarness(nodeTools);
    const nodeEntry = catalogRef.current?.entries.find(
      (entry) => entry.name === "docs_search" && entry.source === "mcp",
    );

    expect(nodeEntry?.id).toBe("mcp:docs:docs_search");
    expect(nodeEntry && compactToolSearchCatalogEntry(nodeEntry).mcp).toEqual({
      serverName: "docs",
      safeServerName: "docs",
      toolName: "search",
      operation: "tool",
    });
    expect(buildCodeModeCatalogPrompt(ctx, catalogRef.current?.entries ?? [])).toContain(
      "docs (node: Studio Node)",
    );
    const details = await runCodeMode(
      codeModeTools,
      `
        const api = await API.read("mcp/docs.d.ts");
        const discovered = await catalog.search("docs_search");
        const called = await discovered[0]({ query: "needle" });
        return {
          api: api.content,
          called,
          allHasNodeMcp: catalog.all().some((entry) => entry.source === "mcp"),
          discovered,
        };
      `,
    );

    expect(details.value).toEqual({
      api: expect.stringContaining("query: string;"),
      called: {
        content: richMcpContent(),
        structuredContent: { hits: 1 },
        isError: false,
      },
      allHasNodeMcp: false,
      discovered: [
        {
          callableName: "MCP.docs.search",
          toolName: "search",
          description: "Search node-local docs (node: Studio Node)",
          source: "mcp",
          apiPath: "mcp/docs.d.ts",
        },
      ],
    });
    expect((details.value as { api: string }).api).toContain("@param query Search phrase");
    expectInvocation(
      {
        nodeId: "node-1",
        command: "mcp.tools.call.v1",
        params: { server: "docs", tool: "search", arguments: { query: "needle" } },
        timeoutMs: 120_000,
        idempotencyKey: expect.stringContaining("docs_search"),
        sessionKey: "agent:main:node-mcp-code-mode",
      },
      { mcp: true, signal: expect.any(AbortSignal) },
    );
  });

  it("makes empty MCP application results visible", async () => {
    connectTool(docsTool("fail", "Fail without content", { type: "object", properties: {} }));
    respond({ content: [], isError: true });
    respond({ content: [], isError: true });

    const nodeTools = createNodePluginTools({});
    const tool = expectDefined(nodeTools[0], "node MCP tool");
    const result = await tool.execute("empty-error", {});

    expect(result.content).toEqual([
      { type: "text", text: "MCP tool failed without returning content." },
    ]);
    expect(result.details).toEqual({ mcpServer: "docs", mcpTool: "fail", status: "error" });
    expect(isToolResultError(result)).toBe(true);

    const { codeModeTools } = createCodeModeHarness(nodeTools);
    const guestResult = await runCodeMode(codeModeTools, "return await MCP.docs.fail({})");

    expect(guestResult.value).toEqual({ content: [], isError: true });
  });

  it("disambiguates gateway-node and node-node MCP server collisions", async () => {
    for (const [nodeId, displayName, serverName, toolName] of [
      ["node-a", "Node A", "tickets", "search_a"],
      ["node-b", "Node B", "docs", "search_b"],
      ["node-c", "Node C", "docs", "search_c"],
    ] as const) {
      connectTool(
        {
          ...docsTool(toolName, `Search docs from ${displayName}`, {
            type: "object",
            properties: {},
          }),
          name: `docs_${toolName}`,
          mcp: { server: serverName, tool: toolName },
        },
        { nodeId, displayName },
      );
    }
    respond({ content: malformedMcpContent() });

    const { catalogRef, codeModeTools, ctx } = createCodeModeHarness([
      gatewayMcpTool("tickets"),
      ...createNodePluginTools({}),
    ]);
    expect(buildCodeModeCatalogPrompt(ctx, catalogRef.current?.entries ?? [])).toContain(
      "visible servers: nodeATickets (node: Node A), nodeBDocs (node: Node B), nodeCDocs (node: Node C), tickets",
    );

    const details = await runCodeMode(
      codeModeTools,
      `
        const files = await API.list("mcp");
        const called = await MCP.nodeCDocs.searchC({});
        return { files: files.files.map((file) => file.path), called };
      `,
    );

    expect(details.value).toEqual({
      files: [
        "mcp/index.d.ts",
        "mcp/nodeATickets.d.ts",
        "mcp/nodeBDocs.d.ts",
        "mcp/nodeCDocs.d.ts",
        "mcp/tickets.d.ts",
      ],
      called: {
        content: malformedMcpContent(),
      },
    });
    expectInvocation(
      expect.objectContaining({
        nodeId: "node-c",
        params: { server: "docs", tool: "search_c", arguments: {} },
      }),
      { mcp: true, signal: expect.any(AbortSignal) },
    );
  });

  it("honors policy for disambiguated names with NODE_B_*", () => {
    for (const nodeId of ["node-a", "node-b"]) {
      connectTool(remoteEcho, { nodeId });
    }

    expect(toolNames({ toolAllowlist: ["NODE_B_*"] })).toEqual(["node_b_remote_echo"]);
    expect(toolNames({ toolDenylist: ["node_b_remote_echo"] })).toEqual(["node_a_remote_echo"]);
  });

  it("keeps numeric node fragments provider-safe", () => {
    connectTool(remoteEcho, { nodeId: "123" });

    expect(toolNames({ existingToolNames: new Set(["remote_echo"]) })).toEqual([
      "node_123_remote_echo",
    ]);
  });

  it("keeps numeric disambiguation when node fragments collide", () => {
    for (const nodeId of ["node-a", "node_a"]) {
      connectTool(remoteEcho, { nodeId });
    }

    expect(toolNames()).toEqual(["node_a_remote_echo", "node_a_remote_echo_2"]);
  });

  it("does not use local runtime grants for registered node tools", () => {
    connectTool(
      {
        pluginId: "github",
        name: "remote_repo_search",
        description: "Search repos",
        command: "remote.search",
      },
      { nodeId: "node-1", registered: true },
    );
    const toolAllowlist = appendRuntimePluginToolGrant([], {
      pluginId: "github",
      toolNames: ["remote_repo_search"],
    });

    expect(createNodePluginTools({ toolAllowlist })).toEqual([]);
    expect(createNodePluginTools({ toolAllowlist: ["git*"] })).toEqual([]);
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("trusts plugin-id allowlist entries only for registered tools and node-mcp", () => {
    const githubDescriptor: NodePluginToolDescriptor = {
      pluginId: "github",
      name: "remote_repo_search",
      description: "Search repositories through a remote node",
      command: "remote.search",
    };

    connectTool(githubDescriptor);
    expect(createNodePluginTools({ toolAllowlist: ["github"] })).toEqual([]);

    connectTool(githubDescriptor, { nodeId: "node-1", registered: true });
    expect(toolNames({ toolAllowlist: ["github"] })).toEqual(["remote_repo_search"]);

    connectTool({ ...githubDescriptor, pluginId: "node-mcp" });
    expect(toolNames({ toolAllowlist: ["node-mcp"] })).toEqual(["remote_repo_search"]);

    connectTool(githubDescriptor);
    expect(toolNames({ toolAllowlist: ["remote_repo_search"] })).toEqual(["remote_repo_search"]);
    expect(
      createNodePluginTools({
        toolAllowlist: ["remote_repo_search"],
        toolDenylist: ["github"],
      }),
    ).toEqual([]);
  });
});
