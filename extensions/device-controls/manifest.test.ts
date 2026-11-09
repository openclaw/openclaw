import { fileURLToPath } from "node:url";
import { loadPluginManifestRegistryCore } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it } from "vitest";

it("admits the shipped manifest through the control-plane manifest owner", () => {
  const rootDir = fileURLToPath(new URL(".", import.meta.url));
  const registry = loadPluginManifestRegistryCore({
    installRecords: {},
    candidates: [
      {
        idHint: "device-controls",
        rootDir,
        source: fileURLToPath(new URL("./index.ts", import.meta.url)),
        origin: "bundled",
      },
    ],
    config: {
      plugins: { allow: ["device-controls"], entries: { "device-controls": { enabled: true } } },
    },
  });
  expect(registry.diagnostics.filter((entry) => entry.level === "error")).toEqual([]);
  const plugin = registry.plugins.find((entry) => entry.id === "device-controls");
  expect(plugin).toBeDefined();
  expect(plugin?.enabledByDefault).not.toBe(true);
  expect(
    plugin?.dashboard?.actionVerbs?.map((verb) => ({
      id: verb.id,
      method: verb.method,
      required: verb.requiredActionBindingParams,
    })),
  ).toEqual([
    { id: "audio", method: "device-controls.audio", required: ["nodeId", "operationId"] },
    { id: "audio-stop", method: "device-controls.audio-stop", required: ["nodeId", "operationId"] },
    {
      id: "pointer",
      method: "device-controls.pointer",
      required: ["nodeId", "operation", "screenIndex", "referenceWidth", "referenceHeight"],
    },
  ]);
});
