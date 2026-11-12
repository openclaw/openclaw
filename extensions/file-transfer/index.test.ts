import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

type NodeRow = Awaited<ReturnType<OpenClawPluginApi["runtime"]["nodes"]["list"]>>["nodes"][number];

const fileCommands = "file.stat file.fetch dir.list dir.fetch file.create file.write".split(" ");
const toolNames = "file_fetch dir_list dir_fetch file_write".split(" ");
const runtimeModules = [
  ...fileCommands.map((name) => `./src/node-host/${name.replace(".", "-")}.js`),
  ...toolNames.map((name) => `./src/tools/${name.replace("_", "-")}-tool.js`),
  "./src/shared/node-invoke-policy.js",
];
for (const moduleName of runtimeModules) {
  vi.doMock(moduleName, () => {
    throw new Error(`${moduleName} imported during descriptor registration`);
  });
}
const { default: pluginEntry } = await import("./index.js");

afterAll(() => {
  runtimeModules.forEach((moduleName) => vi.doUnmock(moduleName));
  vi.resetModules();
});

describe("file-transfer plugin entry", () => {
  const api = {
    runtime: { nodes: { list: vi.fn<OpenClawPluginApi["runtime"]["nodes"]["list"]>() } },
    registerNodeHostCommand: vi.fn(),
    registerNodeInvokePolicy: vi.fn(),
    registerTool: vi.fn(),
    registerCli: vi.fn(),
  };
  const filePolicy = () =>
    api.registerNodeInvokePolicy.mock.calls.find(([entry]) =>
      entry.commands.includes("file.fetch"),
    )?.[0];

  beforeEach(() => {
    vi.clearAllMocks();
    api.runtime.nodes.list.mockResolvedValue({ nodes: [] });
    pluginEntry.register(api as never);
  });

  const listingSupport = () =>
    Promise.all(api.registerTool.mock.calls.map(([, options]) => options.listingSupported({})));

  it("keeps configured remote overrides unknown without probing them", async () => {
    const context = {
      config: { gateway: { mode: "local", remote: { url: "wss://desktop.example" } } },
    };
    await expect(
      Promise.all(
        api.registerTool.mock.calls.map(([, options]) => options.listingSupported(context)),
      ),
    ).resolves.toEqual([undefined, undefined, undefined, undefined]);
    expect(api.runtime.nodes.list).not.toHaveBeenCalled();
  });

  it("lists only each tool's effective command, including offline nodes", async () => {
    const commands = ["file.fetch", "dir.list", "dir.fetch", "file.write"];
    for (const [index, command] of commands.entries()) {
      const nodes: NodeRow[] = [
        { nodeId: "offline", connected: false, commands, invocableCommands: [command] },
      ];
      api.runtime.nodes.list.mockImplementation(async (params) => ({
        nodes: params?.connected ? nodes.filter((node) => node.connected) : nodes,
      }));
      await expect(listingSupport()).resolves.toEqual(commands.map((_, i) => i === index));
    }
  });

  it("falls back to advertised commands only when effective commands are absent", async () => {
    api.runtime.nodes.list.mockResolvedValue({
      nodes: [{ nodeId: "paired", commands: ["dir.list"] }],
    });
    await expect(listingSupport()).resolves.toEqual([false, true, false, false]);
    api.runtime.nodes.list.mockResolvedValue({
      nodes: [{ nodeId: "denied", commands: fileCommands, invocableCommands: [] }],
    });
    await expect(listingSupport()).resolves.toEqual([false, false, false, false]);
    api.runtime.nodes.list.mockResolvedValue({ nodes: [] });
    await expect(listingSupport()).resolves.toEqual([false, false, false, false]);
  });

  it("registers static command and tool descriptors without importing runtime handlers", () => {
    expect(pluginEntry.nodeHostCommands?.map((entry) => entry.command)).toEqual(fileCommands);
    expect(api.registerNodeHostCommand.mock.calls.map(([entry]) => entry.command)).toEqual(
      "workspace.memory workspace.skills".split(" "),
    );
    expect(api.registerNodeInvokePolicy).toHaveBeenCalledTimes(3);
    expect(filePolicy()?.commands).toEqual(
      "file.fetch file.stat dir.list dir.fetch file.write file.create".split(" "),
    );
    expect(api.registerCli.mock.calls[0]?.[1]?.descriptors).toEqual([
      {
        name: "file-transfer",
        description: "Review file-transfer standing approvals",
        hasSubcommands: true,
      },
    ]);
    expect(api.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual(toolNames);
    const dirTool = api.registerTool.mock.calls.find(([{ name }]) => name === "dir_fetch")?.[0];
    expect(dirTool?.parameters).toMatchObject({ type: "object", required: ["node", "path"] });
    expect(dirTool.parameters).not.toHaveProperty("properties.includeDotfiles");
  });

  it("reports every node command idle between invokes so node auto-update can activate", () => {
    // The node host counts in-flight invokes itself; a missing or non-false hook defers updates forever.
    const commands = [
      ...(pluginEntry.nodeHostCommands ?? []),
      ...api.registerNodeHostCommand.mock.calls.map(([entry]) => entry),
    ];
    expect(commands.map((entry) => entry.hasActiveWork?.())).toEqual(Array<boolean>(8).fill(false));
  });

  it("fails closed if the lazy policy module cannot load", async () => {
    const invokeNode = vi.fn();
    await expect(
      filePolicy().handle({
        nodeId: "node-1",
        command: "file.fetch",
        params: { path: "/tmp/a.txt" },
        config: {},
        pluginConfig: {},
        client: null,
        invokeNode,
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "PLUGIN_POLICY_UNAVAILABLE",
      unavailable: true,
    });
    expect(invokeNode).not.toHaveBeenCalled();
  });
});
