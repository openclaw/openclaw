import type { inspectConversationBinding } from "openclaw/plugin-sdk/conversation-binding-inspection-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type {
  PluginConversationBinding,
  PluginConversationBindingResolvedEvent,
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
} from "openclaw/plugin-sdk/plugin-entry";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { isIncognitoSessionKey } from "openclaw/plugin-sdk/session-key-runtime";
import type { resolveCodexAppServerAuthProfileIdForAgent } from "./app-server/auth-profile.js";
import { assertCodexBindingMayBeReplaced } from "./app-server/session-binding-record.js";
import type { CodexAppServerBindingStore } from "./app-server/session-binding.js";
import { withCodexConversationThreadActivity } from "./app-server/thread-ownership-queue.js";
import { defineCodexBuildState } from "./build-state.js";
import { canMutateCodexHost, CODEX_NATIVE_EXECUTION_AUTH_ERROR } from "./command-authorization.js";
import { formatCodexDisplayText } from "./command-formatters.js";
import {
  readCodexConversationBindingData,
  readCodexConversationBindingDataRecord,
} from "./conversation-binding-data.js";
import type { resumeCodexCliSessionOnNode } from "./node-cli-sessions.js";

type CodexConversationRunOptions = {
  bindingStore: CodexAppServerBindingStore;
  pluginConfig?: unknown;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  timeoutMs?: number;
  resumeCodexCliSessionOnNode?: (
    params: Omit<Parameters<typeof resumeCodexCliSessionOnNode>[0], "runtime">,
  ) => ReturnType<typeof resumeCodexCliSessionOnNode>;
};

const getNodeConversationState = defineCodexBuildState(
  "openclaw.codex.conversationBinding",
  () => ({ queue: new KeyedAsyncQueue() }),
);

function isCurrentPublicBinding(
  binding: PluginConversationBinding,
  inspect: typeof inspectConversationBinding,
): boolean {
  const inspection = inspect({
    channel: binding.channel,
    accountId: binding.accountId,
    conversationId: binding.conversationId,
    ...(binding.parentConversationId ? { parentConversationId: binding.parentConversationId } : {}),
  });
  return inspection.status === "available" && inspection.binding?.bindingId === binding.bindingId;
}

export async function handleCodexConversationInboundClaim(
  event: PluginHookInboundClaimEvent,
  ctx: PluginHookInboundClaimContext,
  options: CodexConversationRunOptions,
): Promise<{ handled: boolean; reply?: ReplyPayload } | undefined> {
  const publicBinding = ctx.pluginBinding;
  const data = readCodexConversationBindingData(publicBinding);
  if (!data || !publicBinding) {
    return undefined;
  }
  if (event.commandAuthorized !== true) {
    return { handled: true };
  }
  const prompt = event.bodyForAgent?.trim() || event.content?.trim() || "";
  if (!prompt) {
    return { handled: true };
  }
  if (!canMutateCodexHost(event)) {
    return { handled: true, reply: { text: CODEX_NATIVE_EXECUTION_AUTH_ERROR } };
  }
  const sessionKey = event.sessionKey ?? ctx.sessionKey;
  try {
    if (data.kind === "codex-cli-node-session") {
      const text = await getNodeConversationState().queue.enqueue(
        `${data.nodeId}:${data.sessionId}`,
        async () => {
          const { resolveCodexNativeSandboxBlock } = await import("./app-server/sandbox-guard.js");
          const blocked = resolveCodexNativeSandboxBlock({
            config: options.config,
            sessionKey,
            surface: "Codex CLI node conversation binding",
          });
          if (blocked) {
            return blocked;
          }
          const resume = options.resumeCodexCliSessionOnNode;
          if (!resume) {
            return "Codex CLI node binding is unavailable because Gateway node runtime is not attached.";
          }
          const { inspectConversationBinding } =
            await import("openclaw/plugin-sdk/conversation-binding-inspection-runtime");
          if (!isCurrentPublicBinding(publicBinding, inspectConversationBinding)) {
            return "This Codex conversation was detached or changed before its message could run.";
          }
          const resumed = await resume({
            nodeId: data.nodeId,
            sessionId: data.sessionId,
            agentId: data.agentId,
            sessionKey,
            prompt,
            cwd: data.cwd,
            timeoutMs: options.timeoutMs,
          });
          return resumed.text.trim() || "Codex completed without a text reply.";
        },
      );
      return { handled: true, reply: { text } };
    }
    const identity = { kind: "conversation" as const, bindingId: data.bindingId };
    // Start the read and reserve before yielding: retirement must not overtake
    // an already-arrived message, even when the execution module is still cold.
    const pendingExpected = options.bindingStore.readAsync(identity);
    // The queue may wait behind retirement; observe early rejection until its callback joins it.
    void pendingExpected.catch(() => {});
    const result = await withCodexConversationThreadActivity(data.bindingId, async () => {
      const expected = await pendingExpected;
      const { runBoundTurnWithMissingThreadRecovery } = await import("./conversation-binding.js");
      const { inspectConversationBinding } =
        await import("openclaw/plugin-sdk/conversation-binding-inspection-runtime");
      const current = options.bindingStore.read(identity);
      if (
        !isCurrentPublicBinding(publicBinding, inspectConversationBinding) ||
        (expected &&
          (!current ||
            current.threadId !== expected.threadId ||
            current.conversationStartId !== expected.conversationStartId)) ||
        (!expected && current && data.start?.id && current.conversationStartId !== data.start.id)
      ) {
        return {
          text: "This Codex conversation was detached or changed before its message could run.",
        };
      }
      return await runBoundTurnWithMissingThreadRecovery({
        bindingStore: options.bindingStore,
        data,
        prompt,
        event,
        config: options.config,
        sessionKey,
        // Source ownership, not the destination channel, controls ephemeral execution.
        incognito: isIncognitoSessionKey(
          data.source?.sessionKey ?? (data.legacyBinding ? sessionKey : undefined),
        ),
        pluginConfig: options.pluginConfig,
        timeoutMs: options.timeoutMs,
      });
    });
    return { handled: true, reply: result };
  } catch (error) {
    const runtime = data.kind === "codex-cli-node-session" ? "Codex CLI node" : "Codex app-server";
    return {
      handled: true,
      reply: {
        text: `${runtime} turn failed: ${formatCodexDisplayText(formatErrorMessage(error))}`,
      },
    };
  }
}

export async function handleCodexConversationBindingResolved(
  event: PluginConversationBindingResolvedEvent,
  options: { bindingStore: CodexAppServerBindingStore },
): Promise<void> {
  if (event.status !== "denied") {
    return;
  }
  const data = readCodexConversationBindingDataRecord(event.request.data ?? {});
  if (!data || data.kind !== "codex-app-server-session") {
    return;
  }
  const identity = { kind: "conversation" as const, bindingId: data.bindingId };
  const binding = await options.bindingStore.readAsync(identity);
  assertCodexBindingMayBeReplaced(binding, "clearing a denied conversation binding");
  if (binding && (!data.start?.id || binding.conversationStartId === data.start.id)) {
    await withCodexConversationThreadActivity(identity.bindingId, async () => {
      const { retireCodexConversationThreadBinding } =
        await import("./app-server/thread-ownership.js");
      return retireCodexConversationThreadBinding({
        bindingStore: options.bindingStore,
        identity,
        expectedThreadId: binding.threadId,
        ...(data.start?.id ? { expectedStartId: data.start.id } : {}),
        ...(isIncognitoSessionKey(data.source?.sessionKey) ? { allowUntracked: true } : {}),
      });
    });
  }
}
