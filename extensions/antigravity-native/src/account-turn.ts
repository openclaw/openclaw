import { realpath } from "node:fs/promises";
import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness";
import {
  AgentHarnessPreflightError,
  createStreamingDirectiveAccumulator,
  emitAgentEvent,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { readAgyAccountCatalog } from "./account-catalog.js";
import { runBoundAgyTurn, type AgySessionBinding } from "./bound-turn.js";

const runtime = "antigravity-native";
type Attempt = Parameters<AgentHarnessV2["runAttempt"]>[0];

export async function runAccountAttempt(
  params: Attempt,
  openStore: (assertCurrent?: () => void) => PluginStateKeyedStore<AgySessionBinding, 2>,
): ReturnType<AgentHarnessV2["runAttempt"]> {
  if (
    params.provider !== runtime ||
    params.permissionMode !== "full" ||
    params.sandbox ||
    params.requireWorkspaceOnly ||
    params.disableTools ||
    params.toolsAllow !== undefined ||
    params.toolExecutionAllow !== undefined ||
    params.pluginHarnessToolPolicyRestricted
  ) {
    throw new AgentHarnessPreflightError(
      "Antigravity requires an authorized Full access host-native session and cannot enforce OpenClaw tool or sandbox restrictions.",
    );
  }
  if (params.authProfileId || params.resolvedApiKey) {
    throw new AgentHarnessPreflightError(
      "Antigravity account execution uses native agy sign-in, not an OpenClaw credential profile.",
    );
  }
  if (params.images?.length) {
    throw new AgentHarnessPreflightError(
      "Antigravity account execution does not support native attachment projection yet.",
    );
  }
  const timeout = AbortSignal.timeout(params.timeoutMs);
  const signal = params.abortSignal ? AbortSignal.any([params.abortSignal, timeout]) : timeout;
  const assertCurrent = () => {
    signal.throwIfAborted();
    params.hostCapabilities.assertActive();
  };
  assertCurrent();
  const workspace = await realpath(params.workspaceDir);
  const { profile, env, models } = await readAgyAccountCatalog(
    signal,
    params.timeoutMs,
    assertCurrent,
  );
  const route = { backend: "account", profile, model: params.modelId } as const;
  const stream = createStreamingDirectiveAccumulator();
  let streamedText = "";
  const result = await runBoundAgyTurn({
    sessionId: params.sessionId,
    workspace,
    route,
    catalog: { ...route, models },
    store: openStore(assertCurrent),
    prompt: params.prompt,
    signal,
    assertCurrent,
    onDelta(delta) {
      const textDelta = stream.consume(delta)?.text;
      if (!textDelta) {
        return;
      }
      streamedText += textDelta;
      emitAgentEvent({
        runId: params.runId,
        sessionKey: params.sessionKey,
        stream: "assistant",
        data: { text: streamedText, delta: textDelta },
      });
    },
    async preparePlacement(conversationId) {
      const argv = [
        "agy",
        "-p=",
        "--model",
        route.model,
        "--disable-slash-commands",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        ...(conversationId ? ["--conversation", conversationId] : []),
      ];
      return { launch: { argv, cwd: workspace, env }, async [Symbol.asyncDispose]() {} };
    },
  });
  return {
    terminal: { kind: "ok" },
    sessionIdUsed: params.sessionId,
    sessionFileUsed: params.sessionFile,
    assistantTexts: result.text ? [result.text] : [],
    messagesSnapshot: [],
    lastAssistant: undefined,
    hasSuccessfulModelResponse: true,
    toolMetas: [],
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentTargets: [],
    messagingToolSentMediaUrls: [],
    cloudCodeAssistFormatError: false,
    attemptUsage: result.turnUsage,
    replayMetadata: { replaySafe: false, hadPotentialSideEffects: true },
    itemLifecycle: { activeCount: 0, completedCount: 1, startedCount: 1 },
  };
}
