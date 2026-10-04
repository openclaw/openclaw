import type { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { sanitizeCompactionReplayMessages } from "../../compaction-replay.js";
import {
  buildAgentRunBlockedUserMessage,
  runBeforeAgentRunGate,
} from "../../harness/before-agent-run.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import { withSessionManagerWrite } from "../../sessions/session-manager-write-admission.js";
import { log } from "../logger.js";
import { sessionMessagesContainIdempotencyKey } from "./pre-persisted-user-turn.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type HookRunner = NonNullable<ReturnType<typeof getGlobalHookRunner>>;
type BeforeAgentRunHookRunner = Pick<HookRunner, "hasHooks" | "runBeforeAgentRun">;
type HookContext = Parameters<HookRunner["runBeforeAgentRun"]>[1];

type BeforeAgentRunSession = {
  messages: AgentMessage[];
  agent: { state: { messages: AgentMessage[] } };
};

type BeforeAgentRunBlockOutcome = {
  blockedBy: string;
  promptError: Error;
};

export async function runEmbeddedAttemptBeforeAgentRun(input: {
  attempt: Pick<
    EmbeddedRunAttemptParams,
    "agentAccountId" | "runId" | "senderId" | "senderIsOwner"
  >;
  activeSession: BeforeAgentRunSession;
  hookContext: HookContext;
  hookMessages: AgentMessage[];
  hookRunner: BeforeAgentRunHookRunner | null;
  modelPrompt: string;
  sessionManager: ReturnType<typeof guardSessionManager>;
  systemPrompt: string;
  withOwnedTranscriptWrite: <T>(operation: () => Promise<T> | T) => Promise<T>;
}): Promise<BeforeAgentRunBlockOutcome | undefined> {
  const block = await runBeforeAgentRunGate(
    input.hookRunner,
    {
      prompt: input.modelPrompt,
      systemPrompt: input.systemPrompt,
      messages: input.hookMessages,
      channelId: input.hookContext.channelId,
      accountId: input.attempt.agentAccountId,
      senderId: input.attempt.senderId ?? undefined,
      senderIsOwner: input.attempt.senderIsOwner,
    },
    input.hookContext,
  );
  if (!block) {
    return undefined;
  }
  const redactedUserMessage = buildAgentRunBlockedUserMessage(input.attempt.runId, block);
  if (
    !sessionMessagesContainIdempotencyKey(
      input.activeSession.messages,
      redactedUserMessage.idempotencyKey,
    )
  ) {
    try {
      await input.withOwnedTranscriptWrite(() =>
        withSessionManagerWrite(input.sessionManager, async () => {
          await input.sessionManager.appendMessageAsync(redactedUserMessage);
          input.sessionManager.flushPendingPersistence();
        }),
      );
      input.activeSession.agent.state.messages = sanitizeCompactionReplayMessages(
        input.sessionManager.buildSessionContext().messages,
      );
    } catch (err) {
      log.warn(
        `before_agent_run block: failed to persist redacted user message: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return { blockedBy: block.blockedBy, promptError: new Error(block.message) };
}
