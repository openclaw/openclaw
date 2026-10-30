import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type {
  CodexBundleMcpThreadConfig,
  EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, vi } from "vitest";
import { startCodexAttemptThread } from "./attempt-startup.js";
import {
  withEphemeralCodexAuthStore,
  withManagedCodexThreadUnloading,
} from "./auth-start-options.js";
import type { CodexAppServerPreparedAuth } from "./auth-types.js";
import { CodexAppServerClient } from "./client.js";
import {
  type CodexPluginConfig,
  resolveCodexAppServerRuntimeOptions,
  resolveCodexComputerUseConfig,
} from "./config.js";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import { testCodexAppServerBindingStore } from "./session-binding.test-helpers.js";
import {
  getLeasedSharedCodexAppServerClient,
  type CodexAppServerClientFactory,
} from "./shared-client.js";
import { resolveCodexAppServerSpawnIdentity } from "./spawn-identity.js";
import { createCodexTestModel, createInferenceReadyClientHarness } from "./test-support.js";

export type AttemptClientHarness = ReturnType<typeof createInferenceReadyClientHarness>;
type StartupParams = Parameters<typeof startCodexAttemptThread>[0];
type HarnessMessage = { id?: number; method?: string; params?: unknown };
const requestWait = { interval: 1, timeout: 15_000 };

export function createAttemptClientHarness(): AttemptClientHarness {
  return createInferenceReadyClientHarness({
    onWrite: (line, send) => {
      const request = JSON.parse(line) as { id: number; method: string };
      if (request.method === "configRequirements/read") {
        send({ id: request.id, result: { requirements: null } });
      }
    },
  });
}

export function createAttemptThreadStarter(
  tempRoots: Set<string>,
  defaultPluginConfig: CodexPluginConfig,
) {
  return function startThreadWithHarness(
    startupTimeoutMs: number,
    signal = new AbortController().signal,
    overrides: {
      pluginConfig?: CodexPluginConfig;
      buildAttemptParams?: StartupParams["buildAttemptParams"];
      runtimeArtifactRequest?: StartupParams["runtimeArtifactRequest"];
      sandbox?: StartupParams["sandbox"];
      sandboxExecServerEnabled?: boolean;
      runtime?: StartupParams["runtime"];
      appServer?: StartupParams["appServer"];
      startupPreparedAuth?: CodexAppServerPreparedAuth;
      attemptClientFactory?: (harness: AttemptClientHarness) => CodexAppServerClientFactory;
      harness?: AttemptClientHarness;
      paths?: AttemptPaths;
      skipStartSpy?: boolean;
    } = {},
  ) {
    const { runtimeArtifactRequest, startupPreparedAuth } = overrides;
    const pluginConfig = overrides.pluginConfig ?? defaultPluginConfig;
    const harness = overrides.harness ?? createAttemptClientHarness();
    const paths = overrides.paths ?? createAttemptPaths(tempRoots);
    const startSpy = overrides.skipStartSpy
      ? undefined
      : vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    const run = startCodexAttemptThread({
      bindingStore: testCodexAppServerBindingStore,
      runtime: overrides.runtime,
      attemptClientFactory:
        overrides.attemptClientFactory?.(harness) ?? getLeasedSharedCodexAppServerClient,
      appServer: overrides.appServer ?? resolveCodexAppServerRuntimeOptions({ pluginConfig }),
      pluginConfig,
      computerUseConfig: resolveCodexComputerUseConfig({ pluginConfig }),
      clientOptions: {
        preparedAuth: startupPreparedAuth,
        runtimeArtifactMode: runtimeArtifactRequest ? "capture" : undefined,
        expectedRuntimeArtifact: runtimeArtifactRequest?.expected,
      },
      runtimeArtifactRequest,
      startupAuthAccountCacheKey: undefined,
      startupEnvApiKeyCacheKey: undefined,
      agentDir: paths.agentDir,
      config: undefined,
      buildAttemptParams: overrides.buildAttemptParams ?? (() => createAttemptParams(paths)),
      sessionAgentId: "agent-1",
      effectiveWorkspace: paths.workspaceDir,
      effectiveCwd: paths.cwd,
      dynamicTools: [],
      webSearchAllowed: false,
      developerInstructions: undefined,
      bundleMcpThreadConfig,
      nativeToolSurfaceEnabled: true,
      nativeProviderWebSearchSupport: "supported",
      sandboxExecServerEnabled: overrides.sandboxExecServerEnabled ?? false,
      sandbox: overrides.sandbox ?? null,
      contextEngineProjection: undefined,
      startupTimeoutMs,
      signal,
      onStartupTimeout: vi.fn(),
      spawnedBy: undefined,
    });

    return { harness, run, startSpy };
  };
}

export function readHarnessMessages(writes: string[]): HarnessMessage[] {
  return writes.map((write) => JSON.parse(write) as HarnessMessage);
}

export function readHarnessRequestMethods(harness: AttemptClientHarness) {
  return readHarnessMessages(harness.writes)
    .filter(({ id }) => id !== undefined)
    .map(({ method }) => method);
}

export async function answerInitialize(harness: AttemptClientHarness): Promise<void> {
  await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(1), requestWait);
  const initialize = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
  harness.send({ id: initialize.id, result: { userAgent: "openclaw/0.149.0 (macOS; test)" } });
}

export async function waitForRequest(
  harness: AttemptClientHarness,
  method: string,
): Promise<HarnessMessage> {
  return vi.waitFor(() => {
    const request = readHarnessMessages(harness.writes).find((write) => write.method === method);
    if (!request) {
      throw new Error(`${method} request was not written`);
    }
    return request;
  }, requestWait);
}

export async function waitForThreadStart(harness: AttemptClientHarness): Promise<{ id?: number }> {
  return waitForRequest(harness, "thread/start");
}

export async function captureExpectedRuntimeArtifact(
  appServer: ReturnType<typeof resolveCodexAppServerRuntimeOptions>,
) {
  const { captureCodexAppServerRuntimeArtifactBeforeStart, finalizeCodexAppServerRuntimeArtifact } =
    await import("./runtime-artifact.js");
  const startOptions = withManagedCodexThreadUnloading(
    withEphemeralCodexAuthStore({ startOptions: appServer.start }),
  );
  const spawnIdentity = resolveCodexAppServerSpawnIdentity(startOptions);
  const options = { startOptions, spawnIdentity };
  const before = await captureCodexAppServerRuntimeArtifactBeforeStart(options);
  return finalizeCodexAppServerRuntimeArtifact({
    ...options,
    before,
    runtimeIdentity: { serverVersion: "0.149.0", userAgent: "openclaw/0.149.0 (macOS; test)" },
  });
}

export function createPairedAttemptRuntime() {
  const channels: Array<{ close: ReturnType<typeof vi.fn>; sessionId: string }> = [];
  const openDuplex = vi.fn<NonNullable<StartupParams["runtime"]>["nodes"]["openDuplex"]>(
    async (request) => {
      const closed = Promise.withResolvers<unknown>();
      const close = vi.fn(() => closed.resolve({ ok: true }));
      channels.push({ close, sessionId: (request.params as { sessionId: string }).sessionId });
      return {
        send: vi.fn(async () => undefined),
        onMessage: vi.fn(() => () => undefined),
        closed: closed.promise,
        close,
      };
    },
  );
  return {
    runtime: createPluginRuntimeMock({ nodes: { openDuplex } }),
    channels,
    openDuplex,
  };
}

export type AttemptPaths = Record<"agentDir" | "cwd" | "sessionFile" | "workspaceDir", string>;

export function createAttemptPaths(tempRoots: Set<string>): AttemptPaths {
  const root = path.join(os.tmpdir(), `openclaw-codex-attempt-startup-${randomUUID()}`);
  tempRoots.add(root);
  return {
    agentDir: path.join(root, "agent"),
    cwd: path.join(root, "workspace"),
    sessionFile: path.join(root, "session.jsonl"),
    workspaceDir: path.join(root, "workspace"),
  };
}

export function createAttemptParams(paths: AttemptPaths): EmbeddedRunAttemptParams {
  return {
    hostCapabilities: createCodexTestHostCapabilities(),
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "agent:agent-1:session-1",
    agentDir: paths.agentDir,
    sessionFile: paths.sessionFile,
    effectiveCwd: paths.cwd,
    workspaceDir: paths.workspaceDir,
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
  } as EmbeddedRunAttemptParams;
}

const bundleMcpThreadConfig = {
  configPatch: undefined,
  diagnostics: [],
  evaluated: false,
  fingerprint: undefined,
  staticServerNames: [],
  userStaticServerNames: [],
} satisfies CodexBundleMcpThreadConfig;
