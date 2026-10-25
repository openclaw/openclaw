import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AgentPlanStep, AgentPlanStepStatus } from "openclaw/plugin-sdk/channel-outbound";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readNullableString } from "./event-projector-values.js";
import type { CodexNativePlan } from "./plan-compaction-state.js";
import { isJsonObject, type CodexThreadItem, type JsonObject } from "./protocol.js";

type ReasoningDeltaMethod = "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta";

type ReasoningItemText = {
  summary: Map<number, string>;
  content: Map<number, string>;
};

type AgentEvent = Parameters<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>[0];
type PlanUpdateSource = "codex-app-server" | "openclaw";

export class CodexReasoningProjection {
  private readonly reasoningTextByItem = new Map<string, ReasoningItemText>();
  private readonly planTextByItem = new Map<string, string>();
  private turnPlanText: string | undefined;
  private reasoningStarted = false;
  private reasoningEnded = false;
  // Rebuilding every section on each delta is quadratic in the reasoning length.
  // Cache the delivered snapshot plus the item that produced it, and extend it
  // only when the section write proves the previous text survived unchanged.
  private lastReasoningText: string | undefined;
  private lastReasoningItemId: string | undefined;

  constructor(
    private readonly params: EmbeddedRunAttemptParams,
    private readonly emitAgentEvent: (event: AgentEvent) => void,
    private readonly onNativePlanUpdate?: (update: CodexNativePlan) => void | Promise<void>,
  ) {}

  async handleReasoningDelta(method: ReasoningDeltaMethod, params: JsonObject): Promise<void> {
    const itemId = readString(params, "itemId") ?? "reasoning";
    const delta = readString(params, "delta") ?? "";
    if (!delta) {
      return;
    }
    this.reasoningStarted = true;
    const item = this.reasoningTextByItem.get(itemId) ?? {
      summary: new Map<number, string>(),
      content: new Map<number, string>(),
    };
    this.reasoningTextByItem.set(itemId, item);
    // Codex indexes reasoning sections independently within an item.
    const index = params[method === "item/reasoning/textDelta" ? "contentIndex" : "summaryIndex"];
    const groupIndex =
      typeof index === "number" && Number.isInteger(index) && index >= 0 ? index : 0;
    const deliveredText = this.extendReasoningText(method, item, groupIndex, delta);
    this.lastReasoningItemId = itemId;
    this.lastReasoningText = deliveredText;
    await this.params.onReasoningStream?.({
      text: deliveredText,
      isReasoningSnapshot: true,
    });
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
      await this.onNativePlanUpdate?.({
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

  /**
   * Applies one delta and returns the delivered reasoning snapshot.
   *
   * `reasoningText()` re-flattens and re-sorts every section, so calling it per
   * delta is quadratic in the reasoning length. Reuse the cached snapshot only
   * when the section write proves the previous text survived unchanged: a stable
   * section index does not imply append-only, because a completed item or a
   * redaction can replace a section wholesale. In that case the snapshot is
   * rebuilt, which also re-establishes the cache for the next delta.
   */
  private extendReasoningText(
    method: ReasoningDeltaMethod,
    item: ReasoningItemText,
    groupIndex: number,
    delta: string,
  ): string {
    const sections = method === "item/reasoning/textDelta" ? item.content : item.summary;
    const previousText = this.lastReasoningText;
    const lastItemId = this.lastReasoningItemId;
    const priorSection = sections.get(groupIndex);
    sections.set(groupIndex, `${priorSection ?? ""}${delta}`);
    // The snapshot joins summary then content per item, each section in index
    // order. A delta extends it in place only when the touched section is the
    // final emitted part — otherwise later content would have to be re-joined.
    if (
      previousText !== undefined &&
      lastItemId !== undefined &&
      sections === item.content &&
      priorSection !== undefined &&
      item.content.size > 0 &&
      groupIndex === Math.max(...item.content.keys()) &&
      this.reasoningTextByItem.get(lastItemId) === item &&
      priorSection.trim().length > 0
    ) {
      return `${previousText}${delta}`;
    }
    return this.reasoningText();
  }

  async recordItem(item: CodexThreadItem | undefined): Promise<void> {
    if (item?.type === "reasoning") {
      const previousText = this.reasoningText();
      // Contributors can suppress deltas; completed sections are authoritative.
      this.reasoningTextByItem.set(item.id, {
        summary: readReasoningSections(item.summary),
        content: readReasoningSections(item.content),
      });
      const text = this.reasoningText();
      this.lastReasoningItemId = item.id;
      this.lastReasoningText = text;
      if (text !== previousText) {
        this.reasoningStarted = true;
        await this.params.onReasoningStream?.({ text, isReasoningSnapshot: true });
      }
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

  reasoningText(): string {
    return [...this.reasoningTextByItem.values()]
      .flatMap(({ summary, content }) => [summary, content])
      .flatMap((sections) => [...sections].toSorted(([left], [right]) => left - right))
      .map(([, text]) => text)
      .filter((text) => text.trim().length > 0)
      .join("\n\n");
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
