/**
 * autonomy-engine.ts — ClaWorks 自主学习机会检测引擎
 *
 * 功能：
 *   detectLearnOpportunities() — 分析最近事件流，检测可供机器人自主学习的信号：
 *     1. Stub 响应（未命中 Playbook 的兜底回复）→ 发布 autonomy.learn_opportunity
 *     2. 高频事件关联模式（时间窗口内同类事件聚合）→ 发布 correlation.pattern_detected
 *   recordFeedback() — 记录用户反馈，负反馈累计超阈值时发布 autonomy.learn_opportunity
 */

import type { ClaworksRuntime } from "../claworks/runtime-types.js";
import type { EvolutionPack, EvolutionSyncManager } from "./evolution-sync.js";
import { createEvolveEngine, hasEvolveLlmBridge, type EvolveEngine } from "./evolve-engine.js";

// ── 公开类型 ──────────────────────────────────────────────────────────────

export type AutonomyLearnOpportunity = {
  /** 触发信号的类型 */
  signal: "stub_response" | "correlation_pattern" | "negative_feedback" | "knowledge_gap";
  description: string;
  detected_at: string;
  metadata?: Record<string, unknown>;
};

export type EvolutionRecordKind = "gap" | "pattern" | "feedback" | "anomaly";

export type AutonomyLearnHandleResult = {
  actions_taken: string[];
  cbr_cases_added: number;
  rules_added: number;
};

// ── 内部辅助 ──────────────────────────────────────────────────────────────

/** 向 CbrStore 添加一条进化观察记录（无 cbrStore 时静默跳过）。 */
function buildEvolutionRecordAdder(
  runtime: ClaworksRuntime,
): (kind: EvolutionRecordKind, description: string) => void {
  return (kind, description) => {
    if (!runtime.cbrStore) {
      return;
    }
    try {
      runtime.cbrStore.add(`evolution:${kind}`, description, {
        type: "evolution_observation",
        kind,
      });
    } catch {
      // non-critical; best-effort
    }
  };
}

// 内存中的负反馈计数（进程内累计，跨重启清零；重要反馈已写入 CBR 持久化）
const _negativeFeedbackCount = new Map<string, number>();
const NEGATIVE_FEEDBACK_THRESHOLD = 3;

function getEvolveEngine(runtime: ClaworksRuntime): EvolveEngine | undefined {
  const rt = runtime as { evolveEngine?: EvolveEngine };
  if (rt.evolveEngine) {
    return rt.evolveEngine;
  }
  if (!hasEvolveLlmBridge(runtime)) {
    return undefined;
  }
  rt.evolveEngine = createEvolveEngine(runtime);
  return rt.evolveEngine;
}

function hasInsufficientCbrCoverage(runtime: ClaworksRuntime, lastInput: string): boolean {
  if (!lastInput) {
    return true;
  }
  if (!runtime.cbrStore) {
    return true;
  }
  const hits = runtime.cbrStore.search(lastInput, 1);
  return hits.length === 0 || hits[0]?.outcome !== "success";
}

// ── 反馈记录 ──────────────────────────────────────────────────────────────

/**
 * 记录用户反馈到进化数据。
 * 负反馈连续累计到 NEGATIVE_FEEDBACK_THRESHOLD 时发布 autonomy.learn_opportunity。
 */
export async function recordFeedback(
  runtime: ClaworksRuntime,
  opts: {
    interactionId?: string;
    input: string;
    intent?: string;
    feedback: "positive" | "negative";
    score?: number;
    note?: string;
  },
): Promise<void> {
  const addEvolutionRecord = buildEvolutionRecordAdder(runtime);
  const key = opts.intent ?? "unknown";

  if (opts.feedback === "negative") {
    const count = (_negativeFeedbackCount.get(key) ?? 0) + 1;
    _negativeFeedbackCount.set(key, count);
    addEvolutionRecord(
      "feedback",
      `负反馈：意图 "${key}" 用户输入 "${opts.input.slice(0, 80)}" | note: ${opts.note ?? ""}`,
    );
    if (count >= NEGATIVE_FEEDBACK_THRESHOLD) {
      _negativeFeedbackCount.set(key, 0); // 重置计数，避免重复报警
      await runtime.kernel.publish("autonomy.learn_opportunity", "autonomy-engine", {
        signal: "negative_feedback",
        description: `意图 "${key}" 连续收到 ${count} 次负反馈，建议优化对应 Playbook/Scaffold`,
        detected_at: new Date().toISOString(),
        metadata: { intent: key, count, last_input: opts.input.slice(0, 200) },
      });
    }
  } else {
    // 正反馈重置计数
    _negativeFeedbackCount.set(key, 0);
  }
}

/**
 * 响应 autonomy.learn_opportunity：自动写入 KB/CBR、尝试在线规则学习，并在知识缺口时触发进化流水线。
 * 无需人工介入即可完成「检测 → 记录 → 轻量修正 → 导出请求」闭环的第一步。
 */
export async function handleAutonomyLearnOpportunity(
  runtime: ClaworksRuntime,
  payload: Record<string, unknown>,
): Promise<AutonomyLearnHandleResult> {
  const actions: string[] = [];
  let cbrCasesAdded = 0;
  let rulesAdded = 0;

  const signal = String(payload.signal ?? "unknown");
  const description = String(payload.description ?? "");
  const metadata = (payload.metadata ?? {}) as Record<string, unknown>;
  const lastInput = metadata.last_input ? String(metadata.last_input).trim() : "";
  const intent = metadata.intent ? String(metadata.intent) : "";
  const gapType = metadata.gap_type ? String(metadata.gap_type) : "";

  const kbLine = `[autonomy:${signal}] ${description}${lastInput ? `\n样本: ${lastInput.slice(0, 200)}` : ""}`;
  try {
    await runtime.kb.ingest(kbLine, { source: "autonomy.learn_handler" });
    actions.push("kb_ingest");
  } catch {
    // non-critical
  }

  if (runtime.cbrStore && description) {
    try {
      runtime.cbrStore.add(description, `pending:${signal}`, {
        type: "autonomy_learn",
        kind: signal,
        tags: gapType ? [gapType] : undefined,
      });
      cbrCasesAdded += 1;
      actions.push("cbr_add");
    } catch {
      // non-critical
    }
  }

  if (lastInput && runtime.cbrStore) {
    const hits = runtime.cbrStore.search(lastInput, 1);
    if (hits.length > 0 && hits[0].outcome === "success") {
      actions.push("cbr_reuse_hint");
      await runtime.kernel.publish("autonomy.cbr_reuse_suggested", "autonomy-learn-handler", {
        signal,
        query: lastInput.slice(0, 200),
        case_id: hits[0].id,
        solution: hits[0].solution,
      });
    }
  }

  const triggerText = lastInput || description.slice(0, 50);
  if (
    triggerText.length >= 4 &&
    runtime.ruleEngine?.addRule &&
    (signal === "negative_feedback" || signal === "stub_response") &&
    intent
  ) {
    const ruleId = `autonomy-learned-${Date.now()}`;
    try {
      runtime.ruleEngine.addRule("im.quick_rules", {
        id: ruleId,
        name: `自治学习：${triggerText.slice(0, 20)}`,
        priority: 850,
        condition: { field: "text", op: "contains", value: triggerText.slice(0, 50) },
        action: {
          kind: "publish_event",
          params: {
            event_type: `im.intent.${intent.replace(/[^a-z0-9_.]/gi, "_")}`,
          },
        },
        stopOnMatch: true,
      });
      rulesAdded += 1;
      actions.push("rule_added");
      await runtime.kernel.publish("learn.rule_added", "autonomy-learn-handler", {
        rule_id: ruleId,
        trigger: triggerText.slice(0, 50),
        intent,
        source: "autonomy_learn",
      });
    } catch {
      // non-critical
    }
  }

  if (signal === "knowledge_gap" || gapType === "intent_classification") {
    await runtime.kernel.publish("evolution.simulation_requested", "autonomy-learn-handler", {
      reason: signal,
      gap_type: gapType || signal,
      description: description.slice(0, 500),
      auto: true,
    });
    actions.push("evolution_simulation_requested");
  }

  const shouldProposeDraft =
    hasEvolveLlmBridge(runtime) &&
    (signal === "knowledge_gap" ||
      ((signal === "stub_response" || signal === "negative_feedback") &&
        hasInsufficientCbrCoverage(runtime, lastInput)));

  if (shouldProposeDraft) {
    const evolveEngine = getEvolveEngine(runtime);
    if (evolveEngine) {
      try {
        await evolveEngine.proposeDraft(
          {
            description: lastInput || description,
            context: [
              `signal=${signal}`,
              intent ? `intent=${intent}` : "",
              gapType ? `gap=${gapType}` : "",
            ]
              .filter(Boolean)
              .join("; "),
          },
          { source: "autonomy.learn_handler", signal },
        );
        actions.push("evolve_draft_proposed");
      } catch {
        // non-critical
      }
    }
  }

  await runtime.kernel.publish("autonomy.learn_handled", "autonomy-learn-handler", {
    signal,
    actions_taken: actions,
    cbr_cases_added: cbrCasesAdded,
    rules_added: rulesAdded,
  });

  return { actions_taken: actions, cbr_cases_added: cbrCasesAdded, rules_added: rulesAdded };
}

// ── 核心检测 ──────────────────────────────────────────────────────────────

/**
 * 检测最近事件流中的自主学习机会，并以副作用形式发布对应事件。
 *
 * 调用方：可在定时任务、Playbook 后处理、或 evolve 闭环中定期触发。
 */
export async function detectLearnOpportunities(runtime: ClaworksRuntime): Promise<void> {
  const kernel = runtime.kernel;
  const addEvolutionRecord = buildEvolutionRecordAdder(runtime);

  // ── 知识缺口检测：24 小时内未解析意图超过阈值 ─────────────────────────────
  // 检测 autonomy.stub_response 和 learn.feedback_recorded(negative) 事件，
  // 统计代表「机器人不知道怎么处理」的信号密度
  const KNOWLEDGE_GAP_WINDOW_MS = 24 * 60 * 60 * 1000;
  const KNOWLEDGE_GAP_THRESHOLD = 5;
  const nowTs = Date.now();

  const recentStubEvents = kernel.getRecentEvents(500, "autonomy.stub_response").filter((e) => {
    const ts = e.ts instanceof Date ? e.ts.getTime() : Number(e.ts);
    return nowTs - ts < KNOWLEDGE_GAP_WINDOW_MS;
  });

  if (recentStubEvents.length >= KNOWLEDGE_GAP_THRESHOLD) {
    const samplePayloads = recentStubEvents
      .slice(0, 3)
      .map((e) => {
        const p = (e.payload ?? {}) as Record<string, unknown>;
        return typeof p.text === "string"
          ? p.text
          : typeof p.input === "string"
            ? p.input
            : e.source;
      })
      .filter(Boolean);

    await kernel.publish("autonomy.learn_opportunity", "autonomy-engine", {
      signal: "knowledge_gap",
      description: `过去 24 小时内检测到 ${recentStubEvents.length} 次未解析意图（兜底回复），建议补充对应 Playbook 或知识库`,
      detected_at: new Date().toISOString(),
      metadata: {
        gap_type: "knowledge_gap",
        count: recentStubEvents.length,
        threshold: KNOWLEDGE_GAP_THRESHOLD,
        sample_inputs: samplePayloads,
        last_input: samplePayloads[0] ? String(samplePayloads[0]) : undefined,
      },
    });
    addEvolutionRecord(
      "gap",
      `知识缺口：24h 内 ${recentStubEvents.length} 次兜底，样本：${samplePayloads.join(" | ")}`,
    );
  }

  // ── 事件关联检测：时间窗口内同类事件聚合 ──────────────────────────────────
  // 5 分钟内同类事件 ≥ CORRELATION_THRESHOLD 次 → 发布 correlation.pattern_detected
  const CORRELATION_WINDOW_MS = 5 * 60 * 1000;
  const CORRELATION_THRESHOLD = 3;
  const now = Date.now();

  const recentEvents = kernel.getRecentEvents(200);
  const windowEvents = recentEvents.filter((e) => {
    const ts = e.ts instanceof Date ? e.ts.getTime() : Number(e.ts);
    return now - ts < CORRELATION_WINDOW_MS;
  });

  // 按 event type 聚合
  const typeCount = new Map<string, number>();
  for (const e of windowEvents) {
    typeCount.set(e.type, (typeCount.get(e.type) ?? 0) + 1);
  }

  for (const [eventType, count] of typeCount.entries()) {
    if (
      count >= CORRELATION_THRESHOLD &&
      !eventType.startsWith("system.") &&
      !eventType.startsWith("autonomy.")
    ) {
      await kernel.publish("correlation.pattern_detected", "autonomy-engine", {
        event_type: eventType,
        count,
        window_ms: CORRELATION_WINDOW_MS,
        window_minutes: CORRELATION_WINDOW_MS / 60000,
        detected_at: new Date().toISOString(),
      });
      addEvolutionRecord(
        "pattern",
        `高频事件模式: ${eventType} 在 ${CORRELATION_WINDOW_MS / 60000} 分钟内出现 ${count} 次`,
      );
    }
  }
}
