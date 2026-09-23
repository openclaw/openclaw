import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AgentPlanStep, AgentPlanStepStatus } from "openclaw/plugin-sdk/channel-outbound";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  readNonNegativeInteger,
  readNullableString,
  splitPlanText,
} from "./event-projector-values.js";
import type { CodexThreadItem, JsonObject } from "./protocol.js";

type ReasoningDeltaMethod = "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta";

type ReasoningItemText = {
  summary: Map<number, string>;
  content: Map<number, string>;
};

type AgentEvent = Parameters<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>[0];
type PlanUpdateSource = "codex-app-server" | "openclaw";
type NativePlanUpdate = { markdown?: string; steps: AgentPlanStep[] };

export class CodexReasoningProjection {
  private readonly reasoningTextByItem = new Map<string, ReasoningItemText>();
  private readonly planTextByItem = new Map<string, string>();
  private turnPlanText: string | undefined;
  private reasoningStarted = false;
  private reasoningEnded = false;

  constructor(
    private readonly params: EmbeddedRunAttemptParams,
    private readonly emitAgentEvent: (event: AgentEvent) => void,
    private readonly onNativePlanUpdate?: (update: NativePlanUpdate) => void | Promise<void>,
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
    const groupIndex =
      method === "item/reasoning/textDelta"
        ? (readNonNegativeInteger(params, "contentIndex") ?? 0)
        : (readNonNegativeInteger(params, "summaryIndex") ?? 0);
    const sections = method === "item/reasoning/textDelta" ? item.content : item.summary;
    sections.set(groupIndex, `${sections.get(groupIndex) ?? ""}${delta}`);
    await this.params.onReasoningStream?.({
      text: this.reasoningText(),
      isReasoningSnapshot: true,
    });
  }

  handlePlanDelta(params: JsonObject): void {
    const itemId = readString(params, "itemId") ?? "plan";
    const delta = readString(params, "delta") ?? "";
    if (!delta) {
      return;
    }
    const text = `${this.planTextByItem.get(itemId) ?? ""}${delta}`;
    this.planTextByItem.set(itemId, text);
    this.emitPlanUpdate({
      explanation: undefined,
      steps: splitPlanText(text).map((step) => ({ step, status: "pending" })),
    });
  }

  async handleTurnPlanUpdated(
    params: JsonObject,
    source: PlanUpdateSource = "codex-app-server",
  ): Promise<void> {
    const explanation = readNullableString(params, "explanation");
    const plan = Array.isArray(params.plan)
      ? params.plan.flatMap((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            return [];
          }
          const record = entry as JsonObject;
          const step = readString(record, "step");
          if (!step) {
            return [];
          }
          return [{ step, status: normalizePlanStepStatus(readString(record, "status")) }];
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

  async recordItem(item: CodexThreadItem | undefined): Promise<void> {
    if (item?.type === "reasoning") {
      const previousText = this.reasoningText();
      // Contributors can suppress deltas; completed sections are authoritative.
      this.reasoningTextByItem.set(item.id, {
        summary: readReasoningSections(item.summary),
        content: readReasoningSections(item.content),
      });
      const text = this.reasoningText();
      if (text !== previousText) {
        this.reasoningStarted = true;
        await this.params.onReasoningStream?.({ text, isReasoningSnapshot: true });
      }
      return;
    }
    if (item?.type === "plan" && typeof item.text === "string" && item.text) {
      this.planTextByItem.set(item.id, item.text);
      this.emitPlanUpdate({
        explanation: undefined,
        steps: splitPlanText(item.text).map((step) => ({ step, status: "pending" })),
      });
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
  const sections = new Map<number, string>();
  if (Array.isArray(value)) {
    value.forEach((text, index) => {
      if (typeof text === "string") {
        sections.set(index, text);
      }
    });
  }
  return sections;
}
