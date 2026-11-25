import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runtimeConfigPublication } from "../config/runtime-config-publication.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProviderDisplayName } from "./provider-display-name.js";

const readers = vi.hoisted(() => ({
  current: vi.fn<(params?: { config?: OpenClawConfig }) => unknown>(),
  discover: vi.fn(() => {
    throw new Error("discovery unavailable");
  }),
}));
vi.mock("../plugins/plugin-metadata-snapshot.runtime.js", async (original) => ({
  ...(await original<typeof import("../plugins/plugin-metadata-snapshot.runtime.js")>()),
  getCurrentPluginMetadataSnapshotRuntime: readers.current,
}));
vi.mock("../plugins/plugin-metadata-snapshot-required.js", async (original) => ({
  ...(await original<typeof import("../plugins/plugin-metadata-snapshot-required.js")>()),
  getCurrentPluginMetadataSnapshotRequiredRuntime: readers.current,
  loadPluginMetadataSnapshotRuntime: readers.discover,
}));
const published = runtimeConfigPublication.current;
beforeEach(() => {
  readers.current.mockReset();
  readers.discover.mockClear();
  runtimeConfigPublication.current = undefined;
});
afterEach(() => {
  runtimeConfigPublication.current = published;
});

it("names bundled providers without discovery, even when metadata cannot load", () => {
  expect(resolveProviderDisplayName("claude-cli")).toBe("Claude CLI");
  expect(resolveProviderDisplayName("google-vertex")).toBe("Google Vertex AI");
  for (const id of ["constructor", "__proto__", "workstation"]) {
    expect(resolveProviderDisplayName(id)).toBe(id);
  }
  expect(resolveProviderDisplayName("legacy", { fallbackName: "Legacy Cloud" })).toBe(
    "Legacy Cloud",
  );
  expect(readers.discover).not.toHaveBeenCalled();
});

it("honors explicit configuration before published config and chooses matching metadata", () => {
  const config: OpenClawConfig = {
    models: {
      providers: {
        openrouter: { models: [], baseUrl: "https://example.test", name: "Team router" },
      },
    },
  };
  runtimeConfigPublication.current = { config, revision: {} };
  expect(resolveProviderDisplayName("openrouter")).toBe("Team router");
  expect(resolveProviderDisplayName("openrouter", { config: {} })).toBe("OpenRouter");
  const selected = {};
  readers.current.mockImplementation((params) => ({
    owners: {
      providerNames: new Map([
        ["external", params?.config === selected ? "Selected provider" : "Wrong provider"],
      ]),
    },
  }));
  expect(resolveProviderDisplayName("external", { config: selected })).toBe("Selected provider");
  expect(resolveProviderDisplayName("external", { config: selected, owners: {} })).toBe("external");
});
