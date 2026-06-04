/** Tests connected node-hosted plugin tool materialization. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  replaceConnectedNodePluginTools,
  resetConnectedNodePluginToolsForTest,
} from "../gateway/node-plugin-tool-snapshot.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import { createNodePluginTools } from "./node-plugin-tools.js";
import { callGatewayTool } from "./tools/gateway.js";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

afterEach(() => {
  resetConnectedNodePluginToolsForTest();
  vi.mocked(callGatewayTool).mockReset();
});

describe("createNodePluginTools", () => {
  it("materializes connected node plugin tools and invokes their node command", async () => {
    replaceConnectedNodePluginTools({
      nodeId: "node-1",
      displayName: "Studio Node",
      tools: [
        {
          pluginId: "remote-demo",
          name: "remote_echo",
          description: "Echo through a remote node",
          parameters: {
            type: "object",
            properties: { text: { type: "string" } },
          },
          command: "remote.echo",
          mcp: {
            server: "remote-demo",
            tool: "echo",
          },
        },
      ],
    });
    vi.mocked(callGatewayTool).mockResolvedValueOnce({
      payload: {
        content: [{ type: "text", text: "pong" }],
        details: { ok: true },
      },
    });

    const tools = createNodePluginTools({ existingToolNames: new Set(["read"]) });
    const result = await tools[0].execute("call-1", { text: "ping" });

    expect(tools.map((tool) => tool.name)).toEqual(["remote_echo"]);
    expect(tools[0].description).toContain("Studio Node");
    expect(getPluginToolMeta(tools[0])).toMatchObject({
      pluginId: "remote-demo",
      mcp: {
        serverName: "remote-demo",
        toolName: "echo",
        operation: "tool",
      },
    });
    expect(callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      {},
      {
        nodeId: "node-1",
        command: "remote.echo",
        params: { text: "ping" },
        idempotencyKey: "call-1",
      },
      { scopes: ["operator.write"] },
    );
    expect(result.content).toEqual([{ type: "text", text: "pong" }]);
  });

  it("disambiguates node tools that collide with existing tool names", () => {
    replaceConnectedNodePluginTools({
      nodeId: "node-1",
      tools: [
        {
          pluginId: "remote-demo",
          name: "remote_echo",
          description: "Echo through a remote node",
          command: "remote.echo",
        },
      ],
    });

    expect(
      createNodePluginTools({ existingToolNames: new Set(["remote_echo"]) }).map(
        (tool) => tool.name,
      ),
    ).toEqual(["remote_echo_node_1"]);
  });

  it("disambiguates matching tool names from different nodes", async () => {
    replaceConnectedNodePluginTools({
      nodeId: "node-a",
      displayName: "Node A",
      tools: [
        {
          pluginId: "remote-demo",
          name: "remote_echo",
          description: "Echo through a remote node",
          command: "remote.echo",
        },
      ],
    });
    replaceConnectedNodePluginTools({
      nodeId: "node-b",
      displayName: "Node B",
      tools: [
        {
          pluginId: "remote-demo",
          name: "remote_echo",
          description: "Echo through a remote node",
          command: "remote.echo",
        },
      ],
    });
    vi.mocked(callGatewayTool).mockResolvedValueOnce({
      payload: { ok: true, node: "b" },
    });

    const tools = createNodePluginTools({});
    const result = await tools[1].execute("call-2", { text: "ping" });

    expect(tools.map((tool) => tool.name)).toEqual(["remote_echo_node_a", "remote_echo_node_b"]);
    expect(callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      {},
      {
        nodeId: "node-b",
        command: "remote.echo",
        params: { text: "ping" },
        idempotencyKey: "call-2",
      },
      { scopes: ["operator.write"] },
    );
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining('"node": "b"'),
    });
  });

  it("honors policy for disambiguated node tool names", () => {
    for (const nodeId of ["node-a", "node-b"]) {
      replaceConnectedNodePluginTools({
        nodeId,
        tools: [
          {
            pluginId: "remote-demo",
            name: "remote_echo",
            description: "Echo through a remote node",
            command: "remote.echo",
          },
        ],
      });
    }

    expect(
      createNodePluginTools({
        toolAllowlist: ["remote_echo_node_b"],
      }).map((tool) => tool.name),
    ).toEqual(["remote_echo_node_b"]);
    expect(
      createNodePluginTools({
        toolDenylist: ["remote_echo_node_b"],
      }).map((tool) => tool.name),
    ).toEqual(["remote_echo_node_a"]);
  });

  it("keeps disambiguated node tool names provider-safe", () => {
    const longName = `a${"b".repeat(63)}`;
    for (const nodeId of ["node-a", "node-b"]) {
      replaceConnectedNodePluginTools({
        nodeId,
        tools: [
          {
            pluginId: "remote-demo",
            name: longName,
            description: "Echo through a remote node",
            command: "remote.echo",
          },
        ],
      });
    }

    const names = createNodePluginTools({}).map((tool) => tool.name);

    expect(names).toHaveLength(2);
    expect(names.every((name) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name))).toBe(true);
    expect(names[0]).not.toBe(names[1]);
  });

  it("honors plugin tool allow and deny policy", () => {
    replaceConnectedNodePluginTools({
      nodeId: "node-1",
      tools: [
        {
          pluginId: "remote-demo",
          name: "remote_echo",
          description: "Echo through a remote node",
          command: "remote.echo",
        },
        {
          pluginId: "remote-demo",
          name: "remote_status",
          description: "Read remote status",
          command: "remote.status",
        },
      ],
    });

    expect(
      createNodePluginTools({
        toolAllowlist: ["remote-demo"],
        toolDenylist: ["remote_status"],
      }).map((tool) => tool.name),
    ).toEqual(["remote_echo"]);
    expect(createNodePluginTools({ toolAllowlist: ["other-plugin"] })).toEqual([]);
  });
});
