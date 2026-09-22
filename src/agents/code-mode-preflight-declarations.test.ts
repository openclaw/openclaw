import { Type } from "typebox";
import ts from "typescript";
import { afterEach, expect, it } from "vitest";
import { createCodeModeCatalogProjection } from "./code-mode-catalog.js";
import { createCodeModeNamespaceRuntime } from "./code-mode-namespaces.js";
import { createPreflightDeclarations } from "./code-mode-preflight-declarations.js";
import { checkCodeModeTypes } from "./code-mode-typecheck.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
} from "./code-mode.test-support.js";
import {
  addClientToolsToToolCatalog,
  resolveCatalog,
  restrictToolSearchCatalog,
} from "./tool-search-catalog.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import { jsonResult } from "./tools/common.js";

const maxBytes = 16 * 1024 * 1024;
afterEach(resetCodeModeTestState);

function declarationsHarness() {
  const h = createCodeModeHarness();
  const target = pluginToolWithExecute("contract", "Typed contract", async () =>
    jsonResult({ count: 1 }),
  );
  const input = {
    type: "object",
    properties: { count: { type: "number" } },
    required: ["count"],
    additionalProperties: false,
  };
  const output = {
    type: "object",
    properties: { count: { type: "number" } },
    required: ["count"],
    additionalProperties: false,
  };
  target.parameters = input;
  target.outputSchema = output;
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, target] });
  const apiFiles = [{ path: "fixture.d.ts", content: "declare const fixture: number;", bytes: 30 }];
  const prepare = async (allowance = maxBytes) => {
    const runtime = new ToolSearchRuntime(h.ctx, {
      enabled: true,
      mode: "code",
      codeTimeoutMs: 30_000,
      searchDefaultLimit: 8,
      maxSearchLimit: 50,
    });
    return await createPreflightDeclarations(
      runtime,
      createCodeModeCatalogProjection(runtime.all({ includeMcp: false })),
      apiFiles,
      createCodeModeNamespaceRuntime([]),
      allowance,
      resolveCatalog(h.ctx),
    );
  };
  const check = async (code: string) =>
    await checkCodeModeTypes(ts, code, { declarations: await prepare(), maxBytes });
  return { ...h, target, input, output, apiFiles, prepare, check };
}

it("checks current mutable contracts and API files after warming declarations", async () => {
  const h = declarationsHarness();
  const numeric =
    "const row = await contract({count: 1}); return row.count.toFixed() + fixture.toFixed();";
  await h.check(numeric);
  await h.check(numeric);
  h.input.properties.count.type = "string";
  await expect(h.check(numeric)).rejects.toThrow(
    "Type 'number' is not assignable to type 'string'",
  );
  h.input.properties.count.type = "number";
  h.output.properties.count.type = "string";
  await expect(h.check(numeric)).rejects.toThrow(
    "Property 'toFixed' does not exist on type 'string'",
  );
  h.output.properties.count.type = "number";
  h.apiFiles[0]!.content = "declare const fixture: string;";
  await expect(h.check(numeric)).rejects.toThrow(
    "Property 'toFixed' does not exist on type 'string'",
  );
  await h.check(
    "const row = await contract({count: 1}); return row.count.toFixed() + fixture.toUpperCase();",
  );
  expect(h.target.execute).not.toHaveBeenCalled();
});

it("rechecks declaration and standard-library bytes with a smaller warm allowance", async () => {
  const h = declarationsHarness();
  const declarations = await h.prepare();
  await h.prepare();
  await expect(h.prepare(Buffer.byteLength(declarations, "utf8"))).rejects.toThrow(
    "preflight declarations exceed the existing memory allowance",
  );
  const code = "return new Map<string, number>().size;";
  await checkCodeModeTypes(ts, code, { declarations, maxBytes });
  await expect(checkCodeModeTypes(ts, code, { declarations, maxBytes: 64 * 1024 })).rejects.toThrow(
    "preflight input exceeds the existing memory allowance",
  );
  await checkCodeModeTypes(ts, code, { declarations, maxBytes });
});

it("checks appended, restricted, and replaced catalogs after warming declarations", async () => {
  const h = declarationsHarness();
  await h.check("return await contract({count: 1});");
  const added = pluginToolWithExecute("added", "New contract", async () => jsonResult(null));
  added.parameters = Type.Object({}, { additionalProperties: false });
  addClientToolsToToolCatalog({ ...h.ctx, enabled: true, tools: [added] });
  await h.check("return await added({});");
  restrictToolSearchCatalog({ ...h.ctx, allowedToolNames: new Set(["added"]) });
  await expect(h.check("return await contract({count: 1});")).rejects.toThrow(
    "Cannot find name 'contract'",
  );
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, h.target] });
  await h.check("return await contract({count: 1});");
  await expect(h.check("return await added({});")).rejects.toThrow("Cannot find name 'added'");
});

it("keeps client schemas opaque during repeated declaration preparation", async () => {
  const h = declarationsHarness();
  const catalog = resolveCatalog(h.ctx);
  const hostile = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("client schema traversed");
      },
    },
  );
  catalog.entries.push({
    id: "client:fixture:remote",
    name: "remote",
    source: "client",
    description: "Remote client",
    parameters: hostile,
    tool: h.target,
  });
  await h.check('return await remote({anything: "accepted"});');
  await h.check('return await remote({anything: "accepted"});');
  await expect(h.check("const value = await remote({}); return value.count;")).rejects.toThrow(
    "is of type 'unknown'",
  );
});

it("rejects a changed output type through the registered exec before repeating effects", async () => {
  const h = declarationsHarness();
  const args = {
    language: "typescript",
    typecheck: true,
    code: "const value = await contract({count: 1}); return value.count.toFixed();",
  };
  expect(resultDetails(await h.tools[0]!.execute("warm", args))).toMatchObject({
    status: "completed",
    value: "1",
  });
  h.output.properties.count.type = "string";
  const rejected = resultDetails(await h.tools[0]!.execute("changed", args));
  expect(rejected).toMatchObject({
    status: "failed",
    code: "invalid_input",
    bridgeDispatchStarted: false,
  });
  expect(rejected.error).toContain("Property 'toFixed' does not exist on type 'string'");
  expect(h.target.execute).toHaveBeenCalledOnce();
});

it("preserves bounded declarations when unused schema metadata is cyclic", async () => {
  const h = declarationsHarness();
  Object.assign(h.output, { metadata: h.output });
  const numeric = "const row = await contract({count: 1}); return row.count.toFixed();";
  await h.check(numeric);
  await h.check(numeric);
  h.output.properties.count.type = "string";
  await expect(h.check(numeric)).rejects.toThrow(
    "Property 'toFixed' does not exist on type 'string'",
  );
});

it.each(["own", "inherited"])(
  "does not invoke %s toJSON hooks or let them hide a changed contract",
  async (placement) => {
    const h = declarationsHarness();
    let calls = 0;
    const hook = {
      toJSON() {
        calls += 1;
        return "constant";
      },
    };
    if (placement === "own") {
      Object.assign(h.output, hook);
    } else {
      Object.setPrototypeOf(h.output, hook);
    }
    const numeric = "const row = await contract({count: 1}); return row.count.toFixed();";
    await h.check(numeric);
    await h.check(numeric);
    h.output.properties.count.type = "string";
    await expect(h.check(numeric)).rejects.toThrow(
      "Property 'toFixed' does not exist on type 'string'",
    );
    expect(calls).toBe(0);
  },
);
