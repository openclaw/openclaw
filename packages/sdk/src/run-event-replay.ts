import { mergeChatStreamMessage, recoverTerminalReply } from "@openclaw/gateway-client";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { computeBackoff, sleepWithAbort } from "@openclaw/retry";
import {
  isTerminalRunEvent,
  projectAssistantRunEvent,
  readChatProjection,
  type AssistantProjection,
} from "./chat-projection.js";
import { EventHub } from "./event-hub.js";
import { normalizeGatewayEvent } from "./normalize.js";
import {
  matchesUnsubscribedSession,
  readUnsubscribedSession,
  type ReplaySessionScope,
} from "./replay-scope.js";
import { resolveSdkRunWaitStatus } from "./run-terminal.js";
import {
  readGatewayEventConnectionEpoch,
  readGatewayEventReceipt,
  takeGatewayResponseReceipt,
  type GatewayEventReceipt,
  type GatewayReconnectContext,
} from "./transport.js";
import type { GatewayEvent, OpenClawEvent } from "./types.js";

const MAX_REPLAY_RUNS = 100;
const MAX_REPLAY_EVENTS_PER_RUN = 500;
const MAX_UNAVAILABLE_RECOVERY_OBSERVATIONS = 4;

function recoveryRetryDelay(attempt: number): number {
  const base = computeBackoff({ initialMs: 1_000, maxMs: 25_000, factor: 2, jitter: 0 }, attempt);
  // Match Gateway reconnect's positive 20% spread, including its 25–30s cap
  // interval, without clamping random draws into a synchronized retry spike.
  return Math.ceil(base * (1 + Math.random() * 0.2));
}

type ReplayRun = {
  events: OpenClawEvent[];
  chatMessage?: unknown;
  assistant?: AssistantProjection;
  scope?: ReplaySessionScope;
  textReceipt?: GatewayEventReceipt;
  acceptanceReceipt?: GatewayEventReceipt;
  textRevision: number;
  activityRevision: number;
  unavailableObservations: number;
  recoveryExhausted?: boolean;
  observers: number;
  outstanding: boolean;
  settled?: boolean;
  owned?: boolean;
  canonicalAssistant?: boolean;
  needsRecovery?: boolean;
  recovery?: AbortController;
};

/** Owns normalized event publication, retained run text, and delivery-lifetime retirement. */
export class SdkRunReplay {
  readonly events = new EventHub<OpenClawEvent>();
  private readonly replayByRunId = new Map<string, ReplayRun>();
  private readonly consumedEvents = new WeakSet<GatewayEvent>();
  private replayConnectionEpoch: object | undefined;
  private recoveryContext: GatewayReconnectContext | undefined;
  private recoverySequence = 0;
  private closed = false;
  private streamEnded = false;

  private run(runId: string): ReplayRun {
    let run = this.replayByRunId.get(runId);
    if (!run) {
      run = {
        events: [],
        textRevision: 0,
        activityRevision: 0,
        unavailableObservations: 0,
        observers: 0,
        outstanding: false,
      };
      this.replayByRunId.set(runId, run);
    }
    return run;
  }

  observeRun(runId: string): () => void {
    const run = this.run(runId);
    run.observers++;
    run.outstanding ||= !run.settled && !run.recoveryExhausted;
    if (
      this.recoveryContext?.epoch.current &&
      run.outstanding &&
      run.needsRecovery &&
      (!run.recovery || run.recovery.signal.aborted)
    ) {
      void this.recoverRun(this.recoveryContext, runId, run);
    }
    return () => {
      run.observers--;
      if (run.observers === 0) {
        run.owned = false;
        run.recovery?.abort();
        if (run.recoveryExhausted) {
          delete run.chatMessage;
          delete run.assistant;
        }
      }
      this.trimReplayRuns();
    };
  }

  noteRunAcceptance(params: unknown, response: unknown): void {
    const receipt = takeGatewayResponseReceipt(response);
    if (this.closed || this.streamEnded) {
      return;
    }
    const result = asRecord(response);
    if (
      typeof result.runId !== "string" ||
      !["accepted", "pending", "started", "queued"].includes(String(result.status))
    ) {
      return;
    }
    const request = asRecord(params);
    const run = this.run(result.runId);
    run.owned = true;
    run.unavailableObservations = 0;
    run.recoveryExhausted = false;
    if (receipt) {
      run.acceptanceReceipt = { epoch: receipt.epoch, order: receipt.order };
    }
    run.outstanding ||= !run.settled;
    const key = result.sessionKey ?? request.sessionKey ?? request.key;
    run.scope = {
      ...run.scope,
      ...(typeof key === "string" ? { sessionKey: key } : {}),
      ...(typeof request.agentId === "string" ? { agentId: request.agentId } : {}),
      ...(typeof request.sessionId === "string" ? { sessionId: request.sessionId } : {}),
    };
  }

  publish(event: GatewayEvent): void {
    const connectionEpoch = readGatewayEventConnectionEpoch(event);
    if (connectionEpoch && connectionEpoch !== this.replayConnectionEpoch) {
      this.retireBaselines();
      this.replayConnectionEpoch = connectionEpoch;
    }
    const normalized = this.recordReplayEvent(normalizeGatewayEvent(event));
    this.consumedEvents.add(event);
    this.events.publish(normalized);
  }

  close(): void {
    this.closed = true;
    for (const run of this.replayByRunId.values()) {
      run.recovery?.abort();
    }
    this.events.close();
    this.replayByRunId.clear();
    this.replayConnectionEpoch = undefined;
  }

  private recordReplayEvent(input: OpenClawEvent): OpenClawEvent {
    const runId = input.runId;
    if (!runId) {
      return input;
    }
    let event = input;
    let trimReplayRuns = !this.replayByRunId.has(runId);
    const replay = this.run(runId);
    const projection = readChatProjection(event);
    const assistant = projectAssistantRunEvent(event, replay.assistant);
    if (assistant) {
      replay.canonicalAssistant = true;
      replay.assistant = assistant.assistant;
      event = assistant.event;
    }
    if (projection?.state === "delta") {
      replay.chatMessage = mergeChatStreamMessage(replay.chatMessage, projection.payload);
      if (replay.chatMessage !== undefined) {
        // Retained normalized events keep a baseline even when the raw prefix is
        // evicted. `raw` and rawEvents() still describe the received wire frame.
        event = { ...event, data: { ...projection.payload, message: replay.chatMessage } };
      }
    } else if (projection || isTerminalRunEvent(event)) {
      replay.outstanding = false;
      replay.settled = true;
      replay.needsRecovery = false;
      replay.recovery?.abort();
      delete replay.chatMessage;
      delete replay.assistant;
      this.replayByRunId.delete(runId);
      this.replayByRunId.set(runId, replay);
      trimReplayRuns = true;
    }
    if (projection?.state === "delta" || assistant) {
      replay.textRevision++;
      replay.outstanding ||= !replay.settled;
    }
    if (event.type === "run.started") {
      replay.outstanding = true;
      replay.settled = false;
    }
    if (event.raw && !replay.settled) {
      replay.activityRevision++;
      replay.unavailableObservations = 0;
      replay.recoveryExhausted = false;
      replay.outstanding = true;
    }
    if (event.sessionKey || event.agentId || event.sessionId) {
      replay.scope = {
        sessionKey: event.sessionKey ?? replay.scope?.sessionKey,
        agentId: event.agentId ?? replay.scope?.agentId,
        sessionId: event.sessionId ?? replay.scope?.sessionId,
      };
    }
    if (
      (projection?.state === "delta" && replay.chatMessage !== undefined) ||
      assistant?.assistant
    ) {
      if (event.raw) {
        replay.textReceipt = readGatewayEventReceipt(event.raw);
      }
    }
    const { events } = replay;
    events.push(event);
    if (events.length > MAX_REPLAY_EVENTS_PER_RUN) {
      events.splice(0, events.length - MAX_REPLAY_EVENTS_PER_RUN);
    }
    if (trimReplayRuns) {
      this.trimReplayRuns();
    }
    return event;
  }

  retireBaselines(): void {
    this.replayConnectionEpoch = undefined;
    for (const replay of this.replayByRunId.values()) {
      delete replay.chatMessage;
      delete replay.assistant;
    }
    this.trimReplayRuns();
  }

  endStream(): void {
    this.streamEnded = true;
    this.recoveryContext = undefined;
    for (const run of this.replayByRunId.values()) {
      run.owned = false;
      run.outstanding = false;
      run.needsRecovery = false;
      run.recovery?.abort();
    }
    this.retireBaselines();
  }

  async retireUnsubscribedSession(params: unknown, response: unknown): Promise<void> {
    const subscription = readUnsubscribedSession(params, response);
    if (!subscription) {
      return;
    }
    const receipt = takeGatewayResponseReceipt(response);
    const watermark = receipt?.event;
    await this.consumeThrough(watermark);
    if (receipt?.epoch.current && this.replayConnectionEpoch !== receipt.epoch) {
      this.retireBaselines();
      this.replayConnectionEpoch = receipt.epoch;
    }
    for (const replay of this.replayByRunId.values()) {
      if (!replay.scope || !matchesUnsubscribedSession(replay.scope, subscription)) {
        continue;
      }
      if (
        receipt &&
        [replay.textReceipt, replay.acceptanceReceipt].some(
          (observed) =>
            observed &&
            (observed.epoch === receipt.epoch
              ? observed.order > receipt.order
              : observed.epoch.current || !receipt.epoch.current),
        )
      ) {
        continue;
      }
      delete replay.chatMessage;
      delete replay.assistant;
      if (replay.observers === 0) {
        replay.outstanding = false;
        replay.owned = false;
        replay.needsRecovery = false;
        replay.recovery?.abort();
      }
    }
    this.trimReplayRuns();
  }

  private async consumeThrough(watermark: GatewayEvent | undefined): Promise<void> {
    if (!watermark || this.consumedEvents.has(watermark)) {
      return;
    }
    const events = this.events.stream((event) => event.raw === watermark)[Symbol.asyncIterator]();
    try {
      // Projection failure cannot undo an acknowledged transport transition.
      await events.next().catch(() => undefined);
    } finally {
      await events.return?.();
    }
  }

  async recover(context: GatewayReconnectContext): Promise<void> {
    await this.consumeThrough(context.previousEvent);
    if (this.closed || this.streamEnded || !context.epoch.current) {
      return;
    }
    this.recoveryContext = context;
    for (const run of this.replayByRunId.values()) {
      if (run.outstanding && run.textReceipt?.epoch !== context.epoch) {
        run.needsRecovery = true;
      }
    }
    if (this.replayConnectionEpoch !== context.epoch) {
      this.retireBaselines();
      this.replayConnectionEpoch = context.epoch;
    }
    await Promise.all(
      [...this.replayByRunId].map(async ([runId, run]) => {
        if (run.outstanding && run.needsRecovery && (run.owned || run.observers > 0)) {
          await this.recoverRun(context, runId, run);
        }
      }),
    );
  }

  private recoveryEvent(
    runId: string,
    run: ReplayRun,
    type: OpenClawEvent["type"],
    data: Record<string, unknown>,
  ): void {
    this.events.publish(
      this.recordReplayEvent({
        version: 1,
        id: `recovery:${++this.recoverySequence}:${runId}`,
        ts: Date.now(),
        type,
        runId,
        ...run.scope,
        data,
      }),
    );
  }

  private async rebaselineChat(
    context: GatewayReconnectContext,
    runId: string,
    run: ReplayRun,
    signal: AbortSignal,
    current: () => boolean,
  ): Promise<boolean | undefined> {
    if (!run.scope?.sessionKey) {
      return false;
    }
    const revision = run.textRevision;
    const scope = run.scope;
    let history: Record<string, unknown>;
    try {
      history = asRecord(
        await context.request(
          "chat.history",
          {
            sessionKey: scope.sessionKey,
            ...(scope.agentId ? { agentId: scope.agentId } : {}),
            limit: 1,
          },
          signal,
        ),
      );
    } catch {
      signal.throwIfAborted();
      if (current()) {
        this.recoveryEvent(runId, run, "raw", {
          recovery: { status: "unavailable", reason: "history-request-failed" },
        });
      }
      return undefined;
    }
    if (
      !current() ||
      run.scope?.sessionKey !== scope.sessionKey ||
      run.scope?.agentId !== scope.agentId ||
      (scope.sessionId !== undefined && history.sessionId !== scope.sessionId) ||
      (run.scope?.sessionId !== undefined && history.sessionId !== run.scope.sessionId)
    ) {
      return false;
    }
    const snapshot = asRecord(history.inFlightRun);
    if (snapshot.runId !== runId) {
      const activeRunIds = asRecord(history.sessionInfo).activeRunIds;
      return Array.isArray(activeRunIds) && activeRunIds.includes(runId);
    }
    if (typeof history.sessionId === "string") {
      run.scope = { ...run.scope, sessionId: history.sessionId };
    }
    if (
      run.textRevision === revision &&
      typeof snapshot.text === "string" &&
      !run.canonicalAssistant
    ) {
      run.chatMessage = { role: "assistant", content: [{ type: "text", text: snapshot.text }] };
      run.textRevision++;
      this.recoveryEvent(runId, run, "assistant.delta", {
        text: snapshot.text,
        delta: snapshot.text,
        replace: true,
        recovery: { status: "rebaselined", projection: "chat" },
      });
    }
    return true;
  }

  private async recoverRun(
    context: GatewayReconnectContext,
    runId: string,
    run: ReplayRun,
  ): Promise<void> {
    run.recovery?.abort();
    const recovery = new AbortController();
    run.recovery = recovery;
    const signal = AbortSignal.any([recovery.signal, context.signal]);
    const current = () =>
      !this.closed &&
      !this.streamEnded &&
      context.epoch.current &&
      !signal.aborted &&
      this.replayByRunId.get(runId) === run &&
      run.recovery === recovery &&
      run.outstanding;
    let timeoutMs = 0;
    let reportedUnavailable = false;
    let pendingAttempts = 0;
    try {
      while (current()) {
        const activityRevision = run.activityRevision;
        const result = asRecord(await context.request("agent.wait", { runId, timeoutMs }, signal));
        if (!current()) {
          return;
        }
        if (!["ok", "error", "timeout", "pending"].includes(String(result.status))) {
          this.stopUnavailableRecovery(runId, run, "invalid-wait-response");
          return;
        }
        const status = resolveSdkRunWaitStatus(result);
        if (status !== "accepted") {
          const reply = await recoverTerminalReply({
            runId,
            scope: run.scope ?? {},
            result,
            request: context.request,
            signal,
          });
          if (!current()) {
            return;
          }
          this.recoveryEvent(runId, run, `run.${status}`, {
            ...result,
            phase: status === "failed" ? "error" : "end",
            ...(reply.outputText !== undefined ? { outputText: reply.outputText } : {}),
            recovery: {
              status: reply.unavailable ? "unavailable" : "recovered",
              ...(reply.unavailable ? { reason: reply.unavailable } : {}),
            },
          });
          return;
        }
        const pending = result.status === "pending" || result.pendingError === true;
        const historyActive =
          timeoutMs > 0 && pending
            ? true
            : await this.rebaselineChat(context, runId, run, signal, current);
        if (!current()) {
          return;
        }
        const active =
          pending || historyActive === true || run.activityRevision !== activityRevision;
        if (active) {
          run.unavailableObservations = 0;
        } else if (++run.unavailableObservations >= MAX_UNAVAILABLE_RECOVERY_OBSERVATIONS) {
          this.stopUnavailableRecovery(runId, run, "recovery-exhausted");
          return;
        }
        if (timeoutMs > 0 && !active && !reportedUnavailable) {
          this.recoveryEvent(runId, run, "raw", {
            recovery: { status: "unavailable", reason: "run-state-unavailable" },
          });
          reportedUnavailable = true;
        }
        if (pending || (timeoutMs > 0 && !active)) {
          const attempt = pending
            ? ++pendingAttempts
            : Math.max(1, run.unavailableObservations - 1);
          await sleepWithAbort(recoveryRetryDelay(attempt), signal);
        } else {
          pendingAttempts = 0;
        }
        timeoutMs = 30_000;
      }
    } catch {
      if (current()) {
        this.stopUnavailableRecovery(runId, run, "recovery-request-failed");
      }
    } finally {
      if (run.recovery === recovery) {
        run.recovery = undefined;
        if (run.observers === 0 && context.epoch.current) {
          run.owned = false;
          this.trimReplayRuns();
        }
      }
    }
  }

  private stopUnavailableRecovery(runId: string, run: ReplayRun, reason: string): void {
    run.outstanding = false;
    run.owned = false;
    run.needsRecovery = false;
    run.recoveryExhausted = true;
    if (run.observers === 0) {
      delete run.chatMessage;
      delete run.assistant;
    }
    this.recoveryEvent(runId, run, "raw", { recovery: { status: "unavailable", reason } });
    this.trimReplayRuns();
  }

  private trimReplayRuns(): void {
    if (this.replayByRunId.size <= MAX_REPLAY_RUNS) {
      return;
    }
    let retained = 0;
    // Active baselines cannot be evicted: later wire frames contain only suffixes.
    for (const [runId, candidate] of [...this.replayByRunId].toReversed()) {
      if (
        candidate.chatMessage === undefined &&
        candidate.assistant === undefined &&
        candidate.observers === 0 &&
        !(candidate.owned && candidate.outstanding) &&
        ++retained > MAX_REPLAY_RUNS
      ) {
        candidate.recovery?.abort();
        this.replayByRunId.delete(runId);
      }
    }
  }

  snapshot(runId: string): OpenClawEvent[] {
    return [...(this.replayByRunId.get(runId)?.events ?? [])];
  }
}
