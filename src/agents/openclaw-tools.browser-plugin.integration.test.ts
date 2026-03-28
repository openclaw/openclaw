import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { clearPluginLoaderCache } from "../plugins/loader.js";
import { clearPluginManifestRegistryCache } from "../plugins/manifest-registry.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { createOpenClawTools } from "./openclaw-tools.js";

function resetPluginState() {
  clearPluginLoaderCache();
  clearPluginManifestRegistryCache();
  resetPluginRuntimeStateForTest();
}

describe("createOpenClawTools browser plugin integration", () => {
  beforeEach(() => {
    resetPluginState();
  });

  afterEach(() => {
    resetPluginState();
  });

  it("loads the bundled browser plugin through normal plugin resolution", () => {
    const tools = createOpenClawTools({
      config: {
        plugins: {
          allow: ["browser"],
        },
      } as OpenClawConfig,
    });

    expect(tools.map((tool) => tool.name)).toContain("browser");
  });

  it("omits the browser tool when the bundled browser plugin is disabled", () => {
    const tools = createOpenClawTools({
      config: {
        plugins: {
          allow: ["browser"],
          entries: {
            browser: {
              enabled: false,
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(tools.map((tool) => tool.name)).not.toContain("browser");
  });
});
