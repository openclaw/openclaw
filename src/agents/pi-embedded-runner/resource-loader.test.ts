import { describe, expect, it, vi } from "vitest";
import {
  createEmbeddedPiResourceLoader,
  EMBEDDED_PI_RESOURCE_LOADER_DISCOVERY_OPTIONS,
} from "./resource-loader.js";

describe("createEmbeddedPiResourceLoader", () => {
  it("loads inline extensions without Pi filesystem discovery", async () => {
    const settingsManager = {};
    const handler = vi.fn();
    const extensionFactories = [
      vi.fn((pi) => {
        pi.on("tool_result", handler);
      }),
    ];

    const loader = createEmbeddedPiResourceLoader({
      cwd: "/workspace",
      agentDir: "/agent",
      settingsManager: settingsManager as never,
      extensionFactories: extensionFactories as never,
    });
    await loader.reload();

    expect(loader.getSkills()).toEqual({ skills: [], diagnostics: [] });
    expect(loader.getPrompts()).toEqual({ prompts: [], diagnostics: [] });
    expect(loader.getThemes()).toEqual({ themes: [], diagnostics: [] });
    expect(loader.getAgentsFiles()).toEqual({ agentsFiles: [] });
    expect(loader.getSystemPrompt()).toBeUndefined();
    expect(loader.getAppendSystemPrompt()).toEqual([]);
    expect(extensionFactories[0]).toHaveBeenCalledTimes(1);

    const extensions = loader.getExtensions();
    expect(extensions.errors).toEqual([]);
    expect(extensions.extensions).toHaveLength(1);
    expect(extensions.extensions[0]?.handlers.get("tool_result")).toEqual([handler]);
  });

  it("reports inline extension factory errors", async () => {
    const loader = createEmbeddedPiResourceLoader({
      cwd: "/workspace",
      agentDir: "/agent",
      settingsManager: {} as never,
      extensionFactories: [
        () => {
          throw new Error("factory exploded");
        },
      ],
    });

    await loader.reload();

    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getExtensions().errors).toEqual([
      {
        path: "<openclaw-inline:0>",
        error: "factory exploded",
      },
    ]);
  });

  it("keeps the embedded discovery contract explicit", () => {
    expect(EMBEDDED_PI_RESOURCE_LOADER_DISCOVERY_OPTIONS).toEqual({
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
  });
});
