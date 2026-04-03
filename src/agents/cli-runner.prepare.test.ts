import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBundleMcpTempHarness } from "../plugins/bundle-mcp.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { prepareCliRunContext } from "./cli-runner/prepare.js";

const tempHarness = createBundleMcpTempHarness();

beforeEach(() => {
  const registry = createEmptyPluginRegistry();
  registry.cliBackends = [
    {
      pluginId: "anthropic",
      source: "test",
      backend: {
        id: "claude-cli",
        bundleMcp: true,
        config: {
          command: "node",
          args: ["./fake-claude.mjs"],
          output: "jsonl",
        },
      },
    },
  ];
  setActivePluginRegistry(registry);
});

afterEach(async () => {
  setActivePluginRegistry(createEmptyPluginRegistry());
  await tempHarness.cleanup();
});

describe("prepareCliRunContext", () => {
  it("disables bundled MCP overlays when disableTools is true", async () => {
    const workspaceDir = await tempHarness.createTempDir("openclaw-cli-run-prepare-");

    const prepared = await prepareCliRunContext({
      sessionId: "session-1",
      sessionFile: `${workspaceDir}/session.jsonl`,
      workspaceDir,
      prompt: "hello",
      provider: "claude-cli",
      timeoutMs: 30_000,
      runId: "run-1",
      disableTools: true,
    });

    expect(prepared.preparedBackend.backend.args).toEqual(["./fake-claude.mjs"]);
    expect(prepared.preparedBackend.mcpConfigHash).toBeUndefined();
    await prepared.preparedBackend.cleanup?.();
  });
});
