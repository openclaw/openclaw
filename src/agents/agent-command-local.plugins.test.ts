import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerPreActionHooks } from "../cli/program/preaction.js";
import { withCliPluginInvocation } from "../cli/run-main-plugin-cache.js";
import { withCliProcessScope } from "../cli/runtime-cleanup-scope.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createHookRunner } from "../plugins/hooks.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { clearActivePluginRegistry, getActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-scope.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { runLocalAgentCommand } from "./agent-command-local.js";
import type { AgentCommandOpts } from "./command/types.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";

// Exercise real CLI activation, registration, prepared runtime, and lifetime ownership.
// Session/config preparation and CLI presentation have independent boundary tests.
const mocks = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("./command/prepare.js", () => ({ prepareAgentCommandExecution: mocks.prepare }));
vi.mock("./command/runtime-loaders.js", () => ({ resolveAgentCommandDeps: async () => ({}) }));
vi.mock("../cli/program/config-guard.js", () => ({ ensureConfigReady: async () => {} }));
vi.mock("../cli/banner.js", () => ({ emitCliBanner: () => {} }));
vi.mock("../cli/state-dir-gateway-check.js", () => ({
  checkCliGatewayStateDir: async () => ({ kind: "allow" }),
}));
let state: OpenClawTestState;
let argv: string[];
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "local-plugin-custody" });
  argv = process.argv;
  useNoBundledPlugins();
});
afterEach(async () => {
  process.argv = argv;
  await resetPreparedModelRuntimeSnapshotsForTest();
  resetPluginLoaderTestStateForTest();
  vi.unstubAllEnvs();
  await state.cleanup();
});
afterAll(cleanupPluginLoaderFixturesForTest);

it.each([false, true])("owns only the admitted local registry (CLI preaction=%s)", async (cli) => {
  const event = "local-custody:" + state.root;
  const effectFile = state.path("local-effects.txt");
  fs.writeFileSync(effectFile, "");
  const effects = () => fs.readFileSync(effectFile, "utf8");
  const captures: Array<{ mode: string; directory: string }> = [];
  const onRegistration = (mode: string, directory: string) => captures.push({ mode, directory });
  const plugin = writePlugin({
    id: "local-owner",
    registration: [
      "process.emit(" + JSON.stringify(event) + ", api.registrationMode, __dirname);",
      'api.registerTool(() => ({ name: "local_probe", description: api.registrationMode, parameters: { type: "object", properties: {} }, execute: async (callId) => { require("node:fs").appendFileSync(' +
        JSON.stringify(effectFile) +
        ', callId + "\\n"); return { content: [{ type: "text", text: "written" }] }; } }), { name: "local_probe" });',
      'api.on("before_prompt_build", async () => ({ prependContext: "local hook" }));',
      'api.registerChannel({ plugin: { id: "local-channel", meta: { id: "local-channel", label: "Local", aliases: ["local-alias"] }, capabilities: { chatTypes: ["direct"] }, config: { listAccountIds: () => ["selected"], resolveAccount: () => ({ accountId: "selected" }) } } });',
      'if (api.registrationMode === "full") api.registerTool(() => ({ name: "full_probe", description: "full only", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) }), { name: "full_probe" });',
    ].join("\n"),
  });
  const manifestPath = path.join(plugin.dir, "openclaw.plugin.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      ...JSON.parse(fs.readFileSync(manifestPath, "utf8")),
      channels: ["local-channel"],
      contracts: { tools: ["local_probe", "full_probe"] },
    }),
  );
  const config: OpenClawConfig = {
    agents: { defaults: { workspace: state.workspaceDir, model: "custom/model" } },
    plugins: {
      allow: [plugin.id],
      load: { paths: [plugin.file] },
      slots: { memory: "none" },
      entries: { [plugin.id]: { enabled: true, hooks: { allowConversationAccess: true } } },
    },
  };
  setRuntimeConfigSnapshot(config, config);
  mocks.prepare.mockImplementation(async (opts: AgentCommandOpts) => {
    if (cli) {
      // Preaction still makes external recipient aliases/account adapters available before preparation.
      expect(normalizeMessageChannel("local-alias")).toBe("local-channel");
      expect(
        getActivePluginRegistry()
          ?.tools.find(({ names }) => names.includes("full_probe"))
          ?.factory({}),
      ).toMatchObject({ description: "full only" });
    }
    return {
      cfg: config,
      opts,
      runId: opts.runId,
      sessionAgentId: "main",
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
    };
  });
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  let late: (() => unknown) | undefined;
  let root: ReturnType<typeof getActivePluginRegistry> = null;
  const command = () =>
    runLocalAgentCommand({
      opts: { message: "probe", agentId: "main", runId: "outer" },
      runtime,
      run: async () => {
        const registry = getPluginRuntimeGenerationRegistry()!;
        const probe = () => {
          const tool = registry.tools
            .find(({ names }) => names.includes("local_probe"))!
            .factory({});
          if (!tool || Array.isArray(tool)) {
            throw new Error("Expected the local fixture tool");
          }
          return tool;
        };
        await probe().execute("parent-before", {});
        expect(effects()).toBe("parent-before\n");
        if (cli) {
          expect(normalizeMessageChannel("local-alias")).toBe("local-channel");
        }
        expect(
          await createHookRunner(registry, { catchErrors: false }).runBeforePromptBuild(
            { prompt: "probe", messages: [] },
            {},
          ),
        ).toEqual({ prependContext: "local hook" });
        expect.soft(captures).toHaveLength(cli ? 2 : 1);
        const inner = await runLocalAgentCommand({
          opts: { message: "nested", agentId: "main", runId: "inner" },
          runtime,
          run: async () => {
            const innerRegistry = getPluginRuntimeGenerationRegistry()!;
            const tool = innerRegistry.tools
              .find(({ names }) => names.includes("local_probe"))!
              .factory({});
            if (!tool || Array.isArray(tool)) {
              throw new Error("Expected the nested fixture tool");
            }
            const execute = tool.execute;
            // This executable callback carries the nested async invocation, not a new factory lookup.
            late = AsyncLocalStorage.bind(() => execute("nested", {}));
            return late();
          },
        });
        expect(inner).toMatchObject({ content: [{ type: "text", text: "written" }] });
        expect(effects()).toBe("parent-before\nnested\n");
        // The outer lease still owns physical resources; only the nested invocation has ended.
        await expect(async () => await late?.()).rejects.toThrow(
          "Plugin invocation scope is closed",
        );
        expect(effects()).toBe("parent-before\nnested\n");
        await probe().execute("parent-after", {});
        expect(effects()).toBe("parent-before\nnested\nparent-after\n");
        return "done";
      },
    });
  process.on(event, onRegistration);
  try {
    await withCliProcessScope(() =>
      withCliPluginInvocation(false, async (cleanup) => {
        try {
          if (cli) {
            const program = new Command().name("openclaw");
            program
              .command("agent")
              .option("--local")
              .option("--json")
              .action(async () => {
                root = getActivePluginRegistry();
                expect(await command()).toBe("done");
              });
            registerPreActionHooks(program, "test");
            process.argv = ["node", "openclaw", "agent", "--local", "--json"];
            await program.parseAsync(process.argv);
            expect(
              getActivePluginRegistry()
                ?.tools.find(({ names }) => names.includes("full_probe"))
                ?.factory({}),
            ).toMatchObject({ description: "full only" });
          } else {
            expect(await command()).toBe("done");
          }
          await expect(async () => await late?.()).rejects.toThrow();
          expect(effects()).toBe("parent-before\nnested\nparent-after\n");
        } finally {
          await cleanup?.pluginResources?.release();
        }
      }),
    );
    expect(
      captures
        .filter(({ mode }) => mode === "discovery")
        .every(({ directory }) => !fs.existsSync(directory)),
    ).toBe(true);
    // Preaction published a process root. Cache retirement deliberately leaves active
    // records with that owner; close only this fixture root before checking its files.
    if (root) {
      await clearActivePluginRegistry(root);
      root = null;
    }
    expect(captures.every(({ directory }) => !fs.existsSync(directory))).toBe(true);
  } finally {
    if (root) {
      await clearActivePluginRegistry(root);
    }
    process.off(event, onRegistration);
  }
});
