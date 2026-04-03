import type { ContextEngine } from "openclaw/plugin-sdk/context-engine";
import { describe, expect, it, vi } from "vitest";
import pluginEntry from "../index.js";
import OPENVIKING_MANIFEST_JSON from "../openclaw.plugin.json" with { type: "json" };
import { OpenVikingContextEngine } from "./openviking-context-engine.js";
import { openVikingPluginConfigSchema } from "./plugin-manifest.js";

describe("openviking plugin entry", () => {
  it("keeps runtime metadata aligned with the manifest", () => {
    expect(pluginEntry.id).toBe(OPENVIKING_MANIFEST_JSON.id);
    expect(pluginEntry.name).toBe(OPENVIKING_MANIFEST_JSON.name);
    expect(pluginEntry.description).toBe(OPENVIKING_MANIFEST_JSON.description);
    expect(pluginEntry.kind).toBe(OPENVIKING_MANIFEST_JSON.kind);
    expect(pluginEntry.configSchema).toEqual(openVikingPluginConfigSchema);
    expect(pluginEntry.configSchema.jsonSchema).toEqual(OPENVIKING_MANIFEST_JSON.configSchema);
    expect(pluginEntry.configSchema.uiHints).toEqual(OPENVIKING_MANIFEST_JSON.uiHints);
  });

  it("registers the OpenViking context-engine factory", () => {
    let capturedId: string | undefined;
    let capturedFactory: (() => unknown) | undefined;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    pluginEntry.register({
      pluginConfig: {
        baseUrl: "http://127.0.0.1:1933",
        writebackEnabled: true,
      },
      logger,
      registerContextEngine(id: string, factory: () => ContextEngine) {
        capturedId = id;
        capturedFactory = factory;
      },
    } as never);

    expect(capturedId).toBe("openviking");
    const engine = capturedFactory?.();
    expect(engine).toBeInstanceOf(OpenVikingContextEngine);
    expect(logger.info).toHaveBeenCalledWith("openviking: context engine registered");
  });
});
