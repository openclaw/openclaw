import type { claimPendingAgentQuestionAnswer } from "openclaw/plugin-sdk/agent-harness-runtime";

export type CodexInputAuthority = NonNullable<
  Parameters<typeof claimPendingAgentQuestionAnswer>[0]["authority"]
>;

export type CodexServerRequestAdmission = {
  signal: AbortSignal;
  release: () => void;
};

export function isCodexMessageInjectionAvailable(
  state: { completed: boolean; terminalTurnNotificationQueued: boolean },
  signal: AbortSignal,
): boolean {
  return !state.completed && !state.terminalTurnNotificationQueued && !signal.aborted;
}

export function assertCodexSteeringAdmission(
  connection: { assertCurrent: () => void },
  signal: AbortSignal,
  state: {
    completed: boolean;
    terminalTurnNotificationQueued: boolean;
    finalSourceReplyCommit?: unknown;
  },
) {
  connection.assertCurrent();
  signal.throwIfAborted();
  if (state.completed || state.terminalTurnNotificationQueued || state.finalSourceReplyCommit) {
    throw new Error("codex app-server turn is no longer accepting steering");
  }
}

type AdmissionEntry = {
  controller: AbortController;
  preserveOnSeal: boolean;
};

export function assertCodexTerminalReleaseInputAuthority(params: {
  assertCurrent?: () => void;
  assertConnectionCurrent: () => void;
  signal: AbortSignal;
  state: {
    finalSourceReplyCommit?: unknown;
    completed: boolean;
    terminalTurnNotificationQueued: boolean;
  };
}) {
  // The ordinary steering guard rejects the sealed final-source grace state.
  // Revalidate both source lifetimes without reopening steering before an
  // inbound message may interrupt the committed reply.
  params.assertCurrent?.();
  params.assertConnectionCurrent();
  params.signal.throwIfAborted();
  if (
    !params.state.finalSourceReplyCommit ||
    params.state.completed ||
    params.state.terminalTurnNotificationQueued
  ) {
    throw new Error("codex app-server terminal-release grace is no longer active");
  }
}

export async function queueCodexTerminalReleaseInput<T>(
  isInboundUserMessage: boolean,
  assertCurrent: (() => void) | undefined,
  assertConnectionCurrent: () => void,
  signal: AbortSignal,
  state: Parameters<typeof assertCodexTerminalReleaseInputAuthority>[0]["state"],
  interrupt: () => void,
  queue: () => Promise<T>,
): Promise<T> {
  if (isInboundUserMessage) {
    assertCodexTerminalReleaseInputAuthority({
      assertCurrent,
      assertConnectionCurrent,
      signal,
      state,
    });
    interrupt();
  }
  return await queue();
}

/** Owns admission and cancellation for every server request in one Codex turn. */
export function createCodexServerRequestAdmissionController() {
  const turnController = new AbortController();
  const active = new Set<AdmissionEntry>();
  let sealed = false;
  let closed = false;

  const admit = (options?: { preserveOnSeal?: boolean }): CodexServerRequestAdmission => {
    const controller = new AbortController();
    const entry = {
      controller,
      preserveOnSeal: options?.preserveOnSeal === true,
    };
    if (closed) {
      controller.abort("codex_turn_complete");
    } else if (sealed) {
      controller.abort("codex_final_source_reply_committed");
    } else {
      active.add(entry);
    }
    return {
      signal: controller.signal,
      release: () => {
        active.delete(entry);
      },
    };
  };

  const seal = (owner?: CodexServerRequestAdmission) => {
    if (sealed || closed) {
      return;
    }
    sealed = true;
    turnController.abort("codex_final_source_reply_committed");
    for (const { controller, preserveOnSeal } of active) {
      if (controller.signal === owner?.signal) {
        continue;
      }
      if (!preserveOnSeal) {
        controller.abort("codex_final_source_reply_committed");
      }
    }
  };

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    sealed = true;
    turnController.abort("codex_turn_complete");
    for (const { controller } of active) {
      controller.abort("codex_turn_complete");
    }
  };

  return {
    signal: turnController.signal,
    admit,
    close,
    seal,
  };
}
