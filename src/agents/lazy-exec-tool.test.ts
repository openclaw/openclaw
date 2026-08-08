import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createModelExecSchema, execSchema, nodeExecSchema } from "./bash-tools.schemas.js";
import { createLazyExecTool } from "./lazy-exec-tool.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  resolveToolSearchConfig,
  ToolSearchRuntime,
} from "./tool-search.js";

function hostTargets(schema: { properties: { host?: unknown } }): string[] | undefined {
  return (schema.properties.host as { enum?: string[] } | undefined)?.enum;
}

describe("lazy exec model schema", () => {
  it.each([
    {
      name: "auto with sandbox",
      defaults: { host: "auto" as const, sandbox: {} as never },
      expected: ["auto", "sandbox"],
    },
    {
      name: "auto without sandbox",
      defaults: { host: "auto" as const },
      expected: ["auto", "gateway", "node"],
    },
    {
      name: "gateway pinned",
      defaults: { host: "gateway" as const },
      expected: ["gateway"],
    },
    {
      name: "sandbox pinned",
      defaults: { host: "sandbox" as const, sandbox: {} as never },
      expected: ["sandbox"],
    },
    {
      name: "node pinned",
      defaults: { host: "node" as const },
      expected: ["node"],
    },
  ])("advertises only $name targets", ({ defaults, expected }) => {
    expect(hostTargets(createModelExecSchema(defaults))).toEqual(expected);
  });

  it("preserves the full internal schema and node-only presentation", () => {
    createModelExecSchema({ host: "auto" });

    expect(hostTargets(execSchema)).toEqual(["auto", "sandbox", "gateway", "node"]);
    expect(hostTargets(nodeExecSchema)).toEqual(["node"]);
  });

  it("refuses to build an empty pinned-sandbox model schema", () => {
    expect(() => createModelExecSchema({ host: "sandbox" })).toThrow(
      'tools.exec.host="sandbox" requires an active sandbox runtime',
    );
  });

  it("keeps explicit presentation parameters authoritative", () => {
    const parameters = Type.Object({ command: Type.String() });

    expect(createLazyExecTool({ host: "gateway" }, { parameters }).parameters).toBe(parameters);
  });

  it("keeps direct and Tool Search or Code Mode describe schemas identical", async () => {
    const tool = createLazyExecTool({ host: "auto" });
    const catalogRef = createToolSearchCatalogRef();
    registerHeadlessToolSearchCatalog({ catalogRef, tools: [tool] });
    const runtime = new ToolSearchRuntime(
      { catalogRef },
      resolveToolSearchConfig({ tools: { toolSearch: true } } as never),
    );

    const described = await runtime.describe("exec");
    expect(described.parameters).toBe(tool.parameters);
  });
});
