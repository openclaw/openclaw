import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveOpenClawPluginToolsForOptions } from "./openclaw-plugin-tools.js";

const hoisted = vi.hoisted(() => ({
  resolvePluginTools: vi.fn(),
}));

vi.mock("../plugins/tools.js", () => ({
  resolvePluginTools: (...args: unknown[]) => hoisted.resolvePluginTools(...args),
}));

describe("createOpenClawTools browser plugin integration", () => {
  afterEach(() => {
    hoisted.resolvePluginTools.mockReset();
  });

  it("keeps the browser tool returned by plugin resolution", () => {
    hoisted.resolvePluginTools.mockReturnValue([
      {
        name: "browser",
        description: "browser fixture tool",
        parameters: {
          type: "object",
          properties: {},
        },
        async execute() {
          return {
            content: [{ type: "text", text: "ok" }],
          };
        },
      },
    ]);

    const config = {
      plugins: {
        allow: ["browser"],
      },
    } as OpenClawConfig;

    const tools = resolveOpenClawPluginToolsForOptions({
      options: { config },
      resolvedConfig: config,
    });

    expect(tools.map((tool) => tool.name)).toContain("browser");
  });

  it("omits the browser tool when plugin resolution returns no browser tool", () => {
    hoisted.resolvePluginTools.mockReturnValue([]);

    const config = {
      plugins: {
        allow: ["browser"],
        entries: {
          browser: {
            enabled: false,
          },
        },
      },
    } as OpenClawConfig;

    const tools = resolveOpenClawPluginToolsForOptions({
      options: { config },
      resolvedConfig: config,
    });

    expect(tools.map((tool) => tool.name)).not.toContain("browser");
  });

  it("forwards fsPolicy into plugin tool context", async () => {
    let capturedContext: { fsPolicy?: { workspaceOnly: boolean } } | undefined;
    hoisted.resolvePluginTools.mockImplementation((params: unknown) => {
      const resolvedParams = params as { context?: { fsPolicy?: { workspaceOnly: boolean } } };
      capturedContext = resolvedParams.context;
      return [
        {
          name: "browser",
          description: "browser fixture tool",
          parameters: {
            type: "object",
            properties: {},
          },
          async execute() {
            return {
              content: [{ type: "text", text: "ok" }],
              details: { workspaceOnly: capturedContext?.fsPolicy?.workspaceOnly ?? null },
            };
          },
        },
      ];
    });

    const tools = resolveOpenClawPluginToolsForOptions({
      options: {
        config: {
          plugins: {
            allow: ["browser"],
          },
        } as OpenClawConfig,
        fsPolicy: { workspaceOnly: true },
      },
      resolvedConfig: {
        plugins: {
          allow: ["browser"],
        },
      } as OpenClawConfig,
    });

    const browserTool = tools.find((tool) => tool.name === "browser");
    expect(browserTool).toBeDefined();
    if (!browserTool) {
      throw new Error("expected browser tool");
    }

    const result = await browserTool.execute("tool-call", {});
    const details = (result.details ?? {}) as { workspaceOnly?: boolean | null };
    expect(details.workspaceOnly).toBe(true);
  });
});
