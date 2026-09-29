import path from "node:path";
import type {
  CodexBundleMcpThreadConfig,
  EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { vi } from "vitest";
import { startCodexAttemptThread } from "./attempt-startup.js";
import {
  resolveCodexAppServerRuntimeOptions,
  resolveCodexComputerUseConfig,
  type CodexPluginConfig,
} from "./config.js";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import { testCodexAppServerBindingStore } from "./session-binding.test-helpers.js";
import { getLeasedSharedCodexAppServerClient } from "./shared-client.js";
import { createCodexTestModel } from "./test-support.js";

export function startFixtureAttempt(
  fixture: { root: string; pluginConfig: CodexPluginConfig },
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
    startupAuthProfileId: undefined,
    startupAuthBindingFingerprint: undefined,
    startupAuthAccountCacheKey: undefined,
    startupEnvApiKeyCacheKey: undefined,
    agentDir,
    config: undefined,
    buildAttemptParams: () =>
      ({
        hostCapabilities: createCodexTestHostCapabilities(),
        prompt: "hello",
        sessionId: "session-1",
        sessionKey: "agent:agent-1:session-1",
        agentDir,
        sessionFile: path.join(fixture.root, "session.jsonl"),
        effectiveCwd: workspaceDir,
        workspaceDir,
        runId: "run-1",
        provider: "codex",
        modelId: "gpt-5.4-codex",
        model: createCodexTestModel("codex"),
        thinkLevel: "medium",
        disableTools: true,
        timeoutMs: 5_000,
        authStorage: {} as never,
        authProfileStore: { version: 1, profiles: {} },
        modelRegistry: {} as never,
      }) as EmbeddedRunAttemptParams,
    sessionAgentId: "agent-1",
    effectiveWorkspace: workspaceDir,
    effectiveCwd: workspaceDir,
    dynamicTools: [],
    webSearchAllowed: false,
    developerInstructions: undefined,
    finalConfigPatch: undefined,
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
