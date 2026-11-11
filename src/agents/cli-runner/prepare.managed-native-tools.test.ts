import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveMcpLoopbackPolicyTools,
  resolveMcpLoopbackScopedTools,
} from "../../gateway/mcp-http.runtime.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import {
  createClaudeMcpCliBackend,
  testing as cliBackendsTesting,
} from "../cli-backends.test-support.js";
import {
  createPersistedCompletionHandoff,
  createCliRunnerPrepareFixture,
  createTestMcpLoopbackClientGrant,
} from "../cli-runner.test-helpers.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";

const { buildAnthropicCliBackend } = await loadBundledPluginFacade<{
  buildAnthropicCliBackend: () => CliBackendPlugin;
}>({ pluginId: "anthropic", artifactBasename: "api.js" });

let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;

beforeEach(() => {
  const nativeBackend = buildAnthropicCliBackend();
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [
      {
        ...createClaudeMcpCliBackend(),
        projectNativeToolAuthority: nativeBackend.projectNativeToolAuthority,
        resolveManagedNativeTools: nativeBackend.resolveManagedNativeTools,
      },
    ],
  });
  setCliRunnerPrepareTestDeps({
    isWorkspaceBootstrapPending: async () => false,
    makeBootstrapWarn: () => () => undefined,
    resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
    getActiveMcpLoopbackRuntime: () => ({
      port: 31783,
      ownerToken: "loopback-owner-token",
      nonOwnerToken: "loopback-non-owner-token",
    }),
    mintMcpLoopbackClientGrant: vi.fn(createTestMcpLoopbackClientGrant),
    bindMcpLoopbackClientGrantAdmission: () => true,
    revokeMcpLoopbackClientGrant: () => true,
    revokeMintedMcpLoopbackClientGrant: () => true,
    resolveMcpLoopbackPolicyTools,
    resolveMcpLoopbackScopedTools,
    resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
    prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
    getCliLiveSessionGeneration: () => undefined,
    loadManifestModelCatalog: () => [],
  });
  fixture = createCliRunnerPrepareFixture((params) => {
    setRuntimeConfigSnapshot(params.config ?? {});
    return prepareCliRunContext({ skillsSnapshot: { prompt: "", skills: [] }, ...params });
  });
});

afterEach(async () => {
  await fixture.settle();
  clearRuntimeConfigSnapshot();
  resetCliRunnerPrepareTestDeps();
  cliBackendsTesting.resetDepsForTest();
});

it.each<[string, OpenClawConfig["tools"], string[]]>([
  ["allowed", { allow: ["read", "web_search"] }, ["Agent", "WebSearch"]],
  ["outside the allowlist", { allow: ["read"] }, ["Agent"]],
  ["denied by group", { deny: ["group:web"] }, ["Agent"]],
  ["globally off", { web: { search: { enabled: false } } }, ["Agent"]],
  ["on a pinned provider", { web: { search: { provider: "brave" } } }, ["Agent"]],
])(
  "keeps managed native WebSearch only when %s, on both turn kinds",
  async (_name, tools, kept) => {
    const { sessionTarget } = fixture.session;
    const child = "agent:main:subagent:search";
    replaceSessionEntrySync(
      { storePath: sessionTarget.storePath, sessionKey: child },
      {
        sessionId: "search-child",
        updatedAt: 1,
        spawnedBy: sessionTarget.sessionKey,
        spawnDepth: 1,
        inheritedToolPolicyVersion: 1,
        inheritedToolAllow: ["read"],
      },
    );
    const natives = [];
    for (const completion of [false, true]) {
      const context = await fixture.prepare({
        sessionKey: sessionTarget.sessionKey,
        sessionId: sessionTarget.sessionId,
        provider: "claude-cli",
        model: "opus",
        ...(completion
          ? createPersistedCompletionHandoff(child, "search-child", sessionTarget)
          : {}),
        config: {
          session: { store: sessionTarget.storePath },
          tools,
          plugins: {
            entries: {
              anthropic: { config: { managedNativeTools: { default: ["Agent", "WebSearch"] } } },
            },
          },
        },
      });
      natives.push(context.params.cliToolAvailability?.native);
      await context.preparedBackend.cleanup?.();
    }
    // One list on both turn kinds keeps the cached prefix; completions refuse the call instead.
    expect(natives).toEqual([kept, kept]);
  },
);
