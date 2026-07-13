// Verifies embedded extension construction carries prepared middleware context to the lazy loader.
import type { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildEmbeddedExtensionFactories } from "./extensions.js";

const loadAgentToolResultMiddlewaresForRuntime = vi.hoisted(() => vi.fn(async () => []));

vi.mock("../../plugins/agent-tool-result-middleware-loader.js", () => ({
  loadAgentToolResultMiddlewaresForRuntime,
}));

beforeEach(() => {
  loadAgentToolResultMiddlewaresForRuntime.mockClear();
});

describe("embedded prepared middleware metadata", () => {
  it("passes the attempt config, workspace, and manifest registry to the loader", async () => {
    const config = { plugins: { entries: {} } } as OpenClawConfig;
    const manifestRegistry = { plugins: [], diagnostics: [] };
    const factories = buildEmbeddedExtensionFactories({
      cfg: config,
      sessionManager: {} as SessionManager,
      workspaceDir: "/prepared-workspace",
      pluginMetadataSnapshot: { manifestRegistry },
      provider: "openai",
      modelId: "gpt-5.4",
      model: undefined,
    });
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();

    await factories[0]?.({
      on(event: string, handler: (...args: unknown[]) => Promise<unknown>) {
        handlers.set(event, handler);
      },
    } as never);
    await handlers.get("tool_result")?.(
      { toolName: "exec", content: [{ type: "text", text: "raw" }], details: {} },
      { cwd: "/prepared-workspace" },
    );

    expect(loadAgentToolResultMiddlewaresForRuntime).toHaveBeenCalledWith({
      runtime: "openclaw",
      config,
      workspaceDir: "/prepared-workspace",
      manifestRegistry,
    });
  });
});
