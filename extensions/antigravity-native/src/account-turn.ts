import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness";
import {
  AgentHarnessPreflightError,
  createStreamingDirectiveAccumulator,
  emitAgentEvent,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { runCommandBuffered } from "openclaw/plugin-sdk/process-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { runBoundAgyTurn, type AgySessionBinding } from "./bound-turn.js";
import { decodeAgyCatalog } from "./catalog.js";

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
  const home = await realpath(homedir());
  const profile = join(home, ".gemini", "antigravity-cli");
  const settingsPath = join(profile, "settings.json");
  let settingsText: string | undefined;
  try {
    settingsText = await readFile(settingsPath, "utf8");
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") {
      throw new AgentHarnessPreflightError("Cannot read native Antigravity account settings.");
    }
  }
  if (settingsText !== undefined) {
    let settings: unknown;
    try {
      settings = JSON.parse(settingsText);
    } catch {
      throw new AgentHarnessPreflightError("Cannot parse native Antigravity account settings.");
    }
    if (
      !isRecord(settings) ||
      (settings.modelProvider !== undefined && settings.modelProvider !== "")
    ) {
      throw new AgentHarnessPreflightError(
        "This native Antigravity profile is not in account sign-in mode. No Gemini key or alternate backend will be selected.",
      );
    }
  }
  // Native agy may run its own children under the owner's Full access consent. Never
  // forward the Gateway environment or any host proxy, API key, or cloud identity.
  const path = (process.env.PATH ?? "").split(delimiter).filter(isAbsolute).join(delimiter);
  if (!path) {
    throw new AgentHarnessPreflightError("Antigravity requires an absolute Gateway PATH entry.");
  }
  const env = { HOME: home, PATH: path, LANG: "C.UTF-8" };
  assertCurrent();
  const workspace = await realpath(params.workspaceDir);
  assertCurrent();
  const catalog = await runCommandBuffered(["agy", "--output-format", "json", "models"], {
    cwd: home,
    preparedEnv: env,
    signal,
    timeoutMs: Math.min(params.timeoutMs, 15_000),
    killProcessTree: true,
    maxOutputBytes: 1024 * 1024,
    discardOutput: { stderr: true },
  });
  assertCurrent();
  if (catalog.code !== 0 || catalog.termination !== "exit") {
    throw new AgentHarnessPreflightError(
      "Antigravity account model discovery failed. Check that agy is installed and signed in as the Gateway service user.",
    );
  }
  const models = decodeAgyCatalog(catalog.stdout.toString("utf8"));
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
