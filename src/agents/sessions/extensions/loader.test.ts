// Extension loader tests cover SDK import resolution for jiti-loaded TypeScript
// extensions.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadExtensions } from "./loader.js";
import type { ExtensionContext } from "./types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("loadExtensions", () => {
  it("resolves plugin SDK subpaths in jiti-loaded extensions", async () => {
    // Extensions import both public SDK helpers and runtime helper subpaths; the
    // loader must route those aliases without package-manager involvement.
    const dir = await mkdtemp(join(tmpdir(), "openclaw-extension-sdk-"));
    tempDirs.push(dir);
    const extensionPath = join(dir, "extension.ts");
    await writeFile(
      extensionPath,
      `
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export default async function(api) {
  const stream = createAssistantMessageEventStream();
  if (!stream || typeof stream.result !== "function") {
    throw new Error("generic LLM helper unavailable");
  }
  if (normalizeLowercaseStringOrEmpty("  MIXED  ") !== "mixed") {
    throw new Error("generic sdk subpath unavailable");
  }
  api.registerCommand("sdk-subpath-probe", {
    description: "probe",
    handler() {},
  });
}
`,
    );

    const result = await loadExtensions([extensionPath], dir);

    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0]?.commands.has("sdk-subpath-probe")).toBe(true);
  });

  it("skips unreadable registered tools without failing the extension", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openclaw-extension-bad-tool-"));
    tempDirs.push(dir);
    const extensionPath = join(dir, "extension.ts");
    await writeFile(
      extensionPath,
      `
export default async function(api) {
  const unreadableNameTool = {
    get name() {
      throw new Error("boom name");
    },
    label: "Bad Name",
    description: "Breaks while reading the name.",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "bad" }], details: {} };
    },
  };
  const unreadableParametersTool = {
    name: "bad_parameters",
    label: "Bad Parameters",
    description: "Breaks while reading the schema.",
    get parameters() {
      throw new Error("boom params");
    },
    async execute() {
      return { content: [{ type: "text", text: "bad" }], details: {} };
    },
  };
  const healthyTool = {
    name: "healthy_lookup",
    label: "Healthy Lookup",
    description: "Uses state from the original tool object.",
    parameters: { type: "object", properties: {} },
    calls: 0,
    async execute() {
      this.calls += 1;
      return { content: [{ type: "text", text: String(this.calls) }], details: {} };
    },
  };
  api.registerTool(unreadableNameTool);
  api.registerTool(unreadableParametersTool);
  api.registerTool(healthyTool);
  api.registerCommand("after-bad-tool", {
    description: "probe",
    handler() {},
  });
}
`,
    );

    const result = await loadExtensions([extensionPath], dir);

    expect(result.errors).toEqual([
      { path: extensionPath, error: "skipped extension tool registration: boom name" },
      {
        path: extensionPath,
        error: 'skipped extension tool registration for "bad_parameters": boom params',
      },
    ]);
    expect(result.extensions).toHaveLength(1);
    expect(Array.from(result.extensions[0]?.tools.keys() ?? [])).toEqual(["healthy_lookup"]);
    expect(result.extensions[0]?.commands.has("after-bad-tool")).toBe(true);

    const definition = result.extensions[0]?.tools.get("healthy_lookup")?.definition;
    const toolResult = await definition?.execute(
      "call-1",
      {},
      undefined,
      undefined,
      undefined as unknown as ExtensionContext,
    );

    expect(toolResult?.content).toEqual([{ type: "text", text: "1" }]);
  });
});
