import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { clearActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-scope.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { runLocalAgentCommand } from "./agent-command-local.js";
import {
  bindActiveOperatorTurnAuthority,
  type CronCreatorAuthorityCapability,
} from "./cron-creator-authority-context.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  resolveDeps: vi.fn(async () => ({})),
}));

vi.mock("./command/prepare.js", () => ({
  prepareAgentCommandExecution: mocks.prepare,
  isAgentCommandExplicitRecipientCandidate: () => false,
}));

vi.mock("./command/runtime-loaders.js", () => ({
  resolveAgentCommandDeps: mocks.resolveDeps,
}));

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "local-command-authority" });
});
afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  await clearActivePluginRegistry();
  resetPluginLoaderTestStateForTest();
  await state.cleanup();
});
afterAll(cleanupPluginLoaderFixturesForTest);

function createPrepared(senderIsOwner: boolean) {
  return {
    cfg: {},
    opts: { runId: "run-local", senderIsOwner },
    runId: "run-local",
    sessionAgentId: "main",
    agentDir: state.agentDir(),
    workspaceDir: state.workspaceDir,
  };
}

describe("runLocalAgentCommand operator authority", () => {
  it("binds local authority to the exact admitted operator run and revokes it at settlement", async () => {
    mocks.prepare.mockResolvedValueOnce(createPrepared(true));
    let retained: ReturnType<typeof bindActiveOperatorTurnAuthority>;
    let capability: CronCreatorAuthorityCapability | undefined;

    await runLocalAgentCommand({
      opts: { message: "test", runId: "run-local" },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      operatorAuthority: true,
      run: async (prepared) => {
        capability = prepared.opts.cronCreatorAuthorityCapability;
        retained = bindActiveOperatorTurnAuthority(prepared.runId);
        expect(capability?.callerOrigin).toEqual({ kind: "local" });
        expect(retained?.source).toBe("local");
      },
    });

    expect(() => retained?.assertActive()).toThrow();
    expect(capability?.active).toBe(false);
  });

  it("does not mint local authority for a non-owner or system run", async () => {
    for (const testCase of [
      { operatorAuthority: true, senderIsOwner: false },
      { operatorAuthority: false, senderIsOwner: true },
    ]) {
      mocks.prepare.mockResolvedValueOnce(createPrepared(testCase.senderIsOwner));
      await runLocalAgentCommand({
        opts: { message: "test", runId: "run-local" },
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        operatorAuthority: testCase.operatorAuthority,
        run: async (prepared) => {
          expect(prepared.opts.cronCreatorAuthorityCapability).toBeUndefined();
          expect(bindActiveOperatorTurnAuthority(prepared.runId)).toBeUndefined();
        },
      });
    }
  });
});

it("keeps full local memory registrations through command preparation", async () => {
  useNoBundledPlugins();
  const pluginId = "memory-fixture";
  const plugin = writePlugin({
    id: pluginId,
    registration: [
      'if (api.registrationMode !== "full") return;',
      "api.registerMemoryCorpusSupplement({ search: async () => [], get: async () => null });",
      'api.registerMemoryPromptPreparation(async () => ["prepared memory"]);',
      'api.registerMemoryPromptSupplement(() => ["memory guidance"]);',
    ].join("\n"),
  });
  const cfg = {
    plugins: {
      load: { paths: [plugin.file] },
      entries: { [pluginId]: { enabled: true } },
    },
  };
  mocks.prepare.mockResolvedValueOnce({
    ...createPrepared(false),
    cfg,
  });
  let late: (() => Promise<readonly string[]>) | undefined;
  await runLocalAgentCommand({
    opts: { message: "test", runId: "local-memory" },
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    run: async () => {
      const captured = getPluginRuntimeGenerationRegistry();
      expect(captured?.memoryCorpusSupplements.map(({ pluginId: id }) => id)).toContain(pluginId);
      expect(
        await captured?.memoryCorpusSupplements[0]?.supplement.search({ query: "test" }),
      ).toEqual([]);
      expect(
        await captured?.memoryPromptPreparations[0]?.prepare({ availableTools: new Set() }),
      ).toEqual(["prepared memory"]);
      expect(captured?.memoryPromptSupplements[0]?.builder({ availableTools: new Set() })).toEqual([
        "memory guidance",
      ]);
      late = () => captured!.memoryPromptPreparations[0]!.prepare({ availableTools: new Set() });
    },
  });
  await expect(async () => await late?.()).rejects.toThrow();
});
