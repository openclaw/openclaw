// Real-behavior proof for the CLI-side before_model_resolve emission: a plugin
// file on disk is loaded through the production loader, activated through the
// production global hook runner, and a CLI-backed turn through the exported run
// seam fires the hook and folds the same-backend override into the run's model.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  writePlugin,
} from "../../plugins/loader.test-fixtures.js";
import { applyCliModelResolveHookForRun } from "./model-resolve-hook.js";

// The bundled plugin set registers the claude-cli backend binding the override
// must resolve against; keep it enabled so the runtime resolution is the
// production one.
function writeTracingPlugin(file: string) {
  return writePlugin({
    id: "model-router",
    registration: [
      `const traceFile = ${JSON.stringify(file)};`,
      'api.on("before_model_resolve", (event, ctx) => {',
      '  require("node:fs").appendFileSync(traceFile, JSON.stringify({ prompt: event.prompt, modelProviderId: ctx.modelProviderId, modelId: ctx.modelId, sessionId: ctx.sessionId, trigger: ctx.trigger, channelId: ctx.channelId ?? null }) + "\\n");',
      '  return { providerOverride: "anthropic", modelOverride: "claude-sonnet-5" };',
      "});",
    ].join("\n"),
  });
}

const CLI_CONFIG: OpenClawConfig = {
  agents: {
    defaults: {
      model: "anthropic/claude-opus-5-5",
      models: {
        "anthropic/claude-opus-5-5": { agentRuntime: { id: "claude-cli" } },
        "anthropic/claude-sonnet-5": { agentRuntime: { id: "claude-cli" } },
      },
    },
  },
};

afterEach(() => {
  resetGlobalHookRunner();
});

// The trace file and plugin root live under the fixture root; drop the whole
// tree once this suite is done instead of leaking a temp dir per run.
afterAll(cleanupPluginLoaderFixturesForTest);

describe("applyCliModelResolveHookForRun with a real loaded plugin", () => {
  it("fires before_model_resolve on a CLI-backed turn and applies the same-backend override", async () => {
    const trace = path.join(makePluginLoaderTempDir(), "hook-trace.jsonl");
    const plugin = writeTracingPlugin(trace);
    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["model-router"],
          entries: {
            "model-router": { hooks: { allowConversationAccess: true } },
          },
        },
      },
    });
    expect(registry.plugins.find((entry) => entry.id === "model-router")?.status).toBe("loaded");
    expect(registry.typedHooks.map((entry) => entry.hookName)).toEqual(["before_model_resolve"]);
    initializeGlobalHookRunner(registry);

    const params = {
      prompt: "route this turn",
      provider: "claude-cli",
      modelProvider: "anthropic",
      model: "claude-opus-5-5",
      sessionFile: "/tmp/workspace/session.jsonl",
      sessionId: "session-1",
      workspaceDir: "/tmp/workspace",
      trigger: "agent-turn",
      currentChannelId: "chan-1",
      config: CLI_CONFIG,
    };
    await applyCliModelResolveHookForRun(
      params as Parameters<typeof applyCliModelResolveHookForRun>[0],
    );

    expect(params.model).toBe("claude-sonnet-5");
    const lines = fs.readFileSync(trace, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      prompt: "route this turn",
      modelProviderId: "anthropic",
      modelId: "claude-opus-5-5",
      sessionId: "session-1",
      trigger: "agent-turn",
      channelId: "chan-1",
    });
  });
});
