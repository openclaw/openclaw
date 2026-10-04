// Real-behavior proof for the CLI-side before_model_resolve emission at turn
// depth: a plugin file on disk is loaded through the production loader, its CLI
// backend registration and model-routing hook are live, and one full turn through
// the exported runCliAgent entry spawns a real child process whose argv carries
// the hook-routed model id. Nothing on the spawn path is mocked; the stub CLI is
// a real executable that records the exact argv it was spawned with.
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
import {
  createTestAdmittedRunContext,
  withTestRunAdmission,
} from "../admitted-run-context.test-support.js";
import { runCliAgent } from "../cli-runner.js";

// The bundled claude-cli backend would need real credentials; a plugin-owned
// stub backend exercises the identical runner path with a real local child.
const STUB_MODEL_BASE = "stub-base-model";
const STUB_MODEL_ROUTED = "stub-routed-model";

const CLI_CONFIG: OpenClawConfig = {
  agents: {
    defaults: {
      model: `stub/${STUB_MODEL_BASE}`,
      models: {
        [`stub/${STUB_MODEL_BASE}`]: { agentRuntime: { id: "stub-cli" } },
        [`stub/${STUB_MODEL_ROUTED}`]: { agentRuntime: { id: "stub-cli" } },
      },
    },
  },
};

function writeStubCliScript(params: { logFile: string }): string {
  // Spawned through the Node executable by the backend config, so the file
  // needs no shebang or exec bit and stays portable across platforms.
  const file = path.join(makePluginLoaderTempDir(), "stub-cli.mjs");
  fs.writeFileSync(
    file,
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(params.logFile)}, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
process.stdout.write("stub reply after routing");
`,
    "utf-8",
  );
  return file;
}

function writeBackendAndRouterPlugin(params: { script: string; logFile: string }) {
  return writePlugin({
    id: "stub-cli-backend",
    registration: [
      `api.registerCliBackend({`,
      `  id: "stub-cli",`,
      `  modelProvider: "stub",`,
      `  config: { command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(params.script)}, "exec"], output: "text", input: "arg", modelArg: "--model", sessionMode: "none", systemPromptWhen: "never" },`,
      `});`,
      `api.on("before_model_resolve", (event) => {`,
      `  require("node:fs").appendFileSync(${JSON.stringify(params.logFile)}, JSON.stringify({ hook: "before_model_resolve", prompt: event.prompt }) + "\\n");`,
      `  return { providerOverride: "stub", modelOverride: ${JSON.stringify(STUB_MODEL_ROUTED)} };`,
      `});`,
    ].join("\n"),
  });
}

afterEach(() => {
  resetGlobalHookRunner();
});

afterAll(cleanupPluginLoaderFixturesForTest);

describe("runCliAgent with a real loaded plugin and a real spawned CLI child", () => {
  it("routes the turn's model through before_model_resolve into the child argv", async () => {
    const workspaceDir = makePluginLoaderTempDir();
    const logFile = path.join(workspaceDir, "stub-cli-argv.jsonl");
    const stubCli = writeStubCliScript({ logFile });
    const plugin = writeBackendAndRouterPlugin({ script: stubCli, logFile });
    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["stub-cli-backend"],
          entries: {
            "stub-cli-backend": { hooks: { allowConversationAccess: true } },
          },
        },
      },
    });
    expect(registry.plugins.find((entry) => entry.id === "stub-cli-backend")?.status).toBe(
      "loaded",
    );
    initializeGlobalHookRunner(registry);

    const result = await withTestRunAdmission(
      {
        admittedRunContext: createTestAdmittedRunContext("full-turn-proof-run"),
        runId: "full-turn-proof-run",
        agentId: "main",
        config: CLI_CONFIG,
      },
      (admittedRunContext) =>
        runCliAgent({
          prompt: "route this turn through the stub",
          provider: "stub-cli",
          modelProvider: "stub",
          model: STUB_MODEL_BASE,
          sessionFile: path.join(workspaceDir, "session.jsonl"),
          sessionId: "full-turn-proof",
          sessionKey: "agent:main:main",
          workspaceDir,
          trigger: "manual",
          runId: "full-turn-proof-run",
          admittedRunContext,
          config: CLI_CONFIG,
          timeoutMs: 60_000,
        }),
    );

    // The run completed through the real child and surfaced its reply.
    expect(result.meta.finalAssistantVisibleText).toBe("stub reply after routing");
    // The spawned child received the hook-routed model, not the caller's base model.
    const logLines = fs
      .readFileSync(logFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv?: string[]; hook?: string });
    const hookFires = logLines.filter((line) => line.hook === "before_model_resolve");
    expect(hookFires.length).toBeGreaterThanOrEqual(1);
    const spawns = logLines.filter((line) => Array.isArray(line.argv));
    expect(spawns.length).toBeGreaterThanOrEqual(1);
    const lastSpawnArgv = spawns.at(-1)?.argv ?? [];
    expect(lastSpawnArgv).toContain("exec");
    const modelIndex = lastSpawnArgv.indexOf("--model");
    expect(modelIndex).toBeGreaterThan(-1);
    expect(lastSpawnArgv[modelIndex + 1]).toBe(STUB_MODEL_ROUTED);
    expect(lastSpawnArgv).not.toContain(STUB_MODEL_BASE);
  });
});
