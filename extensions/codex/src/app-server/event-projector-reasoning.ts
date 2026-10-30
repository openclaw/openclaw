import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AgentPlanStep, AgentPlanStepStatus } from "openclaw/plugin-sdk/channel-outbound";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createAssistantReasoningMessage } from "./event-projector-assistant-message.js";
import { readNullableString } from "./event-projector-values.js";
import type { CodexNativePlan } from "./plan-compaction-state.js";
import { isJsonObject, type CodexThreadItem, type JsonObject } from "./protocol.js";
import type { CodexTranscriptCheckpointEntry } from "./transcript-checkpoint.js";
import {
  attachCodexAssistantItemIds,
  attachCodexMirrorIdentity,
} from "./upstream-prompt-provenance.js";

type ReasoningDeltaMethod = "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta";

type ReasoningItemText = {
  summary: Map<number, string>;
  content: Map<number, string>;
  timestamp: number;
  completed: boolean;
};

type AgentEvent = Parameters<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>[0];
type PlanUpdateSource = "codex-app-server" | "openclaw";

export class CodexReasoningProjection {
  private readonly reasoningTextByItem = new Map<string, ReasoningItemText>();
  private readonly planTextByItem = new Map<string, string>();
  private turnPlanText: string | undefined;
  private reasoningStarted = false;
  private reasoningEnded = false;

  constructor(
    private readonly params: EmbeddedRunAttemptParams,
    private readonly emitAgentEvent: (event: AgentEvent) => void,
    private readonly options: {
      turnId: string;
      nextTimestamp: () => number;
      checkpointMessage: (entry: CodexTranscriptCheckpointEntry) => void;
      onNativePlanUpdate?: (update: CodexNativePlan) => void | Promise<void>;
    },
  ) {}

  async handleReasoningDelta(method: ReasoningDeltaMethod, params: JsonObject): Promise<void> {
    const itemId = readString(params, "itemId") ?? "reasoning";
    const delta = readString(params, "delta") ?? "";
    if (!delta) {
      return;
    }
    const item = this.ensureReasoningItem(itemId);
    const previousText = reasoningItemText(item);
    // Codex indexes reasoning sections independently within an item.
    const index = params[method === "item/reasoning/textDelta" ? "contentIndex" : "summaryIndex"];
    const groupIndex =
      typeof index === "number" && Number.isInteger(index) && index >= 0 ? index : 0;
    const sections = method === "item/reasoning/textDelta" ? item.content : item.summary;
    sections.set(groupIndex, `${sections.get(groupIndex) ?? ""}${delta}`);
    await this.publishReasoning(itemId, item, previousText);
  }

  handlePlanDelta(params: JsonObject): void {
    const itemId = readString(params, "itemId") ?? "plan";
    const delta = readString(params, "delta") ?? "";
    if (!delta) {
      return;
    }
    this.recordPlanText(itemId, `${this.planTextByItem.get(itemId) ?? ""}${delta}`);
  }

  async handleTurnPlanUpdated(
    params: JsonObject,
    source: PlanUpdateSource = "codex-app-server",
  ): Promise<void> {
    const explanation = readNullableString(params, "explanation");
    const plan = Array.isArray(params.plan)
      ? params.plan.flatMap((entry) => {
          if (!isJsonObject(entry)) {
            return [];
          }
          const step = readString(entry, "step");
          if (!step) {
            return [];
          }
          return [{ step, status: normalizePlanStepStatus(readString(entry, "status")) }];
        })
      : undefined;
    const planText = [
      explanation,
      ...(plan ?? []).map(({ step, status }) => `- [${status}] ${step}`),
    ]
      .filter((part): part is string => Boolean(part))
      .join("\n");
    if (planText) {
      // Structured turn updates are the canonical latest plan for terminal classification.
      this.turnPlanText = planText;
    }
    if (source === "codex-app-server" && plan) {
      await this.options.onNativePlanUpdate?.({
        ...(typeof explanation === "string" ? { markdown: explanation } : {}),
        steps: plan,
      });
    }
    this.emitPlanUpdate(
      {
        explanation,
        ...(params.explanationFormat === "plain" ? { explanationFormat: "plain" as const } : {}),
        steps: plan,
      },
      source,
    );
  }

  async recordItem(item: CodexThreadItem | undefined): Promise<void> {
    if (item?.type === "reasoning") {
      const state = this.ensureReasoningItem(item.id);
      const previousText = reasoningItemText(state);
      // Contributors can suppress deltas; completed sections are authoritative.
      state.summary = readReasoningSections(item.summary);
      state.content = readReasoningSections(item.content);
      if (!state.completed) {
        state.completed = true;
        // An orphaned item after stream recovery must not block tool durability.
        // Partial reasoning is retained by the terminal snapshot instead.
        this.options.checkpointMessage({ read: () => this.reasoningMessage(item.id, state) });
      }
      await this.publishReasoning(item.id, state, previousText);
      return;
    }
    if (item?.type === "plan" && typeof item.text === "string" && item.text) {
      this.recordPlanText(item.id, item.text);
    }
  }

  async maybeEndReasoning(): Promise<void> {
    if (!this.reasoningStarted || this.reasoningEnded) {
      return;
    }
    this.reasoningEnded = true;
    await this.params.onReasoningEnd?.();
  }

  async recordItemStarted(item: CodexThreadItem | undefined): Promise<void> {
    if (item?.type !== "reasoning" || this.reasoningTextByItem.has(item.id)) {
      return;
    }
    const state = this.ensureReasoningItem(item.id);
    state.summary = readReasoningSections(item.summary);
    state.content = readReasoningSections(item.content);
    await this.publishReasoning(item.id, state, "");
  }

  reasoningText(): string {
    return [...this.reasoningTextByItem.values()]
      .map(reasoningItemText)
      .filter(Boolean)
      .join("\n\n");
  }

  collectMessages(completedOnly = false) {
    return [...this.reasoningTextByItem].flatMap(([itemId, item]) => {
      const message =
        !completedOnly || item.completed ? this.reasoningMessage(itemId, item) : undefined;
      return message ? [message] : [];
    });
  }

  private ensureReasoningItem(itemId: string): ReasoningItemText {
    const existing = this.reasoningTextByItem.get(itemId);
    if (existing) {
      return existing;
    }
    const item: ReasoningItemText = {
      summary: new Map(),
      content: new Map(),
      timestamp: this.options.nextTimestamp(),
      completed: false,
    };
    this.reasoningTextByItem.set(itemId, item);
    return item;
  }

  private reasoningMessage(itemId: string, item: ReasoningItemText) {
    const text = reasoningItemText(item);
    return text
      ? attachCodexAssistantItemIds(
          attachCodexMirrorIdentity(
            createAssistantReasoningMessage(this.params, text, item.timestamp),
            `${this.options.turnId}:reasoning:${itemId}`,
          ),
          [itemId],
        )
      : undefined;
  }

  private async publishReasoning(
    itemId: string,
    item: ReasoningItemText,
    previousText: string,
  ): Promise<void> {
    const text = reasoningItemText(item);
    if (text === previousText) {
      return;
    }
    this.reasoningStarted = true;
    // Agent events serve Web chat independently of optional channel callbacks.
    this.emitAgentEvent({
      stream: "thinking",
      data: {
        itemId,
        text,
        delta: text.startsWith(previousText) ? text.slice(previousText.length) : text,
      },
    });
    await this.params.onReasoningStream?.({
      text: this.reasoningText(),
      isReasoningSnapshot: true,
    });
  }

  planText(): string {
    return (
      this.turnPlanText ??
      [...this.planTextByItem.values()].filter((text) => text.trim().length > 0).join("\n\n")
    );
  }

  private recordPlanText(itemId: string, text: string): void {
    this.planTextByItem.set(itemId, text);
    this.emitPlanUpdate({
      steps: text
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/^[-*]\s+/, ""))
        .filter((line) => line.length > 0)
        .map((step) => ({ step, status: "pending" })),
    });
  }

  private emitPlanUpdate(
    params: { explanation?: string | null; explanationFormat?: "plain"; steps?: AgentPlanStep[] },
    source: PlanUpdateSource = "codex-app-server",
  ): void {
    if (!params.explanation && params.steps === undefined) {
      return;
    }
    this.emitAgentEvent({
      stream: "plan",
      data: {
        phase: "update",
        title: "Plan updated",
        source,
        ...(params.explanation ? { explanation: params.explanation } : {}),
        ...(params.explanationFormat ? { explanationFormat: params.explanationFormat } : {}),
        ...(params.steps ? { steps: params.steps } : {}),
      },
    });
  }
}

function normalizePlanStepStatus(status: string | undefined): AgentPlanStepStatus {
  if (status === "inProgress" || status === "in_progress") {
    return "in_progress";
  }
  return status === "completed" ? "completed" : "pending";
}

function readReasoningSections(value: unknown): Map<number, string> {
  return new Map(
    Array.isArray(value)
      ? value.flatMap<[number, string]>((text, index) =>
          typeof text === "string" ? [[index, text]] : [],
        )
      : [],
  );
}

function reasoningItemText({ summary, content }: ReasoningItemText): string {
  return [summary, content]
    .flatMap((sections) => [...sections].toSorted(([left], [right]) => left - right))
    .map(([, text]) => text)
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
}
