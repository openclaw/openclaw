import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { raceWithAbortSignal } from "../../agent-tools.abort.js";
import { isOpenClawSystemUpdateMessage } from "../../internal-runtime-context.js";
import {
  agentSessionQueuePromptContext,
  agentSessionSetPromptPreparation,
} from "../../sessions/agent-session-prompting.js";
import type { AgentSession } from "../../sessions/index.js";
import type { SystemPromptRefresh } from "./attempt-system-prompt.js";
import type { InitialUserTurnReplayPreparation } from "./pre-persisted-user-turn.js";
import type { RuntimeContextCustomMessage } from "./runtime-context-prompt.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type SystemPromptUpdate = {
  systemPrompt: string;
  update?: RuntimeContextCustomMessage;
  commit?: () => void;
};

export type SystemPromptUpdatePreparation = (
  freshPrompt: string,
  freshlyRendered?: boolean,
) => SystemPromptUpdate | Promise<SystemPromptUpdate>;

/** Owns permission generations and their initial/continuing prompt admission. */
export function installAttemptPermissionPrompt(input: {
  activeSession: AgentSession;
  attempt: Pick<
    EmbeddedRunAttemptParams,
    "pluginRuntimeRefreshPending" | "registerPluginRuntimeRefreshConsumer"
  >;
  runAbortSignal: AbortSignal;
  setActiveSessionSystemPrompt: (systemPrompt: string) => string;
  prepareInitialUserTurnReplay?: InitialUserTurnReplayPreparation;
  prepareSystemPromptUpdate?: SystemPromptUpdatePreparation;
}) {
  const { activeSession, attempt, prepareSystemPromptUpdate, setActiveSessionSystemPrompt } = input;
  let permissionPreparation:
    | { prepare: () => Promise<SystemPromptRefresh>; controller: AbortController }
    | undefined;
  const refreshPermissionPrompt = async (
    prompt?: string,
    signal?: AbortSignal,
    prepareReplay?: InitialUserTurnReplayPreparation,
    deferPromptAdmission = false,
  ) => {
    const runSignal = signal
      ? AbortSignal.any([signal, input.runAbortSignal])
      : input.runAbortSignal;
    while (true) {
      runSignal.throwIfAborted();
      const preparation = permissionPreparation;
      try {
        const preparationSignal = preparation
          ? AbortSignal.any([runSignal, preparation.controller.signal])
          : runSignal;
        const refresh = preparation
          ? await raceWithAbortSignal(preparation.prepare(), preparationSignal)
          : undefined;
        runSignal.throwIfAborted();
        if (preparation !== permissionPreparation) {
          continue;
        }
        let systemPrompt: string | undefined;
        let prepared: SystemPromptUpdate | undefined;
        if (refresh || prepareSystemPromptUpdate) {
          const currentPrompt = prompt ?? activeSession.agent.state.systemPrompt;
          const freshPrompt = refresh ? refresh(currentPrompt) : currentPrompt;
          prepared = prepareSystemPromptUpdate
            ? await prepareSystemPromptUpdate(freshPrompt, refresh?.freshlyRendered === true)
            : undefined;
          runSignal.throwIfAborted();
          if (preparation !== permissionPreparation) {
            continue;
          }
          systemPrompt = prepared?.systemPrompt ?? setActiveSessionSystemPrompt(freshPrompt);
        }
        const admitReplay = prepareReplay
          ? await raceWithAbortSignal(prepareReplay(preparationSignal), preparationSignal)
          : undefined;
        runSignal.throwIfAborted();
        if (preparation !== permissionPreparation) {
          continue;
        }
        const admit = async (onAdmitted: (commit: () => void) => void) => {
          const commit = () => {
            preparationSignal.throwIfAborted();
            if (preparation !== permissionPreparation) {
              throw new Error("Session prompt preparation is stale after permission replacement.");
            }
            if (prepared) {
              prepared.commit?.();
              setActiveSessionSystemPrompt(prepared.systemPrompt);
              if (prepared.update) {
                activeSession[agentSessionQueuePromptContext](prepared.update);
              }
            }
          };
          if (admitReplay) {
            await admitReplay(() => onAdmitted(commit));
          } else {
            onAdmitted(commit);
          }
        };
        if (prepared && !deferPromptAdmission) {
          await admit((commit) => commit());
          return { systemPrompt };
        }
        return { systemPrompt, admitReplay: admit };
      } catch (error) {
        runSignal.throwIfAborted();
        // Replacement wakes this boundary even if the old plugin never settles.
        // Its late rejection cannot fail the newer permission generation.
        if (preparation !== permissionPreparation) {
          continue;
        }
        throw error;
      }
    }
  };
  activeSession[agentSessionSetPromptPreparation](async () => {
    const prepared = await refreshPermissionPrompt(
      undefined,
      undefined,
      input.prepareInitialUserTurnReplay,
      true,
    );
    return async (onAdmitted) => {
      input.runAbortSignal.throwIfAborted();
      if (prepared.admitReplay) {
        await prepared.admitReplay(onAdmitted);
      } else {
        onAdmitted();
      }
    };
  });
  const previousPrepareNextTurn = activeSession.agent.prepareNextTurn;
  const prepareNextTurn: typeof activeSession.agent.prepareNextTurn = async (signal) => {
    if (attempt.pluginRuntimeRefreshPending?.()) {
      return { stop: true };
    }
    const snapshot = await previousPrepareNextTurn?.call(activeSession.agent, signal);
    if (prepareSystemPromptUpdate) {
      return {
        ...snapshot,
        prepareContinuation: async (context) => {
          const inherited = await snapshot?.prepareContinuation?.(context);
          const { systemPrompt } = await refreshPermissionPrompt(
            inherited?.systemPrompt ?? context.systemPrompt,
            signal,
          );
          // Tool results and extension context clear provider facts within one real user turn.
          let runtimeContextCleared = false;
          for (let index = context.messages.length - 1; index >= 0; index--) {
            const message = context.messages[index]!;
            if (message.role === "user") {
              break;
            }
            if (message.role === "toolResult") {
              runtimeContextCleared = true;
            } else if (message.role === "custom" && !message.excludeFromContext) {
              if (!isOpenClawSystemUpdateMessage(message)) {
                runtimeContextCleared = true;
                continue;
              }
              const details = asOptionalRecord(message.details);
              if (details?.kind === "runtime-context" && details.turnScoped === true) {
                if (runtimeContextCleared) {
                  input.runAbortSignal.throwIfAborted();
                  signal?.throwIfAborted();
                  activeSession[agentSessionQueuePromptContext]({
                    ...message,
                    timestamp: Date.now(),
                  });
                }
                break;
              }
            }
          }
          return {
            systemPrompt: systemPrompt ?? inherited?.systemPrompt ?? context.systemPrompt,
            tools: activeSession.agent.state.tools.slice(),
          };
        },
      };
    }
    const { systemPrompt: refreshedPrompt } = await refreshPermissionPrompt(
      snapshot?.context?.systemPrompt,
      signal,
    );
    return snapshot?.context && refreshedPrompt !== undefined
      ? {
          ...snapshot,
          context: {
            ...snapshot.context,
            systemPrompt: refreshedPrompt,
            tools: activeSession.agent.state.tools.slice(),
          },
        }
      : snapshot;
  };
  activeSession.agent.prepareNextTurn = prepareNextTurn;
  attempt.registerPluginRuntimeRefreshConsumer?.(
    () =>
      activeSession.agent.prepareNextTurn === prepareNextTurn &&
      activeSession.agent.state.isStreaming &&
      !input.runAbortSignal.aborted,
  );
  return (prepare?: () => Promise<SystemPromptRefresh>) => {
    const previous = permissionPreparation;
    permissionPreparation = prepare ? { prepare, controller: new AbortController() } : undefined;
    previous?.controller.abort();
  };
}
