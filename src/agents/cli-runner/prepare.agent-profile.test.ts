import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setActiveNodeContexts } from "../../infra/active-node-context.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { clearMemoryPluginState } from "../../plugins/memory-state.test-fixtures.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { resolveApiKeyForProfile as resolveApiKeyForProfileImpl } from "../auth-profiles/oauth.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
  createTestMcpLoopbackClientGrant,
  createTestMcpLoopbackServer,
  createTestMcpLoopbackServerConfig,
} from "../cli-runner.test-helpers.js";
import { resetContextWindowCacheForTest } from "../context.test-support.js";
import { buildMediaTaskRuntimeContext } from "../media-generation-task-status.js";
import type { SandboxWorkspaceInfo } from "../sandbox/types.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";

const getRuntimeConfigMock = vi.hoisted(() => vi.fn(() => ({})));
const ensureSandboxWorkspaceForSessionMock = vi.hoisted(() =>
  vi.fn<() => Promise<SandboxWorkspaceInfo | null>>(async () => null),
);
// mock-isolation: Preparation reads a controllable runtime config and the gateway port only.
vi.mock("../../config/config.js", async () => ({
  getRuntimeConfig: getRuntimeConfigMock,
  resolveGatewayPort: (await import("../../config/paths.js")).resolveGatewayPort,
}));

vi.mock("../sandbox/context.js", async () => ({
  ...(await vi.importActual<typeof import("../sandbox/context.js")>("../sandbox/context.js")),
  ensureSandboxWorkspaceForSession: ensureSandboxWorkspaceForSessionMock,
}));

// mock-isolation: These cases run without plugin hooks; the real runner holds global plugin state.
vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("../../tts/tts-settings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../tts/tts-settings.js")>()),
  buildTtsSystemPromptHintAsync: vi.fn(async () => undefined),
}));

// mock-isolation: Media task status reads session task state these cases do not exercise.
vi.mock("../media-generation-task-status.js", () => ({
  buildMediaTaskRuntimeContext: vi.fn(() => undefined),
  VIDEO_GENERATION_TASK_KIND: "video_generation",
  buildVideoGenerationTaskStatusDetails: vi.fn(() => ({})),
  buildVideoGenerationTaskStatusText: vi.fn(() => ""),
  findActiveVideoGenerationTaskForSession: vi.fn(() => undefined),
  IMAGE_GENERATION_TASK_KIND: "image_generation",
  buildImageGenerationTaskStatusDetails: vi.fn(() => ({})),
  buildImageGenerationTaskStatusText: vi.fn(() => ""),
  MUSIC_GENERATION_TASK_KIND: "music_generation",
  buildMusicGenerationTaskStatusDetails: vi.fn(() => ({})),
  buildMusicGenerationTaskStatusText: vi.fn(() => ""),
  findActiveMusicGenerationTaskForSession: vi.fn(() => undefined),
}));

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);
const mockBuildMediaTaskRuntimeContext = vi.mocked(buildMediaTaskRuntimeContext);

let defaultTestCliBackend = buildDefaultTestCliBackend();

describe("prepareCliRunContext agent profiles", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-cli-prepare-");
  const retainedStateDirs: string[] = [];
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;

  beforeEach(() => {
    // Install narrow test doubles for external runtime seams so preparation
    // remains about data flow, not bundled plugin or loopback startup cost.
    defaultTestCliBackend = buildDefaultTestCliBackend();
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [defaultTestCliBackend],
    });
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: vi.fn(async () => false),
      makeBootstrapWarn: vi.fn(() => () => undefined),
      resolveBootstrapContextForRun: vi.fn(async () => ({
        bootstrapFiles: [],
        contextFiles: [],
      })),
      getActiveMcpLoopbackRuntime: vi.fn(() => undefined),
      ensureMcpLoopbackServer: vi.fn(createTestMcpLoopbackServer),
      createMcpLoopbackServerConfig: vi.fn(createTestMcpLoopbackServerConfig),
      mintMcpLoopbackClientGrant: vi.fn(createTestMcpLoopbackClientGrant),
      bindMcpLoopbackClientGrantAdmission: vi.fn(() => true),
      revokeMcpLoopbackClientGrant: vi.fn(() => true),
      revokeMintedMcpLoopbackClientGrant: vi.fn(() => true),
      resolveMcpLoopbackPolicyTools: vi.fn(() => ({ agentId: "main", tools: [] })),
      resolveMcpLoopbackScopedTools: vi.fn(() => ({ agentId: "main", tools: [] })),
      resolveOpenClawReferencePaths: vi.fn(async () => ({ docsPath: null, sourcePath: null })),
      prepareClaudeCliSkillsPlugin: vi.fn(async () => ({
        args: [],
        cleanup: vi.fn(async () => undefined),
      })),
      getCliLiveSessionGeneration: vi.fn(() => undefined),
      resolveApiKeyForProfile: resolveApiKeyForProfileImpl,
      // Keep preparation off the real plugin-metadata snapshot; catalog-driven
      // cases inject their own rows.
      loadManifestModelCatalog: vi.fn(() => []),
    });
    mockGetGlobalHookRunner.mockReturnValue(null);
    const config: OpenClawConfig = {};
    getRuntimeConfigMock.mockReturnValue(config);
    setRuntimeConfigSnapshot(config);
    mockBuildMediaTaskRuntimeContext.mockResolvedValue(undefined);
    ensureSandboxWorkspaceForSessionMock.mockReset();
    ensureSandboxWorkspaceForSessionMock.mockResolvedValue(null);
    // Discovery cases explicitly opt out of the prepared empty catalog.
    fixture = createCliRunnerPrepareFixture(
      (params) => {
        setRuntimeConfigSnapshot(params.config ?? {});
        return prepareCliRunContext({ skillsSnapshot: { prompt: "", skills: [] }, ...params });
      },
      {
        make() {
          const dir = sessionDirs.make();
          retainedStateDirs.push(dir);
          return dir;
        },
      },
    );
  });

  afterEach(async () => {
    await fixture.settle();
    setActiveNodeContexts([]);
    cliBackendsTesting.resetDepsForTest();
    resetCliRunnerPrepareTestDeps();
    getRuntimeConfigMock.mockReset();
    mockGetGlobalHookRunner.mockReset();
    mockBuildMediaTaskRuntimeContext.mockReset();
    ensureSandboxWorkspaceForSessionMock.mockReset();
    resetContextWindowCacheForTest();
    clearMemoryPluginState();
    setActivePluginRegistry(createTestRegistry());
    setActiveDegradedSecretOwners([]);
    vi.unstubAllEnvs();
    await fixture.cleanup();
    // A few retained cases keep both broker workers warm below their store capacity.
    for (const dir of retainedStateDirs.splice(0, retainedStateDirs.length - 4)) {
      await closeOpenClawStateDatabaseByPathAsync(
        resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: dir }),
      );
    }
    clearRuntimeConfigSnapshot();
  });

  it("applies the selected profile workspace budget to CLI system prompts", async () => {
    const { dir } = fixture.session;
    const agentsPath = path.join(dir, "AGENTS.md");
    const soulPath = path.join(dir, "SOUL.md");
    const identityPath = path.join(dir, "IDENTITY.md");
    setCliRunnerPrepareTestDeps({
      resolveBootstrapContextForRun: vi.fn(async () => ({
        bootstrapFiles: [
          {
            name: "AGENTS.md" as const,
            path: agentsPath,
            content: "agent policy ".repeat(700),
            missing: false,
          },
          {
            name: "SOUL.md" as const,
            path: soulPath,
            content: "soul guidance ".repeat(400),
            missing: false,
          },
          {
            name: "IDENTITY.md" as const,
            path: identityPath,
            content: "Name: Bob",
            missing: false,
          },
        ],
        contextFiles: [],
      })),
    });

    const context = await fixture.prepare({
      sessionKey: "agent:main:test",
      agentId: "main",
      trigger: "user",
      prompt: "Who are you?",
      config: { agents: { defaults: { agentProfileId: "openclaw/small" } } },
    });

    expect(context.systemPrompt).toContain("Name: Bob");
    expect(context.systemPromptReport.agentProfile).toEqual({
      id: "openclaw/small",
      selectionSource: "defaults-explicit",
    });
    expect(context.systemPromptReport.workspaceContext).toMatchObject({
      totalMaxChars: 11_500,
    });
    expect(context.systemPromptReport.workspaceContext?.injectedChars).toBeLessThanOrEqual(11_500);
    expect(
      context.systemPromptReport.workspaceContext?.entries.map((entry) => entry.section),
    ).toEqual(["agents", "soul", "identity"]);
  });

  it.each([
    {
      name: "the small profile",
      config: { agents: { defaults: { agentProfileId: "openclaw/small" } } },
      expected: { id: "openclaw/small", selectionSource: "defaults-explicit" },
    },
    {
      name: "no configured profile",
      config: {},
      expected: { id: "openclaw/base", selectionSource: "fallback" },
    },
  ] satisfies Array<{
    name: string;
    config: OpenClawConfig;
    expected: { id: string; selectionSource: string };
  }>)(
    "selects the CLI profile from the configuration and not the backend id: $name",
    async ({ config, expected }) => {
      setCliRunnerPrepareTestDeps({
        resolveBootstrapContextForRun: vi.fn(async () => ({
          bootstrapFiles: [
            {
              name: "AGENTS.md" as const,
              path: path.join(fixture.session.dir, "AGENTS.md"),
              content: "agent policy ".repeat(700),
              missing: false,
            },
          ],
          contextFiles: [],
        })),
      });

      const context = await fixture.prepare({
        provider: "test-cli",
        modelProvider: "llama-cpp",
        model: "local-8b",
        sessionKey: "agent:main:test",
        agentId: "main",
        trigger: "user",
        prompt: "Who are you?",
        config,
      });

      expect(context.systemPromptReport.agentProfile).toEqual(expected);
      expect(context.systemPromptReport.workspaceContext?.totalMaxChars).toBe(
        expected.id === "openclaw/small" ? 11_500 : undefined,
      );
    },
  );

  it("never widens a smaller operator budget in the CLI profile", async () => {
    setCliRunnerPrepareTestDeps({
      resolveBootstrapContextForRun: vi.fn(async () => ({
        bootstrapFiles: [
          {
            name: "AGENTS.md" as const,
            path: path.join(fixture.session.dir, "AGENTS.md"),
            content: "agent policy ".repeat(700),
            missing: false,
          },
        ],
        contextFiles: [],
      })),
    });

    const context = await fixture.prepare({
      provider: "test-cli",
      modelProvider: "llama-cpp",
      model: "local-8b",
      sessionKey: "agent:main:test",
      agentId: "main",
      trigger: "user",
      prompt: "Who are you?",
      config: {
        agents: { defaults: { agentProfileId: "openclaw/small", bootstrapTotalMaxChars: 2_000 } },
      },
    });

    expect(context.systemPromptReport.workspaceContext?.totalMaxChars).toBe(2_000);
  });
});
