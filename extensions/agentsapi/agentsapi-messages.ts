import type { Turn as SDKTurn } from "openai/resources/beta/agents/sessions/turns";
import { createAgentHarnessAssistantMessage } from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import {
  classifyAgentHarnessTerminalOutcome,
  embeddedAgentLog,
  normalizeUsage,
  type AgentHarnessAttemptParamsV2,
  type AgentHarnessAttemptResult,
  type AgentMessage,
  type NormalizedUsage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { calculateCost, type AssistantMessage } from "openclaw/plugin-sdk/llm";
import type { AgentsApiEvent, AgentsApiItem } from "./agentsapi-client.js";
import { AgentsApiNativeToolProjection } from "./agentsapi-native-tool-projection.js";
import {
  appendAgentsApiTranscriptMessage,
  canRecordAgentsApiTranscriptText,
  iterateAgentsApiTranscriptItems,
  joinTextParts,
  readTextParts,
} from "./agentsapi-transcript.js";

type AgentEvent = Parameters<NonNullable<AgentHarnessAttemptParamsV2["onAgentEvent"]>>[0];
type NativeTurn = SDKTurn | NonNullable<AgentsApiEvent["turn"]>;
type AgentsApiReply = {
  lastAssistant?: AssistantMessage;
  usage?: NormalizedUsage;
  assistantUsage: AssistantMessage["usage"];
};
type NativeTextState = {
  turnId: string;
  item: AgentsApiItem;
  terminal: boolean;
  completionObserved: boolean;
  texts: Map<number, string>;
  summaries: Map<number, string>;
  recoveredPartial: boolean;
  lastCommentary?: { phase: "update" | "end"; text: string };
  lastAssistantText?: string;
};

/** Native identities keep saved-state recovery and live events on the same projection. */
class AgentsApiMessageProjection {
  readonly reply: AgentsApiReply = { assistantUsage: emptyUsage() };
  private readonly items = new Map<string, NativeTextState>();
  private readonly turnByItem = new Map<string, string>();
  private readonly eventIds = new Set<string>();
  private readonly unknownTypes = new Set<string>();
  private readonly usageByTurn = new Map<string, NormalizedUsage>();
  private canonicalUsageRecorded = false;
  private readonly nativeTools: AgentsApiNativeToolProjection;
  private visibleAssistantItemId: string | undefined;
  private reasoningOpen = false;
  private lastReasoningText = "";
  private finalTurnId: string | undefined;
  private classification: AgentHarnessAttemptResult["agentHarnessResultClassification"];
  private timestamp = Date.now();
  private presentationEnabled = true;
  private transcriptOrderingGapReported = false;
  private readonly recordedGatewayCallIds = new Set<string>();

  constructor(
    private readonly params: AgentHarnessAttemptParamsV2,
    private readonly remoteSessionId: string,
    private readonly emitEvent: (event: AgentEvent) => void | Promise<void>,
    private readonly assertCurrent: () => void,
  ) {
    this.nativeTools = new AgentsApiNativeToolProjection(
      params,
      remoteSessionId,
      (event) => this.emit(event),
      assertCurrent,
      () => this.nextTimestamp(),
      () => this.presentationEnabled,
    );
  }

  get toolMetas(): AgentHarnessAttemptResult["toolMetas"] {
    return this.nativeTools.toolMetas;
  }

  get lastToolError(): AgentHarnessAttemptResult["lastToolError"] {
    return this.nativeTools.lastToolError;
  }

  get itemLifecycle(): AgentHarnessAttemptResult["itemLifecycle"] {
    const states = [...this.items.values()];
    const completedCount = states.filter((state) => state.terminal).length;
    const tools = this.nativeTools.itemLifecycle;
    return {
      startedCount: states.length + tools.startedCount,
      completedCount: completedCount + tools.completedCount,
      activeCount: states.length - completedCount + tools.activeCount,
    };
  }

  get hadPotentialSideEffects(): boolean {
    return this.nativeTools.hadPotentialSideEffects;
  }

  get resultClassification(): AgentHarnessAttemptResult["agentHarnessResultClassification"] {
    return this.classification;
  }

  recordUsage(model: AgentHarnessAttemptParamsV2["model"], turns: SDKTurn[]): void {
    const usage = emptyUsage();
    let observed = false;
    let reasoningTokens: number | undefined;
    // Canonical usage replaces observed usage by admitted turn identity. A failed
    // or partial REST read cannot discard terminal-event usage for omitted turns.
    const contributions = new Map(this.usageByTurn);
    for (const turn of new Map(turns.map((record) => [record.id, record])).values()) {
      const normalized = normalizeUsage(turn.usage);
      if (normalized) {
        contributions.set(turn.id, normalized);
      }
    }
    this.canonicalUsageRecorded = true;
    for (const normalized of contributions.values()) {
      observed = true;
      usage.input += normalized.input ?? 0;
      usage.output += normalized.output ?? 0;
      usage.cacheRead += normalized.cacheRead ?? 0;
      usage.cacheWrite += normalized.cacheWrite ?? 0;
      usage.totalTokens +=
        normalized.total ??
        (normalized.input ?? 0) +
          (normalized.output ?? 0) +
          (normalized.cacheRead ?? 0) +
          (normalized.cacheWrite ?? 0);
      if (normalized.reasoningTokens !== undefined) {
        reasoningTokens = (reasoningTokens ?? 0) + normalized.reasoningTokens;
      }
    }
    if (observed) {
      calculateCost(model, usage);
      this.reply.usage = {
        ...normalizeUsage(usage),
        ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
      };
    } else {
      this.reply.usage = { contextUsage: { state: "unavailable" } };
    }
    this.reply.assistantUsage = usage;
  }

  get tokenUsage(): NormalizedUsage | undefined {
    if (this.canonicalUsageRecorded) {
      return this.reply.usage;
    }
    const usage: NormalizedUsage = { contextUsage: { state: "unavailable" } };
    for (const contribution of this.usageByTurn.values()) {
      for (const bucket of [
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "reasoningTokens",
        "total",
      ] as const) {
        const value = contribution[bucket];
        if (value !== undefined) {
          usage[bucket] = (usage[bucket] ?? 0) + value;
        }
      }
    }
    return usage;
  }

  async observe(event: AgentsApiEvent): Promise<void> {
    this.assertCurrent();
    if (this.finalTurnId || (event.event_id && this.eventIds.has(event.event_id))) {
      return;
    }
    if (event.event_id) {
      this.eventIds.add(event.event_id);
      if (this.eventIds.size > 4096) {
        const oldest = this.eventIds.values().next().value;
        if (oldest !== undefined) {
          this.eventIds.delete(oldest);
        }
      }
    }
    if (
      event.turn?.subagent_id === null &&
      [
        "agent.session.turn.completed",
        "agent.session.turn.failed",
        "agent.session.turn.cancelled",
      ].includes(event.type)
    ) {
      this.recordTurnUsage({ ...event.turn, usage: event.usage ?? event.turn.usage });
    }
    if (event.item) {
      const turnId =
        event.item.turn_id ??
        event.turn_id ??
        this.turnByItem.get(event.item.id) ??
        this.nativeTools.resolveTurnId(event.item.id);
      if (!turnId) {
        throw new Error("Agents API output item has no turn identity");
      }
      await this.recordItem(turnId, event.item, event.type === "agent.session.turn.item.done");
      return;
    }
    if (event.type === "agent.output.command_execution_output.delta") {
      await this.nativeTools.observeOutput(event);
      return;
    }
    if (
      event.type === "agent.session.turn.output_text.delta" ||
      event.type === "agent.session.turn.output_text.done" ||
      ((event.type === "agent.session.turn.content_part.added" ||
        event.type === "agent.session.turn.content_part.done") &&
        event.part?.type === "output_text")
    ) {
      const state = this.eventItem(event);
      if (!state || state.terminal) {
        return;
      }
      if (state.recoveredPartial && !event.type.endsWith(".done")) {
        return;
      }
      const index = event.content_index ?? 0;
      state.texts.set(
        index,
        event.type.endsWith(".delta")
          ? (state.texts.get(index) ?? "") + (event.delta ?? "")
          : (event.text ?? event.part?.text ?? ""),
      );
      await this.emitAssistant(state, false, event.delta ?? "");
      return;
    }
    if (event.type.startsWith("agent.session.turn.reasoning_summary_")) {
      const state = this.eventItem(event);
      if (!state || state.terminal) {
        return;
      }
      if (state.recoveredPartial && !event.type.endsWith(".done")) {
        return;
      }
      const index = event.summary_index ?? 0;
      if (event.type.endsWith("text.delta")) {
        state.summaries.set(index, (state.summaries.get(index) ?? "") + (event.delta ?? ""));
      } else if (event.type.endsWith("text.done") || event.type.endsWith("part.done")) {
        state.summaries.set(index, event.text ?? event.part?.text ?? "");
      } else if (event.part?.text) {
        state.summaries.set(index, event.part.text);
      }
      await this.emitReasoning();
      return;
    }
    if (event.type.startsWith("agent.session.environment.")) {
      await this.emitEnvironment(event);
      return;
    }
    if (!INTERNAL_EVENT_TYPES.has(event.type)) {
      this.recordUnknownType(event.type);
    }
  }

  recordGatewayTranscriptReceipt(turnId: string, callId: string): void {
    this.assertCurrent();
    this.recordedGatewayCallIds.add(`${turnId}:${callId}`);
  }

  reportTranscriptOrderingGap(): void {
    this.assertCurrent();
    if (this.transcriptOrderingGapReported) {
      return;
    }
    this.transcriptOrderingGapReported = true;
    embeddedAgentLog.warn(
      "Agents API canonical transcript prefix is unavailable; host input and tool receipts retain their existing placement",
    );
  }

  async reconcile(
    turn: NativeTurn,
    items: AgentsApiItem[],
    options: { presentation?: boolean } = {},
  ): Promise<boolean> {
    this.assertCurrent();
    if (this.finalTurnId) {
      return true;
    }
    const previousPresentation = this.presentationEnabled;
    // Cancellation reconciliation runs only after the stream is retired. It
    // records canonical facts under the original owner, without reopening output.
    this.presentationEnabled = previousPresentation && options.presentation !== false;
    try {
      let transcriptReady = true;
      const terminalTurn = isTerminalTurn(turn.status);
      for (const projected of iterateAgentsApiTranscriptItems(
        turn.id,
        items,
        turn.status,
        terminalTurn,
        this.recordedGatewayCallIds,
        (itemId) => this.items.get(this.identity(turn.id, itemId))?.completionObserved === true,
      )) {
        const { item, terminal } = projected;
        transcriptReady = projected.transcriptReady;
        // Settlement preserves available records even when an earlier native
        // item is unresolved. Their order is explicitly best effort in that case.
        await this.recordItem(
          turn.id,
          item,
          terminal,
          turn.status,
          true,
          transcriptReady || terminalTurn,
        );
      }
      this.recordTurnUsage(turn);
      if (isTerminalTurn(turn.status)) {
        for (const state of this.items.values()) {
          if (state.turnId !== turn.id || state.terminal) {
            continue;
          }
          state.terminal = true;
        }
        const remainingReady = await this.nativeTools.reconcileRemaining(
          turn.id,
          turn.status,
          new Set(items.map((item) => item.id)),
        );
        transcriptReady = remainingReady && transcriptReady;
        if (!transcriptReady) {
          this.reportTranscriptOrderingGap();
        }
      }
      return transcriptReady;
    } finally {
      this.presentationEnabled = previousPresentation;
    }
  }

  async commit(turn: NativeTurn, items: AgentsApiItem[]): Promise<void> {
    this.assertCurrent();
    if (this.finalTurnId) {
      if (this.finalTurnId !== turn.id) {
        throw new Error("Agents API reply was already committed for a different terminal turn");
      }
      return;
    }
    if (!(await this.reconcile(turn, items))) {
      this.reportTranscriptOrderingGap();
    }
    await this.endReasoning();
    const completedMessages = items.filter(
      (item) => item.type === "message" && item.role === "assistant" && item.status === "completed",
    );
    const finalItems = completedMessages.filter((item) => item.phase === "final_answer");
    const visibleItems = finalItems.length
      ? finalItems
      : completedMessages.filter((item) => item.phase !== "commentary");
    const text = visibleItems
      .map(
        (item) =>
          item.content
            ?.filter((part) => part.type === "output_text")
            .map((part) => part.text ?? "")
            .join("") ?? "",
      )
      .join("\n");
    const assistant = createAgentHarnessAssistantMessage(this.attribution(), text, {
      tokenUsage: this.tokenUsage,
      aborted: turn.status === "cancelled",
      promptError: turn.error?.message,
      timestamp: this.nextTimestamp(),
    });
    if (this.canonicalUsageRecorded) {
      assistant.usage = this.reply.assistantUsage;
    } else {
      if (this.usageByTurn.size > 0) {
        calculateCost(this.params.model, assistant.usage);
      }
      this.reply.usage = normalizeUsage(assistant.usage);
      this.reply.assistantUsage = assistant.usage;
    }
    this.classification = classifyAgentHarnessTerminalOutcome({
      assistantTexts: [text],
      reasoningText: this.reasoningText(),
      promptError: turn.error,
      turnCompleted: isTerminalTurn(turn.status),
    });
    if (text) {
      this.reply.lastAssistant = await this.append({
        ...assistant,
        idempotencyKey: `agentsapi:${this.remoteSessionId}:${turn.id}`,
      });
      this.assertCurrent();
      await this.params.onAssistantMessageStart?.();
      this.assertCurrent();
    }
    await this.emitAssistantSnapshot(`agentsapi:${this.remoteSessionId}:${turn.id}:reply`, text);
    if (text) {
      this.assertCurrent();
      await this.params.onPartialReply?.({ text });
      this.assertCurrent();
    }
    this.finalTurnId = turn.id;
  }

  private async recordItem(
    turnId: string,
    item: AgentsApiItem,
    terminal: boolean,
    enclosingStatus?: string,
    canonical = false,
    recordTranscript = true,
  ): Promise<void> {
    if (
      item.type === "function_call" ||
      item.type === "function_call_output" ||
      item.role === "user"
    ) {
      return;
    }
    if (
      await this.nativeTools.recordItem(
        turnId,
        item,
        terminal,
        enclosingStatus,
        canonical,
        recordTranscript,
      )
    ) {
      return;
    }
    if (item.type !== "message" && item.type !== "reasoning") {
      this.recordUnknownType(`item:${item.type}`);
      return;
    }
    const id = this.identity(turnId, item.id);
    let state = this.items.get(id);
    if (state?.terminal && !canonical) {
      return;
    }
    if (!state) {
      state = {
        turnId,
        item,
        terminal: false,
        completionObserved: false,
        texts: new Map(),
        summaries: new Map(),
        recoveredPartial: false,
      };
      this.items.set(id, state);
      this.turnByItem.set(item.id, turnId);
    }
    state.item = item;
    if (!canonical && terminal) {
      state.completionObserved = true;
    }
    // Saved state has no replay cursor. A recovered partial item stays on
    // snapshots until its authoritative completion; new items stream normally.
    if (canonical && !terminal) {
      state.recoveredPartial = true;
    }
    if (item.type === "message" && item.role === "assistant") {
      if (terminal || canonical || state.texts.size === 0) {
        state.texts = readTextParts(item.content, "output_text");
      }
      await this.emitAssistant(state, terminal);
      if (
        canonical &&
        recordTranscript &&
        canRecordAgentsApiTranscriptText(item, enclosingStatus, state.completionObserved) &&
        item.phase === "commentary" &&
        joinTextParts(state.texts)
      ) {
        await this.append({
          ...createAgentHarnessAssistantMessage(this.attribution(), joinTextParts(state.texts), {
            aborted: false,
            timestamp: this.nextTimestamp(),
          }),
          openclawStreamFallback: {
            replacementText: joinTextParts(state.texts),
            source: "segment",
            itemId: id,
          },
          idempotencyKey: `${id}:commentary`,
        });
      }
    } else if (item.type === "reasoning") {
      if (terminal || canonical || state.summaries.size === 0) {
        state.summaries = readTextParts(item.summary, "summary_text");
      }
      await this.emitReasoning();
      if (terminal) {
        const text = joinTextParts(state.summaries);
        if (
          canonical &&
          recordTranscript &&
          canRecordAgentsApiTranscriptText(item, enclosingStatus, state.completionObserved) &&
          text
        ) {
          await this.append({
            ...createAgentHarnessAssistantMessage(this.attribution(), "", {
              aborted: false,
              timestamp: this.nextTimestamp(),
              content: [{ type: "thinking", thinking: text }],
            }),
            idempotencyKey: `${id}:reasoning`,
          });
        }
        await this.endReasoning();
      }
    }
    state.terminal = terminal;
  }

  private async emitAssistant(
    state: NativeTextState,
    terminal: boolean,
    delta = "",
  ): Promise<void> {
    const id = this.identity(state.turnId, state.item.id);
    const text = joinTextParts(state.texts);
    if (state.item.phase === "commentary") {
      const phase = terminal ? "end" : "update";
      if (
        !text.trim() ||
        (state.lastCommentary?.phase === phase && state.lastCommentary.text === text)
      ) {
        return;
      }
      state.lastCommentary = { phase, text };
      await this.emit({
        stream: "item",
        data: {
          itemId: id,
          kind: "preamble",
          title: "Preamble",
          phase,
          progressText: text,
          source: "agentsapi",
        },
      });
      return;
    }
    if (!text || state.lastAssistantText === text) {
      return;
    }
    state.lastAssistantText = text;
    await this.emitAssistantSnapshot(id, text, delta);
  }

  private async emitAssistantSnapshot(itemId: string, text: string, delta = ""): Promise<void> {
    const replace = this.visibleAssistantItemId !== itemId;
    this.visibleAssistantItemId = itemId;
    await this.emit({
      stream: "assistant",
      data: {
        itemId,
        text,
        delta: replace ? "" : delta,
        replaceable: true,
        ...(replace ? { replace: true } : {}),
      },
    });
  }

  private async emitReasoning(): Promise<void> {
    this.assertCurrent();
    if (!this.presentationEnabled) {
      return;
    }
    const text = this.reasoningText();
    if (!text.trim() || text === this.lastReasoningText) {
      return;
    }
    this.lastReasoningText = text;
    this.reasoningOpen = true;
    this.assertCurrent();
    await this.params.onReasoningStream?.({ text, isReasoningSnapshot: true });
    this.assertCurrent();
  }

  private async endReasoning(): Promise<void> {
    if (!this.reasoningOpen) {
      return;
    }
    this.reasoningOpen = false;
    this.assertCurrent();
    if (!this.presentationEnabled) {
      return;
    }
    await this.params.onReasoningEnd?.();
    this.assertCurrent();
  }

  private reasoningText(): string {
    return [...this.items.values()]
      .filter((state) => state.item.type === "reasoning")
      .map((state) => joinTextParts(state.summaries))
      .filter((text) => text.trim())
      .join("\n\n");
  }

  private recordTurnUsage(turn: NativeTurn): void {
    this.assertCurrent();
    if (this.canonicalUsageRecorded) {
      return;
    }
    const usage = normalizeUsage(turn.usage) ?? this.usageByTurn.get(turn.id);
    if (!usage) {
      return;
    }
    this.usageByTurn.set(turn.id, { ...usage, contextUsage: { state: "unavailable" } });
  }

  private async emitEnvironment(event: AgentsApiEvent): Promise<void> {
    const status = event.type.slice("agent.session.environment.".length);
    if (!ENVIRONMENT_TITLES.has(status)) {
      this.recordUnknownType(event.type);
      return;
    }
    await this.emit({
      stream: "item",
      data: {
        itemId: `agentsapi:${this.remoteSessionId}:environment`,
        kind: "environment",
        title: ENVIRONMENT_TITLES.get(status),
        phase: status === "pending" ? "start" : "end",
        ...(status === "disconnected"
          ? { summary: "Connection unavailable" }
          : {
              status:
                status === "failed" ? "failed" : status === "pending" ? "running" : "completed",
            }),
        source: "agentsapi",
      },
    });
  }

  private recordUnknownType(type: string): void {
    const safeType = type.replace(/[^a-zA-Z0-9_.:-]/gu, "?").slice(0, 128);
    if (this.unknownTypes.size >= 20 || this.unknownTypes.has(safeType)) {
      return;
    }
    this.unknownTypes.add(safeType);
    embeddedAgentLog.debug("Agents API projection omitted an unfamiliar native type", {
      type: safeType,
    });
  }

  private eventItem(event: AgentsApiEvent): NativeTextState | undefined {
    if (!event.item_id) {
      throw new Error("Agents API output event has no item identity");
    }
    const turnId = event.turn_id ?? this.turnByItem.get(event.item_id);
    return turnId ? this.items.get(this.identity(turnId, event.item_id)) : undefined;
  }

  private identity(turnId: string, itemId: string): string {
    return `agentsapi:${this.remoteSessionId}:${turnId}:${itemId}`;
  }

  private attribution() {
    return { api: "openai-agents" as const, provider: "openai", modelId: this.params.model.id };
  }

  private nextTimestamp(): number {
    this.timestamp = Math.max(Date.now(), this.timestamp + 1);
    return this.timestamp;
  }

  private async emit(event: AgentEvent): Promise<void> {
    this.assertCurrent();
    if (!this.presentationEnabled) {
      return;
    }
    await this.emitEvent(event);
    this.assertCurrent();
  }

  private append<TMessage extends AgentMessage>(message: TMessage): Promise<TMessage> {
    return appendAgentsApiTranscriptMessage(this.params, message, this.assertCurrent);
  }
}

export function createAgentsApiMessageProjection(
  params: AgentHarnessAttemptParamsV2,
  remoteSessionId: string,
  emitEvent: (event: AgentEvent) => void | Promise<void>,
  assertCurrent: () => void,
) {
  return new AgentsApiMessageProjection(params, remoteSessionId, emitEvent, assertCurrent);
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    // Turn billing sums hosted model calls; it is not a latest-call context snapshot.
    contextUsage: { state: "unavailable" },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function isTerminalTurn(status?: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

const INTERNAL_EVENT_TYPES = new Set([
  "error",
  "agent.session.created",
  "agent.session.idle",
  "agent.session.in_progress",
  "agent.session.requires_action",
  "agent.session.failed",
  "agent.session.error",
  "agent.session.turn.created",
  "agent.session.turn.in_progress",
  "agent.session.turn.completed",
  "agent.session.turn.failed",
  "agent.session.turn.cancelled",
  "agent.session.turn.content_part.added",
  "agent.session.turn.content_part.done",
  // Native delegation remains disabled until child history and settlement exist.
  "agent.session.subagent.active",
  "agent.session.subagent.closed",
  "agent.session.subagent.created",
]);

const ENVIRONMENT_TITLES = new Map([
  ["pending", "Agent environment starting"],
  ["ready", "Agent environment ready"],
  ["connected", "Agent environment connected"],
  ["disconnected", "Agent environment disconnected"],
  ["failed", "Agent environment failed"],
]);
