import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import type { AcpxRuntime } from "acpx/runtime";
import { afterEach, beforeEach, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createTestPluginApi } from "../../plugin-sdk/plugin-test-api.js";
import { createPluginRuntimeMock } from "../../plugin-sdk/plugin-test-runtime.js";
import { upsertSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import { createPluginStateKeyedStore } from "../../plugin-state/plugin-state-store.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  getActivePluginRegistry,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import type {
  OpenClawPluginDefinition,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "../../plugins/types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import { createEmptyAgentDiscoveryStores } from "../embedded-agent-runner/model.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import { registerAgentHarness } from "./registry.js";

const agents = ["opencode", "qwen", "pi", "kilocode"] as const;
type ServiceModule = {
  createAcpxRuntimeService: () => OpenClawPluginService & {
    getRuntime: (
      ctx: OpenClawPluginServiceContext,
    ) => Promise<
      Pick<AcpRuntime, "ensureSession"> &
        Required<Pick<AcpRuntime, "setMode">> &
        Pick<AcpxRuntime, "getStatus" | "setModel">
    >;
  };
};
export function useNativeProcessFixture() {
  let snapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;
  beforeEach(() => {
    snapshot = captureActivePluginRegistrySnapshot();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });
  afterEach(() => {
    restoreActivePluginRegistrySnapshot(snapshot);
    vi.restoreAllMocks();
  });
}

export async function registerNative(
  state: OpenClawTestState,
  config: OpenClawConfig,
  peerName: "owner-agent.mjs" | "approval-effect-agent.mjs",
  peerOptions: {
    holdModeControl?: boolean;
    holdNewSession?: boolean;
    allowAlwaysOnly?: boolean;
  } = {},
) {
  const peer = fileURLToPath(
    {
      "owner-agent.mjs": new URL("../../../test/fixtures/acp/owner-agent.mjs", import.meta.url),
      "approval-effect-agent.mjs": new URL(
        "../../../test/fixtures/acp/approval-effect-agent.mjs",
        import.meta.url,
      ),
    }[peerName],
  );
  const peerDirectory = state.path("peer");
  await fs.mkdir(peerDirectory);
  await fs.mkdir(path.join(peerDirectory, "effects"));
  const module = await loadBundledPluginFacade<ServiceModule>({
    pluginId: "acpx",
    artifactBasename: "register.runtime.js",
  });
  const factory = vi.spyOn(module, "createAcpxRuntimeService");
  const { default: plugin } = await loadBundledPluginFacade<{ default: OpenClawPluginDefinition }>({
    pluginId: "acpx",
    artifactBasename: "index.js",
  });
  const getRuntimeConfig = vi.fn(() => config);
  const api = createTestPluginApi({
    id: "acpx",
    config,
    pluginConfig: {
      cwd: state.workspaceDir,
      stateDir: state.path("acpx-runtime"),
      agents: Object.fromEntries(
        agents.map((agent) => [
          agent,
          {
            command: process.execPath,
            args: [
              peer,
              peerDirectory,
              ...(peerName === "owner-agent.mjs" ? ["--model-controls"] : []),
              ...(peerOptions.holdModeControl ? ["--hold-mode-control"] : []),
              ...(peerOptions.holdNewSession ? ["--hold-new-session"] : []),
              ...(peerOptions.allowAlwaysOnly ? ["--allow-always-only"] : []),
            ],
          },
        ]),
      ),
    },
    runtime: createPluginRuntimeMock({
      config: { current: getRuntimeConfig },
      state: {
        resolveStateDir: () => state.stateDir,
        openKeyedStore: (options) => createPluginStateKeyedStore("acpx", options),
      },
    }),
    registerAgentHarness: (harness) => registerAgentHarness(harness, { ownerPluginId: "acpx" }),
    registerReload: (registration) => {
      const registry = getActivePluginRegistry();
      if (!registry) {
        throw new Error("Native process test registry missing");
      }
      registry.reloads.push({ pluginId: "acpx", pluginName: "ACPX", source: "test", registration });
    },
  });
  if (!plugin.register) {
    throw new Error("ACPX registration missing");
  }
  plugin.register(api);
  const result = factory.mock.results.at(-1);
  if (!result || result.type !== "return") {
    throw new Error("ACPX service missing");
  }
  const service = result.value;
  const context = {
    config,
    workspaceDir: state.workspaceDir,
    stateDir: state.stateDir,
    logger: api.logger,
  };
  return { peerDirectory, service, context, getRuntimeConfig };
}

export async function attemptFor(
  state: OpenClawTestState,
  config: OpenClawConfig,
  agent: string,
  permissionMode?: EmbeddedRunAttemptParams["permissionMode"],
) {
  const target = {
    agentId: "main",
    sessionKey: "agent:main:chat",
    sessionId: "native-execution",
    storePath: path.join(state.sessionsDir(), "sessions.json"),
  };
  const entry = { sessionId: target.sessionId, updatedAt: Date.now() };
  await upsertSessionEntry({ ...target, entry });
  const runId = randomUUID();
  const admission = prepareAgentRunAdmission({
    cfg: config,
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "native-execution-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
  });
  const admittedRunContext = await admission.admit("plugin-harness", "acpx");
  const provider = `acp-${agent}`;
  const input: EmbeddedRunAttemptParams = {
    ...target,
    ...createEmptyAgentDiscoveryStores(),
    admittedRunContext,
    config,
    runId,
    workspaceDir: state.workspaceDir,
    sessionFile: "sqlite://native-execution",
    provider,
    modelId: "selected",
    agentHarnessRuntimeOverride: provider,
    permissionMode,
    prompt: "Record the requested native effect.",
    timeoutMs: 30000,
    thinkLevel: "off",
    model: {
      id: "selected",
      name: "Selected",
      api: "openai-completions",
      provider,
      baseUrl: "",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 2048,
    },
    authProfileStore: { version: 1, profiles: {} },
    userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
      message: {
        role: "user",
        content: "Record the requested native effect.",
        timestamp: Date.now(),
      },
      target: { ...target, sessionEntry: entry },
      updateMode: "none",
    }),
  };
  return { input, target, close: admission.close };
}
