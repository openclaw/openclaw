import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, vi } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { fixtureReceiptClientSource } from "../../../test/helpers/fixture-receipts.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createTestPluginApi } from "../../plugin-sdk/plugin-test-api.js";
import { createPluginRuntimeMock } from "../../plugin-sdk/plugin-test-runtime.js";
import { upsertSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import { createPluginStateRuntimeStores } from "../../plugin-state/plugin-state-store.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  getActivePluginRegistry,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import type { OpenClawPluginDefinition, OpenClawPluginService } from "../../plugins/types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import { createEmptyAgentDiscoveryStores } from "../embedded-agent-runner/model.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { registerAgentHarness } from "./registry.js";

const agents = ["opencode", "qwen", "pi", "kilocode"] as const;
export function useNativeProcessFixture() {
  let snapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;
  let lifetime: ReturnType<typeof createFixtureLifetime>;
  beforeEach(() => {
    lifetime = createFixtureLifetime();
    snapshot = captureActivePluginRegistrySnapshot();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });
  afterEach(async () => {
    await lifetime.cleanup();
    clearRuntimeConfigSnapshot();
    restoreActivePluginRegistrySnapshot(snapshot);
    vi.restoreAllMocks();
  });
  return {
    track: <T>(completion: Promise<T>): Promise<T> => lifetime.track(completion),
  };
}

export async function registerNative(
  state: OpenClawTestState,
  config: OpenClawConfig,
  peerName: "owner-agent.mjs" | "approval-effect-agent.mjs",
  peerOptions: {
    holdModeControl?: boolean;
    holdNewSession?: boolean;
    holdPromptReply?: boolean;
    allowAlwaysOnly?: boolean;
    receiptEndpoint?: string;
  } = {},
) {
  // Transcript writes read the Gateway-published runtime config; the test state resets it on exit.
  setRuntimeConfigSnapshot(config);
  const peer = fileURLToPath(new URL(`../../../test/fixtures/acp/${peerName}`, import.meta.url));
  const peerDirectory = state.path("peer");
  await fs.mkdir(path.join(peerDirectory, "effects"), { recursive: true });
  const receiptModule = path.join(peerDirectory, "receipts.mjs");
  if (peerOptions.receiptEndpoint) {
    await fs.writeFile(
      receiptModule,
      `${fixtureReceiptClientSource(peerOptions.receiptEndpoint)}\nexport { sendReceipt };\n`,
    );
  }
  const { default: plugin } = await loadBundledPluginFacade<{ default: OpenClawPluginDefinition }>({
    pluginId: "acpx",
    artifactBasename: "index.js",
  });
  const getRuntimeConfig = vi.fn(() => config);
  const args = [
    peer,
    peerDirectory,
    ...(peerName === "owner-agent.mjs" ? ["--model-controls"] : []),
    ...(peerOptions.holdModeControl ? ["--hold-mode-control"] : []),
    ...(peerOptions.holdNewSession ? ["--hold-new-session"] : []),
    ...(peerOptions.holdPromptReply ? ["--hold-prompt-reply"] : []),
    ...(peerOptions.allowAlwaysOnly ? ["--allow-always-only"] : []),
    ...(peerOptions.receiptEndpoint ? [`--receipt-module=${receiptModule}`] : []),
  ];
  let service: OpenClawPluginService | undefined;
  const api = createTestPluginApi({
    id: "acpx",
    config,
    pluginConfig: {
      cwd: state.workspaceDir,
      stateDir: state.path("acpx-runtime"),
      agents: Object.fromEntries(
        agents.map((agent) => [agent, { command: process.execPath, args: [...args] }]),
      ),
    },
    runtime: createPluginRuntimeMock({
      config: { current: getRuntimeConfig },
      state: {
        resolveStateDir: () => state.stateDir,
        openKeyedStoreV2: createPluginStateRuntimeStores("acpx", () => {}).openKeyedStoreV2,
      },
    }),
    registerAgentHarness: (harness) => registerAgentHarness(harness, { ownerPluginId: "acpx" }),
    registerService: (registered) => {
      assert(registered.apiVersion !== 2, "Expected ACPX service API version 1");
      service = registered;
    },
    registerReload: (registration) => {
      const registry = getActivePluginRegistry();
      assert(registry, "Native process test registry missing");
      registry.reloads.push({ pluginId: "acpx", pluginName: "ACPX", source: "test", registration });
    },
  });
  assert(plugin.register, "ACPX registration missing");
  plugin.register(api);
  assert(service, "ACPX service missing");
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
  const prompt = "Record the requested native effect.";
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
    prompt,
    timeoutMs: 30000,
    thinkLevel: "off",
    model: makeProviderModelFixture({
      id: "selected",
      api: "openai-completions",
      provider,
      baseUrl: "",
    }),
    authProfileStore: { version: 1, profiles: {} },
    userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
      message: { role: "user", content: prompt, timestamp: Date.now() },
      target: { ...target, sessionEntry: entry },
      updateMode: "none",
    }),
  };
  return { input, target, close: admission.close };
}
