// Extension loader tests cover SDK import resolution for jiti-loaded TypeScript
// extensions.
import { cp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { clearExtensionCache, loadExtensionsCached } from "./loader.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  clearExtensionCache();
});

describe("loadExtensionsCached", () => {
  let result: Awaited<ReturnType<typeof loadExtensionsCached>>;

  beforeAll(async () => {
    clearExtensionCache();
    // Extensions import public SDK helpers through package subpaths; the loader
    // must route those aliases without package-manager involvement.
    const dir = tempDirs.make("openclaw-extension-sdk-");
    const extensionPath = join(dir, "extension.ts");
    await writeFile(
      extensionPath,
      `
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export default async function(api) {
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

    result = await loadExtensionsCached([extensionPath], dir);
  });

  it("resolves a public plugin SDK subpath in jiti-loaded extensions", () => {
    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0]?.commands.has("sdk-subpath-probe")).toBe(true);
  });

  it.each([
    { sdk: "openclaw/plugin-sdk/agent-sessions", typebox: "typebox" },
    { sdk: "@openclaw/plugin-sdk/agent-sessions", typebox: "@sinclair/typebox" },
  ])("loads the host session SDK and schema helpers through $sdk", async ({ sdk, typebox }) => {
    const dir = tempDirs.make("openclaw-extension-session-sdk-");
    const extensionPath = join(dir, "extension.ts");
    await writeFile(
      extensionPath,
      `
import { AuthStorage, ModelRegistry } from "${sdk}";
import { streamProxy, IMAGE_BLOCK_TOKENS } from "${sdk.replace("agent-sessions", "agent-core")}";
import { Type } from "${typebox}";
import { Compile } from "${typebox}/compile";
import { IsEmail } from "${typebox}/format";
import { Check } from "${typebox}/value";

export default function(api) {
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory({}));
  registry.registerProvider("sdk-probe", {
    api: "openai-responses",
    baseUrl: "https://example.test",
    models: [{ id: "probe" }],
  });
  const schema = Type.Number();
  if (!Compile(schema).Check(1) || Check(schema, "invalid") || !IsEmail("probe@example.test")) {
    throw new Error("host schema helpers did not preserve their contracts");
  }
  if (typeof streamProxy !== "function" || !(IMAGE_BLOCK_TOKENS > 0)) {
    throw new Error("public agent-core exports were lost");
  }
  api.registerCommand("session-sdk-probe", {
    description: registry.find("sdk-probe", "probe").id,
    handler() {},
  });
}
`,
    );

    const loaded = await loadExtensionsCached([extensionPath], dir);
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions[0]?.commands.get("session-sdk-probe")?.description).toBe("probe");
  });

  it("shares TypeBox format and settings registries with extensions that install their own copy", async () => {
    const dir = tempDirs.make("openclaw-extension-typebox-state-");
    const packageRoot = fileURLToPath(new URL("../", import.meta.resolve("typebox")));
    // A physical package copy exposes registry splits that source-only imports would hide.
    await cp(packageRoot, join(dir, "node_modules", "typebox"), {
      recursive: true,
      dereference: true,
    });
    const extensionPath = join(dir, "extension.ts");
    await writeFile(
      extensionPath,
      `
import { Type } from "typebox";
import { Format } from "typebox/format";
import { Compile } from "typebox/schema";
import { Compile as CompileValue } from "typebox/compile";
import { Settings } from "typebox/system";

export default function(api) {
  const previousFormats = Format.Entries();
  const previousSettings = { ...Settings.Get() };
  try {
    Format.Set("extension-registry-probe", (value) => value === "accepted");
    const validator = Compile(Type.String({ format: "extension-registry-probe" }));
    Settings.Set({ exactOptionalPropertyTypes: true });
    const optionalValidator = CompileValue(Type.Object({ value: Type.Optional(Type.Number()) }));
    api.registerCommand("typebox-state-probe", {
      description: JSON.stringify({
        valid: validator.Check("accepted"),
        invalidFormat: validator.Check("rejected"),
        invalidOptional: optionalValidator.Check({ value: undefined }),
      }),
      handler() {},
    });
  } finally {
    Format.Clear();
    for (const [name, check] of previousFormats) Format.Set(name, check);
    Settings.Set(previousSettings);
  }
}
`,
    );

    const loaded = await loadExtensionsCached([extensionPath], dir);
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions[0]?.commands.get("typebox-state-probe")?.description).toBe(
      JSON.stringify({ valid: true, invalidFormat: false, invalidOptional: false }),
    );
  });
});
