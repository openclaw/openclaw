import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { modelCatalogRowToEntry } from "./model-catalog-entry.js";
import { overlayCatalogMetadata } from "./model-catalog-metadata.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { buildConfiguredModelCatalog } from "./model-selection-shared.js";

// Session rows are invalidated by a deep-equality check over catalog entries, so an
// optional fact that is absent in one build and present-but-undefined in the next
// counts as a change even though nothing about the model changed.
describe("model catalog entry shape stability", () => {
  it("omits status instead of projecting an undefined key", () => {
    const entry = modelCatalogRowToEntry({
      id: "model-a",
      name: "Model A",
      provider: "acme",
      api: "openai-completions",
      reasoning: false,
    });

    expect(Object.hasOwn(entry, "status")).toBe(false);
    expect(isDeepStrictEqual(entry, { ...entry })).toBe(true);
  });

  it("keeps a reported status", () => {
    const entry = modelCatalogRowToEntry({
      id: "model-a",
      name: "Model A",
      provider: "acme",
      reasoning: false,
      status: "deprecated",
    });

    expect(entry.status).toBe("deprecated");
  });

  it("omits compat when neither the catalog route nor the config owns it", () => {
    const base: ModelCatalogEntry = {
      id: "model-a",
      name: "Model A",
      provider: "acme",
      api: "openai-completions",
      reasoning: false,
    };
    const overlay: ModelCatalogEntry = {
      id: "model-a",
      name: "Model A",
      provider: "acme",
      api: "openai-completions",
      reasoning: false,
      compat: { codeMode: "preferred" },
    };

    const merged = overlayCatalogMetadata(base, overlay, { preserveBaseCompat: true });

    // Matching routes keep the catalog's capabilities, which here means none at all.
    expect(Object.hasOwn(merged, "compat")).toBe(false);
  });

  it("keeps configured compat for a custom route", () => {
    const base: ModelCatalogEntry = {
      id: "model-a",
      name: "Model A",
      provider: "acme",
      api: "openai-completions",
      baseUrl: "https://catalog.test/v1",
      reasoning: false,
    };
    const overlay: ModelCatalogEntry = {
      id: "model-a",
      name: "Model A",
      provider: "acme",
      api: "openai-completions",
      baseUrl: "https://custom.test/v1",
      reasoning: false,
      compat: { codeMode: "preferred" },
    };

    const merged = overlayCatalogMetadata(base, overlay, { preserveBaseCompat: true });

    expect(merged.compat).toEqual({ codeMode: "preferred" });
  });

  it("clears inherited compat when a configured endpoint makes the route custom", () => {
    // The base row has no baseUrl, so catalogRouteChanges cannot see the route
    // change, but the resolver treats the configured endpoint as a custom route
    // and hands back no capabilities. The inherited flags must not survive.
    const base: ModelCatalogEntry = {
      id: "model-a",
      name: "Model A",
      provider: "acme",
      api: "openai-completions",
      reasoning: false,
      compat: { supportsTools: false },
    };
    const overlay: ModelCatalogEntry = {
      id: "model-a",
      name: "Model A",
      provider: "acme",
      api: "openai-completions",
      baseUrl: "https://custom.test/v1",
      reasoning: false,
    };

    const merged = overlayCatalogMetadata(base, overlay, { preserveBaseCompat: true });

    expect(Object.hasOwn(merged, "compat")).toBe(false);
  });

  it("builds configured rows without undefined optional facts", () => {
    const cfg = {
      models: {
        providers: {
          acme: {
            api: "openai-completions",
            models: [{ id: "model-a", name: "Model A" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const [entry] = buildConfiguredModelCatalog({ cfg });

    expect(entry).toBeDefined();
    for (const key of ["contextWindow", "contextTokens", "reasoning", "input", "compat"]) {
      expect(Object.hasOwn(entry as object, key)).toBe(false);
    }
  });

  it("produces deep-equal entries whether or not a discovered row is present", () => {
    const cfg = {
      models: {
        providers: {
          acme: {
            api: "openai-completions",
            models: [{ id: "model-a", name: "Model A" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    // Discovery absent: the entry comes straight from config.
    const [configuredOnly] = buildConfiguredModelCatalog({ cfg });
    expect(configuredOnly).toBeDefined();

    // Discovery present: the same config is overlaid onto a discovered row that
    // carries no extra facts of its own.
    const discovered = modelCatalogRowToEntry({
      id: "model-a",
      name: "Model A",
      provider: "acme",
      api: "openai-completions",
      reasoning: undefined as unknown as boolean,
    });
    const [configured] = buildConfiguredModelCatalog({ cfg });
    const overlaid = overlayCatalogMetadata(discovered, configured as ModelCatalogEntry, {
      preserveBaseCompat: true,
    });

    expect(isDeepStrictEqual(overlaid, configuredOnly)).toBe(true);
  });
});
