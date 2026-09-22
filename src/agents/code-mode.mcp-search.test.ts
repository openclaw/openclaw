import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyCodeModeCatalog,
  createCodeModeTools,
  runCodeModeScriptHeadless,
} from "./code-mode.js";
import {
  createCodeModeHarness,
  mcpTool,
  pluginTool,
  resetCodeModeTestState,
  resultDetails,
  runUntilCompleted,
} from "./code-mode.test-support.js";
import { projectMcpCallToolResult } from "./mcp-content.js";
import { filterToolsByPolicy } from "./tool-policy-match.js";

function invoiceTool(toolName: string) {
  return mcpTool({
    name: `accounting__${toolName}`,
    serverName: "accounting",
    toolName,
    description: `Find overdue invoices. ${"Remote description. ".repeat(50)}`,
    parameters: {
      type: "object",
      properties: { currency: { type: "string", default: "EUR" } },
    },
    execute: vi.fn(async (_id, input) =>
      projectMcpCallToolResult({
        content: [],
        structuredContent: { toolName, input },
      }),
    ),
  });
}

afterEach(resetCodeModeTestState);

describe.each(["interactive", "headless"] as const)("Code Mode %s MCP discovery", (mode) => {
  it("finds native and MCP capabilities by intent and calls the correct colliding namespace", async () => {
    const { config, catalogRef, ctx, tools } = createCodeModeHarness();
    const native = pluginTool("invoices", "Find overdue invoices locally");
    const targets = [invoiceTool("listInvoices"), invoiceTool("list_invoices")];
    const denied = invoiceTool("delete_invoices");
    applyCodeModeCatalog({
      tools: filterToolsByPolicy([...tools, native, ...targets, denied], { deny: [denied.name] }),
      config,
      catalogRef,
    });
    const code = `
      const matches = await catalog.search("overdue invoices", { limit: 10 });
      const remote = matches.filter(tool => tool.source === "mcp");
      const result = [];
      for (const tool of remote) {
        const [exact] = await catalog.search(tool.callableName, { limit: 1 });
        const api = await tool.describe();
        const file = await API.read(tool.apiPath);
        result.push({
          tool,
          sameHandle: exact === tool,
          fileHasMethod: file.content.includes("function " + tool.callableName.split(".").at(-1) + "("),
          declaration: api.header,
          describedTools: api.tools.map(tool => tool.mcpTool),
          called: await tool(),
        });
      }
      return {
        count: matches.length,
        frozen: Object.isFrozen(matches) && matches.every(Object.isFrozen),
        native: await matches.find(tool => tool.source === "openclaw")({ value: "local" }),
        nativeNames: catalog.all().map(tool => tool.callableName),
        denied: (await catalog.search("delete_invoices")).filter(tool => tool.toolName === "delete_invoices"),
        deniedNamespace: typeof MCP.accounting.deleteInvoices,
        result,
      };
    `;
    const result =
      mode === "headless"
        ? await runCodeModeScriptHeadless({ ctx, code })
        : await runUntilCompleted({ execTool: tools[0]!, waitTool: tools[1]!, code });
    expect(result).toMatchObject({
      status: "completed",
      value: {
        count: 3,
        frozen: true,
        native: { name: "invoices", input: { value: "local" } },
        nativeNames: ["invoices"],
        denied: [],
        deniedNamespace: "undefined",
        result: expect.arrayContaining(
          targets.map((target, index) =>
            expect.objectContaining({
              tool: {
                source: "mcp",
                callableName: `MCP.accounting.listInvoices${index === 0 ? "2" : ""}`,
                toolName: index === 0 ? "listInvoices" : "list_invoices",
                description: target.description.slice(0, 512),
                apiPath: "mcp/accounting.d.ts",
              },
              sameHandle: true,
              fileHasMethod: true,
              describedTools: [index === 0 ? "listInvoices" : "list_invoices"],
              declaration: expect.stringContaining(
                `function listInvoices${index === 0 ? "2" : ""}(`,
              ),
              called: {
                content: [],
                structuredContent: {
                  toolName: index === 0 ? "listInvoices" : "list_invoices",
                  input: { currency: "EUR" },
                },
              },
            }),
          ),
        ),
      },
    });
    expect(JSON.stringify(result)).not.toContain("mcp:accounting:");
    for (const target of [native, ...targets]) {
      expect(target.execute).toHaveBeenCalledOnce();
    }
    expect(denied.execute).not.toHaveBeenCalled();
  });
});

it("bounds MCP discovery and wraps remote metadata before any tool executes", async () => {
  const { catalogRef, tools } = createCodeModeHarness();
  const config = { tools: { codeMode: { enabled: true, maxSearchLimit: 3 } } };
  const targets = Array.from({ length: 8 }, (_, index) => invoiceTool(`invoices_${index}`));
  applyCodeModeCatalog({ tools: [...tools, ...targets], catalogRef, config });
  const limitedTools = createCodeModeTools({ catalogRef, config });
  const result = await expectDefined(limitedTools[0], "exec").execute("metadata-only", {
    language: "typescript",
    typecheck: true,
    code: `
      const matches = await catalog.search("overdue invoices", { limit: 50 });
      for (const tool of matches) {
        if (tool.source === "mcp") await API.read(tool.apiPath);
      }
      return matches;
    `,
  });
  expect(resultDetails(result)).toMatchObject({ status: "completed", value: expect.any(Array) });
  const value = resultDetails(result).value as unknown[];
  expect(value).toHaveLength(3);
  expect(result.content[0]).toMatchObject({
    text: expect.stringContaining("EXTERNAL_UNTRUSTED_CONTENT"),
  });
  expect(tools[0]?.description).not.toContain("Remote description.");
  for (const target of targets) {
    expect(target.execute).not.toHaveBeenCalled();
  }
});

it("round-trips qualified MCP names across native aliases and case-sensitive methods", async () => {
  const { config, catalogRef, tools } = createCodeModeHarness();
  const native = pluginTool("MCP.accounting.listUrl", "Find overdue invoices locally");
  const targets = [invoiceTool("listURL"), invoiceTool("listUrl")];
  applyCodeModeCatalog({ tools: [...tools, native, ...targets], config, catalogRef });
  const result = await runUntilCompleted({
    execTool: tools[0]!,
    waitTool: tools[1]!,
    code: `
      const matches = await catalog.search("overdue invoices");
      return await Promise.all(matches.filter(tool => tool.source === "mcp").map(async tool => {
        const [exact] = await catalog.search(tool.callableName, { limit: 1 });
        return { name: tool.toolName, sameHandle: exact === tool, called: await exact() };
      }));
    `,
  });
  expect(result).toMatchObject({
    status: "completed",
    value: expect.arrayContaining(
      ["listURL", "listUrl"].map((toolName) => ({
        name: toolName,
        sameHandle: true,
        called: { content: [], structuredContent: { toolName, input: { currency: "EUR" } } },
      })),
    ),
  });
  expect(native.execute).not.toHaveBeenCalled();
  for (const target of targets) {
    expect(target.execute).toHaveBeenCalledOnce();
  }
});
