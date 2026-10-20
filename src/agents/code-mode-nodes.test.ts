import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import type { ToolSearchCatalogToolExecutor } from "./tool-search.js";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

// mock-isolation: Exercise node dispatch without contacting a live Gateway.
vi.mock("./tools/gateway.js", () => gatewayMocks);

const listedNodes = [
  {
    id: "node-1",
    name: "Desk",
    platform: "darwin",
    connected: true,
    commands: ["device.status", "fs.listDir", "computer.act", "danger.read"],
  },
  { id: "node-2", name: "shadow-id", connected: false, commands: ["device.status"] },
];
const nodeSnapshot = [
  ...listedNodes.map(({ id, name, ...node }) => ({
    nodeId: id,
    displayName: name,
    paired: true,
    ...node,
  })),
  { nodeId: "shadow-id", paired: false, connected: false },
];

let applyCodeModeCatalog: typeof import("./code-mode.js").applyCodeModeCatalog;
let createCodeModeTools: typeof import("./code-mode.js").createCodeModeTools;
let createToolSearchCatalogRef: typeof import("./tool-search.js").createToolSearchCatalogRef;
let createNodesTool: typeof import("./tools/nodes-tool.js").createNodesTool;
let resetCodeModeTestState: typeof import("./code-mode.test-support.js").resetCodeModeTestState;

function resultDetails(result: { details?: unknown }): Record<string, unknown> {
  expect(result.details).toBeDefined();
  expect(typeof result.details).toBe("object");
  return result.details as Record<string, unknown>;
}

function createHarness() {
  const catalogRef = createToolSearchCatalogRef();
  const config = { tools: { codeMode: true } } as never;
  const nestedCalls: Parameters<ToolSearchCatalogToolExecutor>[0][] = [];
  const executeTool: ToolSearchCatalogToolExecutor = async (params) => {
    nestedCalls.push(params);
    const { tool, toolCallId, input, signal, onUpdate } = params;
    return await params.acceptResultBeforeProjection(
      await tool.execute(toolCallId, input, signal, onUpdate, undefined as never),
    );
  };
  const ctx = {
    config,
    runtimeConfig: config,
    sessionId: "session-code-mode-nodes",
    sessionKey: "agent:main:main",
    runId: "run-code-mode-nodes",
    catalogRef,
    executeTool,
  };
  const tools = createCodeModeTools(ctx);
  const nodesTool = createNodesTool({ agentSessionKey: ctx.sessionKey });
  applyCodeModeCatalog({ tools: [...tools, nodesTool], config, catalogRef });
  return {
    execTool: expectDefined(tools[0], "code mode exec tool"),
    waitTool: expectDefined(tools[1], "code mode wait tool"),
    nestedCalls,
  };
}

async function runUntilCompleted(code: string, params = createHarness()) {
  let details = resultDetails(await params.execTool.execute("code-nodes-call", { code }));
  for (let index = 0; index < 8 && details.status === "waiting"; index += 1) {
    details = resultDetails(
      await params.waitTool.execute(`code-nodes-wait-${index}`, { runId: details.runId }),
    );
  }
  return details;
}

function runCaught(code: string) {
  return runUntilCompleted(`
    try {
      ${code}
      return "unexpected success";
    } catch (error) {
      return error.message;
    }
  `);
}

describe("Code Mode nodes", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ applyCodeModeCatalog, createCodeModeTools } = await import("./code-mode.js"));
    ({ createToolSearchCatalogRef } = await import("./tool-search.js"));
    ({ createNodesTool } = await import("./tools/nodes-tool.js"));
    ({ resetCodeModeTestState } = await import("./code-mode.test-support.js"));
  });

  beforeEach(() => {
    gatewayMocks.callGatewayTool.mockReset();
    gatewayMocks.readGatewayCallOptions.mockReset().mockReturnValue({});
    gatewayMocks.callGatewayTool.mockImplementation(async (method, _options, input) => {
      if (method === "node.list") {
        return { nodes: nodeSnapshot };
      }
      if (method === "node.invoke") {
        const { nodeId, command, params } = input as {
          nodeId: string;
          command: string;
          params: unknown;
        };
        if (command === "danger.read") {
          throw new Error(
            'node command not allowed: "danger.read" is blocked by gateway.nodes.commands.deny',
          );
        }
        return { payload: { nodeId, command, params } };
      }
      throw new Error(`unexpected gateway method: ${String(method)}`);
    });
  });

  afterEach(() => resetCodeModeTestState());

  it("lists nodes and invokes typed handles", async () => {
    const harness = createHarness();
    const details = await runUntilCompleted(
      `
        const listed = await nodes.list();
        const node = await nodes.get(listed.find(entry => entry.connected)?.id ?? "Desk");
        return {
          listed,
          id: node.id,
          name: node.name,
          methods: Object.keys(node).sort(),
          invoked: await node.invoke("device.status", { detail: true }),
          directory: node.listDir ? await node.listDir("/tmp") : undefined,
          hasExec: "exec" in node,
        };
      `,
      harness,
    );

    expect(details.status).toBe("completed");
    expect(details.value).toEqual({
      listed: listedNodes,
      id: "node-1",
      name: "Desk",
      methods: ["id", "invoke", "listDir", "name"],
      invoked: {
        payload: { nodeId: "node-1", command: "device.status", params: { detail: true } },
      },
      directory: {
        payload: { nodeId: "node-1", command: "fs.listDir", params: { path: "/tmp" } },
      },
      hasExec: false,
    });
    expect(new Set(harness.nestedCalls.map(({ parentToolCallId }) => parentToolCallId))).toEqual(
      new Set(["code-nodes-call"]),
    );
  });

  it("omits listDir when the node does not advertise fs.listDir", async () => {
    expect(
      (await runUntilCompleted('return Object.keys(await nodes.get("node-2")).sort();')).value,
    ).toEqual(["id", "invoke", "name"]);
  });

  it.each([
    [
      "danger.read",
      undefined,
      ['node command not allowed: "danger.read"', "blocked by gateway.nodes.commands.deny"],
    ],
    [
      "computer.act",
      { action: "left_click", x: 1, y: 1 },
      ['invokeCommand "computer.act"', "use the dedicated computer tool"],
    ],
  ] as const)("preserves the generic nodes refusal for %s", async (command, input, messages) => {
    const details = await runCaught(`
        const node = await nodes.get("Desk");
        await node.invoke(${JSON.stringify(command)}, ${JSON.stringify(input)});
      `);
    for (const message of messages) {
      expect(details.value).toContain(message);
    }
    if (command === "computer.act") {
      expect(gatewayMocks.callGatewayTool).not.toHaveBeenCalledWith(
        "node.invoke",
        expect.anything(),
        expect.objectContaining({ command }),
      );
    }
  });

  it("rejects an ineligible exact id before matching an eligible node name", async () => {
    expect((await runCaught('await nodes.get("shadow-id");')).value).toBe(
      'node "shadow-id" is not paired (paired node ids: node-1, node-2)',
    );
  });

  it.each([
    {
      label: "list",
      code: `await nodes.list(); return missingAfterList();`,
    },
    {
      label: "get",
      code: `return (await nodes.get("Desk")).describe();`,
    },
  ])("reports a guest error after nodes.$label", async ({ code }) => {
    const details = await runUntilCompleted(code);

    expect(details).toMatchObject({
      status: "failed",
      failurePhase: "guest",
      bridgeDispatchStarted: true,
    });
  });

  it("reports a guest error after nodes.invoke without replaying the invocation", async () => {
    const details = await runUntilCompleted(`
        const node = await nodes.get("Desk");
        await node.invoke("device.status");
        return node.describe();
      `);

    expect(details).toMatchObject({
      status: "failed",
      failurePhase: "guest",
      bridgeDispatchStarted: true,
    });
    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      expect.anything(),
      expect.objectContaining({ nodeId: "node-1", command: "device.status" }),
    );
  });
});
