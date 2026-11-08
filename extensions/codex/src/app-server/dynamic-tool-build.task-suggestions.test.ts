// A changed dynamic-tool fingerprint replaces the native thread, so the session's latest
// operator surface, not the current turn's client, decides the suggestion declarations.
import "./dynamic-tool-build.test-support.js";
import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { recordSessionMetaFromInbound } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, beforeEach, expect, it } from "vitest";
import { resolveCodexDynamicToolsLoadingForRuntime } from "./dynamic-tool-profile.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { flattenCodexDynamicToolFunctions } from "./protocol.js";
import { resolveCodexDynamicToolDirectNames } from "./run-attempt-tools.js";
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";

const {
  bindProductionCodexHostCapabilities,
  buildDynamicToolsForTest,
  cleanupDynamicToolBuildFixture,
  setupDynamicToolBuildFixture,
  createCodexRuntimePlanFixture,
  createParams,
} = await import("./dynamic-tool-build.test-support.js");

const UI_CAPS = ["inline-widgets", "tool-events", "ui-commands"];
let tempDir: string;
let runs = 0;
const hostCapabilityClosers: Array<() => void> = [];

beforeEach(async () => {
  tempDir = await setupDynamicToolBuildFixture();
});

afterEach(async () => {
  await cleanupDynamicToolBuildFixture(tempDir, hostCapabilityClosers);
});

function internalTurn(sourceTool: string, channel = "webchat") {
  return {
    messageChannel: channel,
    messageProvider: channel,
    clientCaps: [],
    inputProvenance: { kind: "inter_session" as const, sourceChannel: "internal", sourceTool },
  };
}

async function session(sessionKey: string, channel = "webchat") {
  const storePath = path.join(tempDir, "sessions.json");
  const workspaceDir = path.join(tempDir, "workspace");
  const record = (ctx: Record<string, unknown>) =>
    recordSessionMetaFromInbound({
      storePath,
      sessionKey,
      ctx: { Provider: channel, Surface: channel, OriginatingChannel: channel, ...ctx },
    });
  // Mirrors run-attempt-tool-setup: thread lifecycle fingerprints the bridge's declared specs.
  const declare = async (turn: Partial<EmbeddedRunAttemptParams>) => {
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir, {
      disableTools: false,
      runtimePlan: createCodexRuntimePlanFixture(),
      config: { session: { store: storePath } },
      sessionKey,
      runId: `run-${++runs}`,
      trigger: "user",
      ...turn,
    });
    await bindProductionCodexHostCapabilities(params, hostCapabilityClosers);
    const options = { nativeToolSurfaceEnabled: true, sandbox: null };
    const registeredTools = await buildDynamicToolsForTest(params, workspaceDir, {
      ...options,
      ignoreDisableMessageTool: true,
      ignoreRuntimePlan: true,
    });
    const bridge = createCodexDynamicToolBridge({
      tools: await buildDynamicToolsForTest(params, workspaceDir, options),
      registeredTools,
      signal: new AbortController().signal,
      loading: resolveCodexDynamicToolsLoadingForRuntime({}, params.modelId, {
        nativeToolSurfaceEnabled: true,
      }),
      directToolNames: resolveCodexDynamicToolDirectNames(params, registeredTools, false),
      hookContext: { agentId: "main", sessionKey, runId: params.runId },
    });
    return {
      fingerprint: codexDynamicToolsFingerprint(bridge.specs),
      suggestions: flattenCodexDynamicToolFunctions(bridge.specs).filter((spec) =>
        ["suggest_task", "dismiss_task"].includes(spec.name),
      ),
    };
  };
  return { record, declare };
}

it("keeps one Codex catalog across Control UI and internal turns of a capable session", async () => {
  const { record, declare } = await session("agent:main:dashboard:suggestions");
  await record({
    GatewayClientScopes: ["operator.admin"],
    GatewayClientCaps: [...UI_CAPS, "task-suggestions"],
    GatewayTaskSuggestionDeliveryMode: "gateway",
  });
  const operator = await declare({
    messageChannel: "webchat",
    messageProvider: "webchat",
    clientCaps: [...UI_CAPS, "task-suggestions"],
    senderIsOwner: true,
    taskSuggestionDeliveryMode: "gateway",
  });
  expect(operator.suggestions.map((spec) => spec.name).toSorted()).toEqual([
    "dismiss_task",
    "suggest_task",
  ]);
  for (const sourceTool of ["sessions_send", "subagent_announce"]) {
    const turn = internalTurn(sourceTool);
    await record({ GatewayClientCaps: [], InputProvenance: turn.inputProvenance });
    expect(await declare(turn)).toEqual(operator);
  }

  // The next operator surface replaces the recorded one.
  await record({ GatewayClientScopes: ["operator.admin"], GatewayClientCaps: UI_CAPS });
  expect((await declare(internalTurn("sessions_send"))).suggestions).toEqual([]);
  // A channel session never recorded a capable surface.
  const channel = await session("agent:main:telegram:direct:owner", "telegram");
  await channel.record({ ChatType: "direct", From: "telegram:owner" });
  expect(
    (await channel.declare(internalTurn("subagent_announce", "telegram"))).suggestions,
  ).toEqual([]);
});
