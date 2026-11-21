import path from "node:path";
import type { CodexBundleMcpThreadConfig } from "openclaw/plugin-sdk/agent-harness-runtime";
import { vi } from "vitest";
import { startCodexAttemptThread } from "./attempt-startup.js";
import { createAttemptParams } from "./attempt-startup.test-support.js";
import {
  resolveCodexAppServerRuntimeOptions,
  resolveCodexComputerUseConfig,
  type CodexPluginConfig,
} from "./config.js";
import { testCodexAppServerBindingStore } from "./session-binding.test-helpers.js";
import { getLeasedSharedCodexAppServerClient } from "./shared-client.js";

export function startFixtureAttempt(
  fixture: { root: string; pluginConfig: CodexPluginConfig; disableTools?: boolean },
  attemptClientFactory = getLeasedSharedCodexAppServerClient,
  signal = new AbortController().signal,
) {
  const agentDir = path.join(fixture.root, "agent");
  const workspaceDir = path.join(fixture.root, "workspace");
  const bundleMcpThreadConfig = {
    configPatch: undefined,
    diagnostics: [],
    evaluated: false,
    fingerprint: undefined,
    staticServerNames: [],
    userStaticServerNames: [],
  } satisfies CodexBundleMcpThreadConfig;
  return startCodexAttemptThread({
    bindingStore: testCodexAppServerBindingStore,
    attemptClientFactory,
    appServer: resolveCodexAppServerRuntimeOptions({ pluginConfig: fixture.pluginConfig }),
    pluginConfig: fixture.pluginConfig,
    computerUseConfig: resolveCodexComputerUseConfig({ pluginConfig: fixture.pluginConfig }),
    clientOptions: {
      authProfileId: undefined,
      authBindingFingerprint: undefined,
      authRequirement: undefined,
    },
    startupAuthAccountCacheKey: undefined,
    startupEnvApiKeyCacheKey: undefined,
    agentDir,
    config: undefined,
    buildAttemptParams: () => ({
      ...createAttemptParams({
        agentDir,
        cwd: workspaceDir,
        sessionFile: path.join(fixture.root, "session.jsonl"),
        workspaceDir,
      }),
      disableTools: fixture.disableTools ?? true,
    }),
    sessionAgentId: "agent-1",
    effectiveWorkspace: workspaceDir,
    effectiveCwd: workspaceDir,
    dynamicTools: [],
    webSearchAllowed: false,
    developerInstructions: undefined,
    bundleMcpThreadConfig,
    nativeToolSurfaceEnabled: true,
    nativeProviderWebSearchSupport: "supported",
    sandboxExecServerEnabled: false,
    sandbox: null,
    contextEngineProjection: undefined,
    startupTimeoutMs: 10_000,
    signal,
    onStartupTimeout: vi.fn(),
    spawnedBy: undefined,
  });
}
