import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { typeCheckSources } from "../../test/helpers/typescript.js";
import { createMcpApiVirtualFiles } from "./code-mode-mcp-api.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  mcpTool,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
} from "./code-mode.test-support.js";
import { projectMcpCallToolResult } from "./mcp-content.js";
import { jsonResult } from "./tools/common.js";

afterEach(resetCodeModeTestState);
it("supports root MCP API and multiple server declarations", async () => {
  const h = createCodeModeHarness();
  const targets = ["alpha", "beta", "index"].map((serverName) =>
    mcpTool({
      name: serverName + "_ping",
      serverName,
      toolName: "ping",
      execute: vi.fn(async () =>
        projectMcpCallToolResult({ content: [{ type: "text", text: "pong" }] }),
      ),
    }),
  );
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, ...targets] });
  const result = resultDetails(
    await expectDefined(h.tools[0], "exec").execute("root-api", {
      code: `
          const root = await MCP.$api();
          const rootFile = await API.read("mcp/index.d.ts");
          const a = await MCP.alpha.$api();
          const b = await MCP.beta.$api();
          await MCP.alpha.ping();
          await MCP.beta.ping();
          await MCP.index.ping();
          const [indexTool] = await catalog.search("MCP.index.ping", { limit: 1 });
          const indexFile = indexTool.source === "mcp" ? await API.read(indexTool.apiPath) : undefined;
          return {
            headers: [typeof root.header, typeof a.header, typeof b.header],
            rootDeclaration: rootFile.content.includes(root.header),
            indexDeclaration: indexFile?.content.includes("declare namespace MCP.index"),
          };
        `,
    }),
  );
  expect(result, JSON.stringify(result)).toMatchObject({
    status: "completed",
    value: {
      headers: ["string", "string", "string"],
      rootDeclaration: true,
      indexDeclaration: true,
    },
  });
  for (const target of targets) {
    expect(target.execute).toHaveBeenCalledOnce();
  }
});

it("allows omitted native empty inputs but preserves required fields", async () => {
  const h = createCodeModeHarness();
  const optional = pluginToolWithExecute("optional_input", "Optional input", async () =>
    jsonResult("ok"),
  );
  optional.parameters = Type.Object(
    { flag: Type.Optional(Type.Boolean()) },
    { additionalProperties: false },
  );
  const required = pluginToolWithExecute("required_input", "Required input", async () =>
    jsonResult("ok"),
  );
  required.parameters = Type.Object({ flag: Type.Boolean() }, { additionalProperties: false });
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, optional, required] });
  const exec = expectDefined(h.tools[0], "exec");
  const result = resultDetails(
    await exec.execute("optional", {
      code: "await optional_input(); return await required_input({flag: true});",
    }),
  );
  expect(result, JSON.stringify(result)).toMatchObject({ status: "completed", value: "ok" });
  expect(optional.execute).toHaveBeenCalledOnce();
  expect(required.execute).toHaveBeenCalledOnce();
  const refused = resultDetails(
    await exec.execute("required", {
      code: "return await required_input();",
    }),
  );
  expect(refused.status).toBe("failed");
  expect(required.execute).toHaveBeenCalledOnce();
});

it("keeps an explicit tool error's text when its details carry no message", async () => {
  const h = createCodeModeHarness();
  const reason = "Start the Gateway with visitor-access enabled before managing visitors.";
  const errorTool = (name: string, text: string, details: unknown) =>
    pluginToolWithExecute(name, "Fail", async () => ({
      content: [{ type: "text" as const, text }],
      details,
      isError: true,
    }));
  const tools = [
    errorTool("flag_only", reason, { error: true }),
    errorTool("no_details", "Gateway unavailable.", undefined),
    errorTool("blank_message", "Visitor store is locked.", { error: true, message: " " }),
    errorTool("structured", "Rendered failure.", { status: "failed", error: "structured" }),
  ];
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, ...tools] });
  const result = resultDetails(
    await expectDefined(h.tools[0], "exec").execute("tool-error-text", {
      code: "return [await flag_only(), await no_details(), await blank_message(), await structured()];",
    }),
  );
  expect(result.status, JSON.stringify(result)).toBe("completed");
  expect(result.value).toEqual([
    { error: true, message: reason },
    { message: "Gateway unavailable." },
    { error: true, message: "Visitor store is locked." },
    { status: "failed", error: "structured" },
  ]);
});

it("merges actual root and multiple server files without skipping declaration errors", () => {
  const files = createMcpApiVirtualFiles(
    ["alpha", "beta", "index"].map((identifier) => ({
      identifier,
      serverName: identifier,
      tools: [],
    })),
  );
  const texts = new Map(files.map((file) => ["/" + file.path, file.content]));
  texts.set("/consumer.ts", "MCP.$api(); MCP.alpha.$api(); MCP.beta.$api(); MCP.index.$api();");
  expect(typeCheckSources(Object.fromEntries(texts))).toEqual([]);
});
