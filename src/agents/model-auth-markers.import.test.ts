import { afterEach, expect, it, vi } from "vitest";
import { snapshotReaderSlot } from "../plugins/plugin-metadata-snapshot-readers.js";

// mock-isolation: Fail if the marker SDK eagerly loads the canonical manifest owner.
vi.mock("../plugins/manifest-metadata-scan.js", () => {
  throw new Error("Marker SDK imports must not reload the manifest metadata owner");
});
// mock-isolation: Fail if the marker SDK eagerly loads the canonical provider env owner.
vi.mock("../secrets/provider-env-vars.js", () => {
  throw new Error("Marker SDK imports must not reload the provider env policy owner");
});

const previousReaders = Object.getOwnPropertyDescriptors(snapshotReaderSlot);
afterEach(() => {
  for (const key of Reflect.ownKeys(snapshotReaderSlot)) {
    Reflect.deleteProperty(snapshotReaderSlot, key);
  }
  Object.defineProperties(snapshotReaderSlot, previousReaders);
});

it("imports the actual marker SDK and reads canonical host policy without its cold graph", async () => {
  const listManifests = vi.fn(() => [
    {
      pluginDir: "/fixture/bundled",
      origin: "bundled",
      manifest: { id: "bundled", nonSecretAuthMarkers: [" fixture-local "] },
    },
    {
      pluginDir: "/fixture/global",
      origin: "global",
      manifest: { id: "global", nonSecretAuthMarkers: ["global-local"] },
    },
  ]);
  const listEnvNames = vi.fn(() => ["FIXTURE_API_KEY", "FIXTURE_USAGE_KEY"]);
  Object.assign(snapshotReaderSlot, {
    listOpenClawPluginManifestMetadata: listManifests,
    listKnownProviderAuthEnvVarNamesCore: listEnvNames,
  });
  const { isNonSecretApiKeyMarker } = await import("../plugin-sdk/provider-auth-markers.js");
  const canonical = await import("./model-auth-markers.js");
  expect(isNonSecretApiKeyMarker).toBe(canonical.isNonSecretApiKeyMarker);
  expect(listManifests).not.toHaveBeenCalled();
  expect(listEnvNames).not.toHaveBeenCalled();
  expect(isNonSecretApiKeyMarker("fixture-local")).toBe(true);
  expect(isNonSecretApiKeyMarker("global-local", { includeEnvVarName: false })).toBe(false);
  expect(listEnvNames).not.toHaveBeenCalled();
  expect(isNonSecretApiKeyMarker("FIXTURE_API_KEY")).toBe(true);
  expect(isNonSecretApiKeyMarker("FIXTURE_USAGE_KEY")).toBe(true);
  expect(isNonSecretApiKeyMarker("ARBITRARY_ALL_CAPS")).toBe(false);
  expect(isNonSecretApiKeyMarker("fixture-credential")).toBe(false);
  expect(isNonSecretApiKeyMarker("FIXTURE_API_KEY", { includeEnvVarName: false })).toBe(false);
  expect(listManifests).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(listEnvNames).toHaveBeenCalledExactlyOnceWith(undefined);
});
