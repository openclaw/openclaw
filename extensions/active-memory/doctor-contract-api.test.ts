import { expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

it("removes the retired QMD override while preserving Active Memory siblings", () => {
  expect(legacyConfigRules).toEqual([
    expect.objectContaining({
      path: ["plugins", "entries", "active-memory", "config", "qmd"],
      message: expect.stringContaining("doctor --fix"),
    }),
  ]);
  const cfg = {
    plugins: {
      entries: {
        "active-memory": {
          config: { enabled: true, qmd: { searchMode: "search" } },
        },
      },
    },
  };

  const result = normalizeCompatibilityConfig({ cfg });

  expect(result.config).toHaveProperty("plugins.entries.active-memory.config.enabled", true);
  expect(result.config).not.toHaveProperty("plugins.entries.active-memory.config.qmd");
  expect(result.changes).toEqual(["Removed retired Active Memory QMD search-mode configuration."]);
});
