import type {
  AgentHarnessSideQuestionParamsV2,
  NativeHookRelayEvent,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { buildAgentHookContextChannelFields } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  registerNativeHookRelayForBundledRuntime,
  type NativeHookRelayCommandPlan,
} from "openclaw/plugin-sdk/native-hook-relay-runtime";
import { requireCodexThreadForkSettings } from "./client-fork-settings.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { CODEX_INFERENCE_GENERATION_KEY } from "./inference-context.js";
import {
  getCodexInferenceThread,
  getCodexInferenceThreadQualification,
} from "./inference-routing.js";
import {
  assertCodexNativeHookRelayAllowed,
  buildCodexNativeHookRelayConfig,
  buildCodexNativeHookRelayDisabledConfig,
  resolveCodexNativeHookRelayEvents,
  resolveCodexNativeHookRelayTtlMs,
} from "./native-hook-relay.js";
import type { ParentRegistrationHandle } from "./native-subagent-monitor-types.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import { mergeCodexThreadConfigs } from "./plugin-thread-config.js";
import type { CodexThreadForkParams, JsonObject, JsonValue } from "./protocol.js";
import { isMissingCodexParentThreadError } from "./rpc-error.js";
import type { CodexRunAttemptOptions } from "./run-attempt-types.js";
import {
  getLeasedSharedCodexAppServerClient,
  retainSharedCodexAppServerClientByInstanceId,
  type CodexAppServerClientOptions,
} from "./shared-client.js";
import { buildCodexUserInput } from "./user-input.js";

export const DENIED_DYNAMIC_TOOL_RESPONSE: JsonValue = {
  success: false,
  contentItems: [{ type: "inputText", text: "Tool calls are denied for this side question." }],
};

export async function resolveCodexSideQuestionRelayEvents(params: {
  denyToolCalls: boolean;
  client: CodexAppServerClient;
  signal: AbortSignal;
  appServer: CodexAppServerRuntimeOptions;
  options: CodexRunAttemptOptions["nativeHookRelay"];
  assertCurrent: () => void;
}): Promise<readonly NativeHookRelayEvent[]> {
  const events: readonly NativeHookRelayEvent[] = params.denyToolCalls
    ? ["pre_tool_use"]
    : resolveCodexNativeHookRelayEvents({
        configuredEvents: params.options?.events,
        appServer: params.appServer,
      });
  if (params.denyToolCalls) {
    await assertCodexNativeHookRelayAllowed(
      params.client,
      params.signal,
      params.appServer.requestTimeoutMs,
    );
    params.assertCurrent();
  }
  return events;
}

type SideQuestionRelayPreparation = NativeHookRelayCommandPlan & {
  prepareInvocation: () => Promise<void>;
};

export async function prepareCodexSideQuestionRelay(params: {
  relay: SideQuestionRelayPreparation | undefined;
  events: readonly NativeHookRelayEvent[];
  options: CodexRunAttemptOptions["nativeHookRelay"];
  assertCurrent: () => void;
}) {
  await params.relay?.prepareInvocation();
  params.assertCurrent();
  return params.relay
    ? buildCodexNativeHookRelayConfig({
        relay: params.relay,
        events: params.events,
        hookTimeoutSec: params.options?.hookTimeoutSec,
        clearOmittedEvents: true,
      })
    : params.options?.enabled === false
      ? buildCodexNativeHookRelayDisabledConfig()
      : undefined;
}

export function registerCodexSideQuestionRelay(
  params: {
    denyToolCalls: boolean;
    appServer: CodexAppServerRuntimeOptions;
    options: CodexRunAttemptOptions["nativeHookRelay"];
    sideParams: AgentHarnessSideQuestionParamsV2;
    agentId: string | undefined;
    completionTimeoutMs: number;
  },
  registration: Omit<
    Parameters<typeof registerNativeHookRelayForBundledRuntime>[0],
    | "provider"
    | "requirePreToolUse"
    | "ttlMs"
    | "command"
    | "preToolUseLoopDetection"
    | "agentId"
    | "sessionId"
    | "sessionKey"
    | "config"
    | "channelId"
  >,
) {
  if (!params.options || params.options.enabled === false) {
    return undefined;
  }
  const sideParams = params.sideParams;
  const channelId = buildAgentHookContextChannelFields({
    sessionKey: sideParams.sessionKey,
    messageChannel: sideParams.messageChannel,
    messageProvider: sideParams.messageProvider,
    currentChannelId: sideParams.currentChannelId,
  }).channelId;
  return registerNativeHookRelayForBundledRuntime({
    ...registration,
    provider: "codex",
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: sideParams.sessionId,
    ...(sideParams.sessionKey ? { sessionKey: sideParams.sessionKey } : {}),
    ...(sideParams.cfg ? { config: sideParams.cfg } : {}),
    ...(channelId ? { channelId } : {}),
    preToolUseLoopDetection: params.appServer.loopDetectionPreToolUseRelay,
    requirePreToolUse: params.denyToolCalls,
    ttlMs: resolveCodexNativeHookRelayTtlMs({
      explicitTtlMs: params.options.ttlMs,
      attemptTimeoutMs: params.completionTimeoutMs,
      startupTimeoutMs: params.appServer.requestTimeoutMs * 2,
      turnStartTimeoutMs: params.appServer.requestTimeoutMs,
    }),
    command: { timeoutMs: params.options.gatewayTimeoutMs },
  });
}

export async function acquireCodexSideQuestionClient(
  denyToolCalls: boolean,
  parentClientId: string | undefined,
  clientOptions: CodexAppServerClientOptions,
) {
  // A fresh acquisition can select another physical client (auth/profile/runtime key differs).
  // Cache-parity state and private inference context belong to the parent's recorded owner.
  const parentLease = denyToolCalls
    ? await retainSharedCodexAppServerClientByInstanceId(parentClientId, {
        signal: clientOptions.abandonSignal,
      })
    : undefined;
  if (denyToolCalls && !parentLease) {
    throw new Error(
      "Cache-parity session fork requires the parent's live Codex client. Send a normal message first.",
    );
  }
  const client = parentLease?.client ?? (await getLeasedSharedCodexAppServerClient(clientOptions));
  return { client, parentLease };
}

/** Replays parent settings and owns the child inference and native model-source custody. */
export class CodexSideQuestionFork {
  private readonly settings;
  private inferenceContext: { generation: string; release: () => void } | undefined;
  private modelRegistration: ParentRegistrationHandle | undefined;

  constructor(
    client: CodexAppServerClient,
    private readonly parentThreadId: string,
  ) {
    this.settings = requireCodexThreadForkSettings(client, parentThreadId);
  }

  threadParams(nativeHookRelayConfig: JsonObject | undefined): CodexThreadForkParams {
    // Hosted search executes upstream of PreToolUse, so the native relay cannot deny it.
    const config = {
      ...mergeCodexThreadConfigs(this.settings.thread.config ?? undefined, nativeHookRelayConfig),
      web_search: "disabled",
    };
    return {
      ...this.settings.thread,
      config,
      ephemeral: true,
      excludeTurns: true,
    };
  }

  turnParams(threadId: string, params: AgentHarnessSideQuestionParamsV2) {
    return {
      ...this.settings.turn,
      threadId,
      input: buildCodexUserInput(params.question.trim(), params.images),
      ...(this.inferenceContext
        ? {
            responsesapiClientMetadata: {
              [CODEX_INFERENCE_GENERATION_KEY]: this.inferenceContext.generation,
            },
          }
        : {}),
    };
  }

  async registerChild(
    client: CodexAppServerClient,
    threadId: string,
    hostCapabilities: AgentHarnessSideQuestionParamsV2["hostCapabilities"],
    runAbortController: AbortController,
    assertCurrent: () => void,
    assertCurrentBinding: () => void,
  ) {
    const inference = getCodexInferenceThread(client, this.parentThreadId);
    if (inference) {
      this.inferenceContext = await inference.context.fork({
        sourceThreadId: this.parentThreadId,
        threadId,
        signal: runAbortController.signal,
        assertCurrent,
      });
    }
    // The prefix generation is not model authority. Admit this distinct
    // root thread under the side run before its first native request.
    const modelSource = hostCapabilities.retainSourceAuthority?.();
    try {
      const configurationQualification = getCodexInferenceThreadQualification(
        client,
        this.parentThreadId,
      );
      this.modelRegistration = await codexNativeSubagentMonitorRuntime.register({
        client,
        parentThreadId: threadId,
        modelSource,
        configurationQualification,
        unqualifiedModelExecution: modelSource && !configurationQualification ? true : undefined,
        onUnqualifiedModelCancelled: (reason) => runAbortController.abort(reason),
        assertCurrent,
      });
      await this.modelRegistration.ready;
      assertCurrentBinding();
    } catch (error) {
      modelSource?.release();
      throw error;
    }
  }

  bindTurn(turnId: string, params: AgentHarnessSideQuestionParamsV2, fallbackModel: string) {
    this.modelRegistration?.bindTurn(turnId, {
      nativeModel: {
        provider: this.settings.thread.modelProvider ?? params.provider,
        model: this.settings.turn.model ?? this.settings.thread.model ?? fallbackModel,
      },
      authorizedModel: { provider: params.provider, model: params.model },
    });
  }

  releaseInferenceContext() {
    this.inferenceContext?.release();
  }

  unregisterModel() {
    return this.modelRegistration?.unregister();
  }
}

export async function forkCodexSideThread(
  client: CodexAppServerClient,
  params: CodexThreadForkParams,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<unknown> {
  try {
    return await client.request("thread/fork", params, options);
  } catch (error) {
    if (isMissingCodexParentThreadError(error)) {
      throw new Error(
        "Codex /btw needs an active Codex thread. Send a normal message first, then try /btw again.",
        { cause: error },
      );
    }
    throw error;
  }
}
