import type { AgentSideConnection, PromptRequest, SessionUpdate } from "@agentclientprotocol/sdk";
import { THINKING_LEVELS_HELP } from "../auto-reply/thinking.shared.js";
import { enqueueKeyedTask } from "../plugin-sdk/keyed-async-queue.js";
import { createPendingPromiseTracker } from "../shared/pending-promises.js";
import type { AcpEventLedger, AcpEventLedgerReplay } from "./event-ledger.js";

const AVAILABLE_COMMANDS = [
  { name: "help", description: "Show help and common commands." },
  { name: "commands", description: "List available commands." },
  { name: "status", description: "Show current status." },
  {
    name: "context",
    description: "Explain context usage (list|detail|json).",
    input: { hint: "list | detail | json" },
  },
  { name: "whoami", description: "Show sender id (alias: /id)." },
  { name: "id", description: "Alias for /whoami." },
  { name: "subagents", description: "List or manage sub-agents." },
  { name: "config", description: "Read or write config (owner-only)." },
  { name: "debug", description: "Set runtime-only overrides (owner-only)." },
  {
    name: "usage",
    description:
      "Toggle usage footer (off|tokens|full|reset). 'reset'/'inherit'/'clear'/'default' clears the session override to re-inherit the configured default.",
  },
  { name: "stop", description: "Stop the current run." },
  { name: "restart", description: "Restart the gateway (if enabled)." },
  { name: "activation", description: "Set group activation (mention|always)." },
  { name: "send", description: "Set send mode (on|off|inherit)." },
  { name: "reset", description: "Reset the session (/new)." },
  { name: "new", description: "Reset the session (/reset)." },
  {
    name: "think",
    description: `Set thinking level (${THINKING_LEVELS_HELP}).`,
  },
  { name: "verbose", description: "Set verbose mode (on|full|off)." },
  { name: "trace", description: "Set plugin trace mode (on|off)." },
  { name: "reasoning", description: "Toggle reasoning output (on|off|stream)." },
  { name: "elevated", description: "Toggle elevated mode (on|off)." },
  { name: "model", description: "Select a model (list|status|<name>)." },
  { name: "queue", description: "Adjust queue mode and options." },
  { name: "bash", description: "Run a host command (if enabled)." },
  { name: "compact", description: "Compact the session history." },
];

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

export class AcpTranslatorSessionUpdates {
  private stopped = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly track = createPendingPromiseTracker(this.pending);
  // Queue each ledger session at emission time so a detached disconnect notice
  // cannot overtake its older update or block unrelated session settlement.
  private ledgerMutationTails = new Map<string, Promise<void>>();

  constructor(private options: AcpTranslatorSessionUpdatesOptions) {}

  async stop(): Promise<void> {
    this.stopped = true;
    // Revoking admission cannot retire the database or transport while an
    // already-admitted ledger write, replay read, or delivery still uses it.
    await Promise.allSettled([...this.pending, ...this.ledgerMutationTails.values()]);
  }

  async startLedgerSession(
    session: AcpTranslatorLedgerSessionRef,
    options: { complete: boolean; reset?: boolean },
  ): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      await this.track(
        this.options.eventLedger.startSession({
          sessionId: resolveLedgerSessionId(session),
          sessionKey: session.sessionKey,
          cwd: session.cwd,
          complete: options.complete,
          ...(options.reset ? { reset: true } : {}),
        }),
      );
    } catch (err) {
      this.options.log(
        `event ledger session start failed for ${session.sessionId}: ${String(err)}`,
      );
    }
  }

  async readLedgerSessionKey(sessionId: string): Promise<string | undefined> {
    if (this.stopped) {
      return undefined;
    }
    try {
      return await this.track(this.options.eventLedger.readSessionKey({ sessionId }));
    } catch (err) {
      this.options.log(`event ledger session-key lookup failed for ${sessionId}: ${String(err)}`);
      return undefined;
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
      return await this.track(read());
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
    const delivery = this.track(
      this.options.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: params.update,
      }),
    );
    let recording: Promise<void> | undefined;
    if (params.record && params.sessionKey) {
      const ledgerUpdate = {
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        ...(params.ledgerSessionId ? { ledgerSessionId: params.ledgerSessionId } : {}),
        ...(params.runId ? { runId: params.runId } : {}),
        update: params.update,
      };
      recording = this.recordLedgerMutation(ledgerUpdate, "update", () =>
        this.options.eventLedger.recordUpdate({
          sessionId: resolveLedgerSessionId(ledgerUpdate),
          sessionKey: ledgerUpdate.sessionKey,
          ...(ledgerUpdate.runId ? { runId: ledgerUpdate.runId } : {}),
          update: ledgerUpdate.update,
        }),
      );
    }
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
        availableCommands: AVAILABLE_COMMANDS,
      },
    });
  }

  private recordLedgerMutation(
    session: AcpTranslatorSessionRef,
    kind: "prompt" | "update",
    mutation: () => Promise<void>,
  ): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    // Shutdown blocks new work, but already-queued mutations must still settle.
    const ledgerSessionId = resolveLedgerSessionId(session);
    return enqueueKeyedTask({
      tails: this.ledgerMutationTails,
      key: ledgerSessionId,
      task: async () => {
        try {
          await mutation();
        } catch (err) {
          this.options.log(
            `event ledger ${kind} record failed for ${session.sessionId}: ${String(err)}`,
          );
          await this.markLedgerIncomplete(session);
        }
      },
    });
  }

  private async markLedgerIncomplete(session: AcpTranslatorSessionRef): Promise<void> {
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
