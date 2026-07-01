// Extension loader tests cover SDK import resolution for jiti-loaded TypeScript
// extensions.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadExtensions } from "./loader.js";

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

  it("rejects extension tools without a readable non-empty string name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openclaw-extension-tool-name-"));
    tempDirs.push(dir);
    const extensionPath = join(dir, "extension.ts");
    await writeFile(
      extensionPath,
      `
export default async function(api) {
  api.registerTool({
    name: 123,
    label: "Broken",
    description: "broken",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [], details: {} };
    },
  });
}
`,
    );

    const result = await loadExtensions([extensionPath], dir);

    expect(result.extensions).toEqual([]);
    expect(result.errors).toEqual([
      {
        path: extensionPath,
        error:
          "Failed to load extension: Extension tool registration requires a non-empty string name; received 123",
      },
    ]);
  });

  it("rejects extension tools whose name accessor throws", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openclaw-extension-tool-name-"));
    tempDirs.push(dir);
    const extensionPath = join(dir, "extension.ts");
    await writeFile(
      extensionPath,
      `
export default async function(api) {
  const tool = {
    label: "Broken",
    description: "broken",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [], details: {} };
    },
  };
  Object.defineProperty(tool, "name", {
    get() {
      throw new Error("tool name getter exploded");
    },
  });
  api.registerTool(tool);
}
`,
    );

    const result = await loadExtensions([extensionPath], dir);

    expect(result.extensions).toEqual([]);
    expect(result.errors).toEqual([
      {
        path: extensionPath,
        error:
          "Failed to load extension: Extension tool registration requires a readable tool name: tool name getter exploded",
      },
    ]);
  });
});
