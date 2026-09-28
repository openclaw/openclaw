/** Emits ACP session updates and mirrors replayable updates into the event ledger. */
import type { AgentSideConnection, PromptRequest, SessionUpdate } from "@agentclientprotocol/sdk";
import { getAvailableCommands } from "./commands.js";
import type { AcpEventLedger, AcpEventLedgerReplay } from "./event-ledger.js";

/** Session identity used when emitting and recording ACP translator updates. */
type AcpTranslatorSessionRef = {
  sessionId: string;
  sessionKey: string;
  ledgerSessionId?: string;
};

type AcpTranslatorLedgerSessionRef = AcpTranslatorSessionRef & {
  cwd: string;
};

type AcpTranslatorSessionUpdatesOptions = {
  connection: Pick<AgentSideConnection, "sessionUpdate">;
  eventLedger: AcpEventLedger;
  log: (message: string) => void;
};

function resolveLedgerSessionId(session: { sessionId: string; ledgerSessionId?: string }): string {
  return session.ledgerSessionId ?? session.sessionId;
}

/** Helper that keeps ACP client updates and replay ledger writes in sync. */
export class AcpTranslatorSessionUpdates {
  private stopped = false;
  // Queue each ledger session at emission time so a detached disconnect notice
  // cannot overtake its older update or block unrelated session settlement.
  private ledgerMutationTails = new Map<string, Promise<void>>();

  constructor(private options: AcpTranslatorSessionUpdatesOptions) {}

  stop(): void {
    this.stopped = true;
  }

  async startLedgerSession(
    session: AcpTranslatorLedgerSessionRef,
    options: { complete: boolean; reset?: boolean },
  ): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      await this.options.eventLedger.startSession({
        sessionId: resolveLedgerSessionId(session),
        sessionKey: session.sessionKey,
        cwd: session.cwd,
        complete: options.complete,
        ...(options.reset ? { reset: true } : {}),
      });
    } catch (err) {
      this.options.log(
        `event ledger session start failed for ${session.sessionId}: ${String(err)}`,
      );
    }
  }

  readLedgerReplay(params: {
    sessionId: string;
    sessionKey: string;
  }): Promise<AcpEventLedgerReplay> {
    return this.readReplay(
      () => this.options.eventLedger.readReplay(params),
      `replay fallback for ${params.sessionId}`,
    );
  }

  readLedgerReplayBySessionId(sessionId: string): Promise<AcpEventLedgerReplay> {
    return this.readReplay(
      () => this.options.eventLedger.readReplayBySessionId({ sessionId }),
      `exact replay fallback for ${sessionId}`,
    );
  }

  readLedgerReplayBySessionKey(sessionKey: string): Promise<AcpEventLedgerReplay> {
    return this.readReplay(
      () => this.options.eventLedger.readReplayBySessionKey({ sessionKey }),
      `session-key replay fallback for ${sessionKey}`,
    );
  }

  private async readReplay(
    read: () => Promise<AcpEventLedgerReplay>,
    failure: string,
  ): Promise<AcpEventLedgerReplay> {
    if (this.stopped) {
      return { complete: false, events: [] };
    }
    try {
      return await read();
    } catch (err) {
      this.options.log(`event ledger ${failure}: ${String(err)}`);
      return { complete: false, events: [] };
    }
  }

  recordUserPrompt(
    session: AcpTranslatorSessionRef,
    runId: string,
    prompt: PromptRequest["prompt"],
  ): Promise<void> {
    return this.recordLedgerMutation(session, "prompt", () =>
      this.options.eventLedger.recordUserPrompt({
        sessionId: resolveLedgerSessionId(session),
        sessionKey: session.sessionKey,
        runId,
        prompt,
      }),
    );
  }

  async emit(params: {
    sessionId: string;
    sessionKey?: string;
    ledgerSessionId?: string;
    runId?: string;
    update: SessionUpdate;
    record?: boolean;
    waitForDelivery?: boolean;
  }): Promise<void> {
    if (this.stopped) {
      return;
    }
    const delivery = this.options.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: params.update,
    });
    const recording =
      params.record && params.sessionKey
        ? this.recordLedgerUpdate({
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            ...(params.ledgerSessionId ? { ledgerSessionId: params.ledgerSessionId } : {}),
            ...(params.runId ? { runId: params.runId } : {}),
            update: params.update,
          })
        : undefined;
    if (params.waitForDelivery === false) {
      void delivery.catch((err: unknown) => {
        this.options.log(`session update delivery failed for ${params.sessionId}: ${String(err)}`);
      });
    } else {
      await delivery;
    }
    await recording;
  }

  async sendAvailableCommands(
    session: AcpTranslatorSessionRef,
    options: { record: boolean },
  ): Promise<void> {
    await this.emit({
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      ...(session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {}),
      record: options.record,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: getAvailableCommands(),
      },
    });
  }

  private recordLedgerUpdate(params: {
    sessionId: string;
    sessionKey: string;
    ledgerSessionId?: string;
    runId?: string;
    update: SessionUpdate;
  }): Promise<void> {
    return this.recordLedgerMutation(params, "update", () =>
      this.options.eventLedger.recordUpdate({
        sessionId: resolveLedgerSessionId(params),
        sessionKey: params.sessionKey,
        ...(params.runId ? { runId: params.runId } : {}),
        update: params.update,
      }),
    );
  }

  private recordLedgerMutation(
    session: AcpTranslatorSessionRef,
    kind: "prompt" | "update",
    mutation: () => Promise<void>,
  ): Promise<void> {
    return this.enqueueLedgerMutation(resolveLedgerSessionId(session), async () => {
      if (this.stopped) {
        return;
      }
      try {
        await mutation();
      } catch (err) {
        this.options.log(
          `event ledger ${kind} record failed for ${session.sessionId}: ${String(err)}`,
        );
        await this.markLedgerIncomplete(session);
      }
    });
  }

  private enqueueLedgerMutation(
    ledgerSessionId: string,
    mutation: () => Promise<void>,
  ): Promise<void> {
    const previous = this.ledgerMutationTails.get(ledgerSessionId) ?? Promise.resolve();
    const pending = previous.then(mutation, mutation);
    const tail = pending.catch(() => {});
    this.ledgerMutationTails.set(ledgerSessionId, tail);
    void tail.then(() => {
      if (this.ledgerMutationTails.get(ledgerSessionId) === tail) {
        this.ledgerMutationTails.delete(ledgerSessionId);
      }
    });
    return pending;
  }

  private async markLedgerIncomplete(session: AcpTranslatorSessionRef): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      await this.options.eventLedger.markIncomplete({
        sessionId: resolveLedgerSessionId(session),
        sessionKey: session.sessionKey,
      });
    } catch (err) {
      this.options.log(
        `event ledger incomplete mark failed for ${session.sessionId}: ${String(err)}`,
      );
    }
  }
}
