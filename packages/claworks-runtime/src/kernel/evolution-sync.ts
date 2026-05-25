/**
 * evolution-sync.ts — ClaWorks 离线进化同步管道
 *
 * 架构：
 *
 *   私域机器人（无互联网）          互联网机器人/工作站
 *        │                              │
 *   积累交互数据                    商业模型 API
 *   失败的 Playbook                     │
 *   低置信度意图                   处理生成改进包
 *   HITL 记录                       ├── 优化的 Playbook YAML
 *   用户反馈                         ├── 新的决策表
 *        │                           ├── 改进的提示词模板
 *   exportEvolutionData()            ├── few-shot 示例
 *        │                           └── 知识库条目
 *        └────── USB/文件 ──────────→ generate-evolution-pack.ts
 *                                        │
 *                     ←──── 导入 ────────┘
 *                     importEvolutionPack()
 *                     （无需商业模型即可使用改进成果）
 */

import { createHash } from "node:crypto";
import type { ClaworksRuntime } from "../claworks/runtime-types.js";
import { parsePlaybookYaml } from "../pack-loader/yaml-parsers.js";
import type { CbrCase } from "../planes/data/cbr-store.js";
import {
  deletePendingSandboxPromotion,
  loadPendingSandboxPromotions,
  savePendingSandboxPromotion,
} from "./evolution-pending-store.js";

// ── 导出数据结构 ───────────────────────────────────────────────────────────

export interface EvolutionExportData {
  version: "1.0";
  exported_at: string;
  robot_id: string;
  /** 近期失败的 Playbook 执行（已脱敏，不含用户消息内容） */
  failed_executions: Array<{
    playbook_id: string;
    trigger_type: string;
    error_type: string;
    step_reached: string;
    timestamp: string;
  }>;
  /** 低置信度意图样本（文本已哈希保护隐私） */
  low_confidence_intents: Array<{
    text_hash: string;
    text_preview: string;
    classified_intent: string;
    confidence: number;
    actual_outcome?: string;
    timestamp: string;
  }>;
  /** HITL 人工决策记录 */
  hitl_decisions: Array<{
    context_type: string;
    decision: "approved" | "rejected" | "modified";
    modification_hint?: string;
    timestamp: string;
  }>;
  /** 用户反馈记录（正面/负面） */
  feedback_records: Array<{
    interaction_type: string;
    feedback_score: number;
    feedback_hint?: string;
    timestamp: string;
  }>;
  /** 当前 Playbook 清单（供外部生成改进版本） */
  playbook_manifest: Array<{
    id: string;
    trigger_pattern: string;
    step_count: number;
    success_rate?: number;
  }>;
  /** 当前规则表名称列表 */
  rule_table_names: string[];
  /** 当前提示词模板名称列表 */
  prompt_template_names: string[];
}

// ── 进化包结构 ─────────────────────────────────────────────────────────────

export interface EvolutionPack {
  version: string;
  generated_at: string;
  /** 生成本包的模型标识（如 "claude-sonnet-4-5"、"gpt-4o"） */
  generated_by: string;
  source_robot_id: string;
  /** 改进或新增的 Playbook 定义（已解析的 YAML 内容） */
  improved_playbooks?: Array<{
    id: string;
    name?: string;
    [key: string]: unknown;
  }>;
  /** 更新后的规则决策表 */
  updated_rule_tables?: Array<{
    name: string;
    [key: string]: unknown;
  }>;
  /** 改进的提示词模板 */
  improved_prompt_templates?: Array<{
    id: string;
    template: string;
    description?: string;
  }>;
  /** 新增的知识库条目 */
  kb_additions?: Array<{
    id: string;
    content: string;
    source?: string;
    [key: string]: unknown;
  }>;
  /** 本次进化包的改进说明（给运维人员看） */
  summary: string;
}

// ── 导入结果 ───────────────────────────────────────────────────────────────

export interface ImportEvolutionPackOptions {
  /** 仅加载到沙盒并跑回归，不写入生产 Pack */
  sandbox?: boolean;
  /** sandbox 别名 */
  simulate_only?: boolean;
}

export interface ImportResult {
  success: boolean;
  applied: string[];
  errors?: string[];
  sandbox?: boolean;
  simulation_results?: Array<{ playbook_id: string; passed: boolean; error?: string }>;
  pending_promotion?: boolean;
}

// ── 进化历史记录 ──────────────────────────────────────────────────────────

export interface EvolutionHistoryEntry {
  pack_version: string;
  pack_generated_at: string;
  imported_at: string;
  improvements: number;
  summary: string;
}

export interface PendingSandboxPromotion {
  promotion_id: string;
  pack: EvolutionPack;
  playbook_ids: string[];
  simulation_results: Array<{ playbook_id: string; passed: boolean; error?: string }>;
  registered_at: string;
}

export type PromoteSandboxOptions = {
  promotion_id: string;
  /** 必须为 true 才会写入生产 Pack；fail-closed */
  approved: boolean;
  source?: string;
};

export type PromoteSandboxResult =
  | { status: "approval_required"; promotion_id: string; message: string }
  | { status: "not_found"; promotion_id: string }
  | { status: "promoted"; promotion_id: string; import: ImportResult }
  | { status: "promotion_failed"; promotion_id: string; import: ImportResult };

/** 沙盒待晋升包 ID（version + generated_at） */
export function buildSandboxPromotionId(pack: EvolutionPack): string {
  return `sandbox-${pack.version}-${createHash("sha256").update(pack.generated_at).digest("hex").slice(0, 12)}`;
}

// ── EvolutionSyncManager ──────────────────────────────────────────────────

export class EvolutionSyncManager {
  /** 内存中保存的导入历史（重启后丢失；可用 DB 持久化） */
  private history: EvolutionHistoryEntry[] = [];
  /** 沙盒回归通过后待 HITL 晋升的进化包（重启后丢失） */
  private pendingSandboxPromotions = new Map<string, PendingSandboxPromotion>();

  constructor(private readonly runtime: ClaworksRuntime) {
    this.loadPendingPromotionsFromDb();
  }

  /** 从 SQLite 恢复待 HITL 晋升的沙盒包（重启后调用） */
  loadPendingPromotionsFromDb(): void {
    try {
      const rows = loadPendingSandboxPromotions(this.runtime.db);
      this.pendingSandboxPromotions.clear();
      for (const row of rows) {
        this.pendingSandboxPromotions.set(row.promotion_id, row);
      }
    } catch {
      // DB 不可用时保持内存为空，不阻断运行时
    }
  }

  /**
   * 导出进化数据包（可安全传输到互联网机器，不含敏感原文）。
   * days：收集最近多少天的数据，默认 30 天。
   */
  async exportEvolutionData(days = 30): Promise<EvolutionExportData> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const playbookStats = this.collectPlaybookStats();
    const hitlDecisions = this.loadHitlDecisions(since);
    const feedbackRecords = this.loadFeedbackRecords();
    const lowConfidenceIntents = this.loadLowConfidenceIntents();

    const ruleTableNames = this.collectRuleTableNames();
    const promptTemplateNames = this.collectPromptTemplateNames();

    const robotId = this.getRobotId();

    return {
      version: "1.0",
      exported_at: new Date().toISOString(),
      robot_id: robotId,
      failed_executions: playbookStats.failures,
      low_confidence_intents: lowConfidenceIntents,
      hitl_decisions: hitlDecisions,
      feedback_records: feedbackRecords,
      playbook_manifest: playbookStats.manifest,
      rule_table_names: ruleTableNames,
      prompt_template_names: promptTemplateNames,
    };
  }

  /**
   * 导入进化包（由外部商业模型处理生成后返还给私域机器人）。
   * 支持热更新 Playbook、规则表、提示词模板、KB 条目。
   * sandbox / simulate_only：仅沙盒加载 + PlaybookSimulator 回归，通过后发布 HITL 晋升事件。
   */
  async importEvolutionPack(
    pack: EvolutionPack,
    opts?: ImportEvolutionPackOptions,
  ): Promise<ImportResult> {
    if (opts?.sandbox === true || opts?.simulate_only === true) {
      return this.importEvolutionPackSandbox(pack);
    }

    return this.importEvolutionPackProduction(pack);
  }

  /** 生产导入：热更新 Playbook / 规则 / 模板 / KB */
  private async importEvolutionPackProduction(pack: EvolutionPack): Promise<ImportResult> {
    const applied: string[] = [];
    const errors: string[] = [];

    // 1. 更新/新增 Playbook（通过 evolveEngine.deploy 热重载）
    for (const playbook of pack.improved_playbooks ?? []) {
      try {
        const yamlContent = this.serializePlaybookToYaml(playbook);
        const evolveEngine = (this.runtime as { evolveEngine?: unknown }).evolveEngine as
          | { deploy?: (p: unknown, opts?: unknown) => Promise<unknown> }
          | undefined;
        if (evolveEngine?.deploy) {
          await evolveEngine.deploy({ id: playbook.id, playbook_yaml: yamlContent, confidence: 1 });
        } else {
          const pb = this.runtime.playbookEngine;
          const source = `evolution-pack:${pack.source_robot_id}`;
          const pbExt = pb as typeof pb & {
            loadFromYaml?: (yaml: string, src: string) => Promise<void>;
          };
          if (typeof pbExt.load === "function") {
            const playbookDef = parsePlaybookYaml(yamlContent, source);
            pbExt.load(playbookDef);
          } else if (typeof pbExt.loadFromYaml === "function") {
            await pbExt.loadFromYaml(yamlContent, source);
          } else {
            throw new Error("playbookEngine.load / loadFromYaml 不可用");
          }
        }
        applied.push(`Playbook 已更新: ${playbook.id}`);
      } catch (err) {
        errors.push(
          `Playbook ${playbook.id} 导入失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 2. 更新规则决策表
    for (const table of pack.updated_rule_tables ?? []) {
      try {
        const ruleEngine = this.runtime.ruleEngine as
          | (typeof this.runtime.ruleEngine & { loadTable?: (t: unknown) => void })
          | undefined;
        if (ruleEngine?.registerTable) {
          ruleEngine.registerTable(table as import("./rule-engine.js").DecisionTable);
          applied.push(`规则表已更新: ${table.name}`);
        } else if (typeof ruleEngine?.loadTable === "function") {
          ruleEngine.loadTable(table);
          applied.push(`规则表已更新: ${table.name}`);
        } else {
          errors.push(`规则表 ${table.name} 跳过: ruleEngine 无 registerTable/loadTable`);
        }
      } catch (err) {
        errors.push(
          `规则表 ${table.name} 导入失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 3. 更新提示词模板
    for (const template of pack.improved_prompt_templates ?? []) {
      try {
        const registry = this.runtime.promptRegistry;
        if (registry) {
          registry.register(template.id, template.template, template.description);
          applied.push(`提示词模板已更新: ${template.id}`);
        } else {
          errors.push(`模板 ${template.id} 跳过: promptRegistry 未注入`);
        }
      } catch (err) {
        errors.push(
          `模板 ${template.id} 导入失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 4. 新增知识库条目
    for (const kbItem of pack.kb_additions ?? []) {
      try {
        await this.runtime.kb.ingest(kbItem.content, {
          source: kbItem.source ?? `evolution-pack:${pack.source_robot_id}`,
        });
        applied.push(`KB 新增: ${kbItem.id}`);
      } catch (err) {
        errors.push(
          `KB ${kbItem.id} 导入失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 5. 记录导入历史
    const entry: EvolutionHistoryEntry = {
      pack_version: pack.version,
      pack_generated_at: pack.generated_at,
      imported_at: new Date().toISOString(),
      improvements: applied.length,
      summary: pack.summary,
    };
    this.history.push(entry);

    // 6. 发布进化事件
    await this.runtime.kernel
      .publish("evolution.pack_imported", "evolution-sync", {
        pack_version: pack.version,
        pack_generated_at: pack.generated_at,
        generated_by: pack.generated_by,
        improvements: applied.length,
        errors: errors.length,
      })
      .catch(() => undefined);

    return {
      success: errors.length === 0,
      applied,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  /**
   * 沙盒导入：Playbook 仅 load 到运行时（source 标记 sandbox），跑干跑回归；
   * 全部通过后发布 evolution.sandbox_ready_for_promotion，等待人工晋升。
   */
  private async importEvolutionPackSandbox(pack: EvolutionPack): Promise<ImportResult> {
    const applied: string[] = [];
    const errors: string[] = [];
    const playbookIds: string[] = [];
    const source = `sandbox-evolution:${pack.source_robot_id}`;

    for (const playbook of pack.improved_playbooks ?? []) {
      try {
        const yamlContent = this.serializePlaybookToYaml(playbook);
        const pb = this.runtime.playbookEngine;
        const pbExt = pb as typeof pb & {
          loadFromYaml?: (yaml: string, src: string) => Promise<void>;
        };
        const playbookDef = parsePlaybookYaml(yamlContent, source);
        if (typeof pbExt.load === "function") {
          pbExt.load(playbookDef);
        } else if (typeof pbExt.loadFromYaml === "function") {
          await pbExt.loadFromYaml(yamlContent, source);
        } else {
          throw new Error("playbookEngine.load / loadFromYaml 不可用");
        }
        playbookIds.push(playbook.id);
        applied.push(`[sandbox] Playbook 已加载: ${playbook.id}`);
      } catch (err) {
        errors.push(
          `[sandbox] Playbook ${playbook.id} 加载失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const simulation_results =
      playbookIds.length > 0 ? await this.runSandboxRegression(playbookIds) : [];
    const regressionPassed =
      playbookIds.length === 0 ||
      (simulation_results.length > 0 && simulation_results.every((r) => r.passed));
    const success = errors.length === 0 && regressionPassed;

    const entry: EvolutionHistoryEntry = {
      pack_version: pack.version,
      pack_generated_at: pack.generated_at,
      imported_at: new Date().toISOString(),
      improvements: applied.length,
      summary: `[sandbox] ${pack.summary}`,
    };
    this.history.push(entry);

    await this.runtime.kernel
      .publish("evolution.sandbox_imported", "evolution-sync", {
        pack_version: pack.version,
        pack_generated_at: pack.generated_at,
        generated_by: pack.generated_by,
        playbook_ids: playbookIds,
        simulation_results,
        regression_passed: regressionPassed,
        errors: errors.length,
      })
      .catch(() => undefined);

    if (regressionPassed && playbookIds.length > 0) {
      const promotion_id = buildSandboxPromotionId(pack);
      this.pendingSandboxPromotions.set(promotion_id, {
        promotion_id,
        pack,
        playbook_ids: playbookIds,
        simulation_results,
        registered_at: new Date().toISOString(),
      });
      try {
        savePendingSandboxPromotion(
          this.runtime.db,
          this.pendingSandboxPromotions.get(promotion_id)!,
        );
      } catch {
        // 持久化失败不阻断沙盒导入
      }

      await this.runtime.kernel
        .publish("evolution.sandbox_ready_for_promotion", "evolution-sync", {
          promotion_id,
          pack_version: pack.version,
          pack_generated_at: pack.generated_at,
          generated_by: pack.generated_by,
          source_robot_id: pack.source_robot_id,
          playbook_ids: playbookIds,
          simulation_results,
          summary: pack.summary,
          hitl_required: true,
        })
        .catch(() => undefined);

      await this.runtime.kernel
        .publish("hitl.approval_requested", "evolution-sync", {
          gate_id: promotion_id,
          message: [
            `沙盒进化包 ${pack.version} 回归已通过，是否晋升到生产？`,
            `Playbooks: ${playbookIds.join(", ")}`,
            `调用 evolution.promote_sandbox 并传 approved=true 确认。`,
          ].join("\n"),
          promotion_id,
          playbook_ids: playbookIds,
        })
        .catch(() => undefined);
    }

    return {
      success,
      applied,
      errors: errors.length > 0 ? errors : undefined,
      sandbox: true,
      simulation_results,
      pending_promotion: regressionPassed && playbookIds.length > 0,
    };
  }

  private async runSandboxRegression(
    playbookIds: string[],
  ): Promise<Array<{ playbook_id: string; passed: boolean; error?: string }>> {
    const { createPlaybookSimulator } = await import("../planes/orch/playbook-simulator.js");
    const playbookEngine = this.runtime.playbookEngine;

    const simulator = createPlaybookSimulator(async (pid, initVars, trigEvent, mockStore) => {
      const steps: import("../planes/orch/playbook-simulator.js").SimulateStepLog[] = [];
      if (!playbookEngine?.trigger) {
        return { steps, error: "playbookEngine.trigger 不可用" };
      }
      try {
        const run = await playbookEngine.trigger(
          pid,
          typeof trigEvent === "object" && trigEvent !== null && !Array.isArray(trigEvent)
            ? (trigEvent as Record<string, unknown>)
            : {},
          {
            variables: { ...initVars, _simulate: true, _sandbox: true },
          },
        );
        if (run?.steps) {
          for (let i = 0; i < run.steps.length; i++) {
            const s = run.steps[i]!;
            const durationMs =
              s.completedAt && s.startedAt ? s.completedAt.getTime() - s.startedAt.getTime() : 0;
            steps.push({
              step: i,
              type: s.stepId,
              name: s.stepId,
              status: s.status === "failed" ? "error" : "ok",
              durationMs,
              output: s.output,
              error: s.error,
            });
          }
        }
        return { steps, error: run.error };
      } catch (e) {
        return { steps, error: String(e) };
      }
    });

    const results: Array<{ playbook_id: string; passed: boolean; error?: string }> = [];
    for (const playbookId of playbookIds) {
      const result = await simulator.simulate(
        playbookId,
        { _sandbox: true },
        { type: `sandbox.regression.${playbookId}` },
      );
      results.push({
        playbook_id: playbookId,
        passed: result.status === "ok",
        error: result.error,
      });
    }
    return results;
  }

  /** 列出待 HITL 晋升的沙盒进化包 */
  listPendingSandboxPromotions(): PendingSandboxPromotion[] {
    return [...this.pendingSandboxPromotions.values()];
  }

  /**
   * 将沙盒进化包晋升到生产 Pack 路径。
   * fail-closed：approved 不为 true 时拒绝写入。
   */
  async promoteSandbox(opts: PromoteSandboxOptions): Promise<PromoteSandboxResult> {
    const source = opts.source ?? "evolution.promote_sandbox";
    if (opts.approved !== true) {
      await this.runtime.kernel
        .publish("hitl.approval_requested", source, {
          gate_id: opts.promotion_id,
          message: `沙盒晋升 ${opts.promotion_id} 需要 approved=true 才能写入生产 Pack。`,
          promotion_id: opts.promotion_id,
        })
        .catch(() => undefined);
      return {
        status: "approval_required",
        promotion_id: opts.promotion_id,
        message: "需要 approved=true 才能晋升沙盒包",
      };
    }

    const pending = this.pendingSandboxPromotions.get(opts.promotion_id);
    if (!pending) {
      return { status: "not_found", promotion_id: opts.promotion_id };
    }

    const importResult = await this.importEvolutionPackProduction(pending.pack);
    this.pendingSandboxPromotions.delete(opts.promotion_id);
    try {
      deletePendingSandboxPromotion(this.runtime.db, opts.promotion_id);
    } catch {
      // 内存已删除；DB 清理失败不阻断晋升结果
    }

    if (importResult.success) {
      await this.runtime.kernel
        .publish("evolution.sandbox_promoted", source, {
          promotion_id: opts.promotion_id,
          pack_version: pending.pack.version,
          playbook_ids: pending.playbook_ids,
          improvements: importResult.applied.length,
        })
        .catch(() => undefined);
      return {
        status: "promoted",
        promotion_id: opts.promotion_id,
        import: importResult,
      };
    }

    return {
      status: "promotion_failed",
      promotion_id: opts.promotion_id,
      import: importResult,
    };
  }

  /** 查看进化历史（最近导入的进化包记录） */
  getHistory(): EvolutionHistoryEntry[] {
    return [...this.history].toReversed();
  }

  /** 生成进化状态摘要 */
  getStatus(): {
    total_imported: number;
    last_imported_at: string | null;
    last_summary: string | null;
  } {
    const last = this.history[this.history.length - 1];
    return {
      total_imported: this.history.length,
      last_imported_at: last?.imported_at ?? null,
      last_summary: last?.summary ?? null,
    };
  }

  // ── 私有辅助方法 ───────────────────────────────────────────────────────

  private getRobotId(): string {
    const idMgr = (
      this.runtime as { robotIdentityManager?: { getIdentity?: () => { id?: string } } }
    ).robotIdentityManager;
    return idMgr?.getIdentity?.()?.id ?? this.runtime.robot.name;
  }

  private collectPlaybookStats(): {
    manifest: EvolutionExportData["playbook_manifest"];
    failures: EvolutionExportData["failed_executions"];
  } {
    const playbooks = this.runtime.playbookEngine.list();
    const manifest = playbooks.map((p) => ({
      id: p.id,
      trigger_pattern: Array.isArray(p.trigger)
        ? ((p.trigger[0] as { kind?: string; pattern?: string } | undefined)?.pattern ??
          (p.trigger[0] as { kind?: string } | undefined)?.kind ??
          "unknown")
        : ((p.trigger as { pattern?: string; kind?: string }).pattern ??
          (p.trigger as { kind?: string }).kind ??
          "unknown"),
      step_count: (p.steps ?? []).length,
    }));

    // 从数据库读取近期失败执行记录
    const failures = this.loadFailedExecutions();

    return { manifest, failures };
  }

  private loadFailedExecutions(): EvolutionExportData["failed_executions"] {
    try {
      const rows = this.runtime.db
        .prepare(
          `SELECT playbook_id, status, error, started_at FROM cw_playbook_runs
           WHERE status = 'failed' ORDER BY started_at DESC LIMIT 100`,
        )
        .all() as Array<{
        playbook_id: string;
        status: string;
        error: string | null;
        started_at: string;
      }>;
      return rows.map((r) => ({
        playbook_id: r.playbook_id,
        trigger_type: "event",
        error_type: this.classifyError(r.error ?? ""),
        step_reached: "unknown",
        timestamp: r.started_at,
      }));
    } catch {
      return [];
    }
  }

  private loadHitlDecisions(since: string): EvolutionExportData["hitl_decisions"] {
    try {
      const rows = this.runtime.db
        .prepare(
          `SELECT context_type, decision, modification_hint, created_at
           FROM cw_hitl_pending
           WHERE status != 'pending' AND created_at >= ?
           LIMIT 200`,
        )
        .all(since) as Array<{
        context_type: string | null;
        decision: string | null;
        modification_hint: string | null;
        created_at: string;
      }>;
      return rows.map((r) => ({
        context_type: r.context_type ?? "unknown",
        decision: (r.decision as "approved" | "rejected" | "modified") ?? "approved",
        modification_hint: r.modification_hint ?? undefined,
        timestamp: r.created_at,
      }));
    } catch {
      return [];
    }
  }

  private loadFeedbackRecords(): EvolutionExportData["feedback_records"] {
    const cases = (this.runtime.cbrStore?.list({ limit: 200 }) ?? []) as unknown as CbrCase[];
    return cases
      .filter((c) => c.outcome !== undefined)
      .map((c) => ({
        interaction_type: String(c.tags?.[0] ?? c.problem.slice(0, 20) ?? "unknown"),
        feedback_score: c.outcome === "success" ? 1 : c.outcome === "partial" ? 0.5 : 0,
        feedback_hint: undefined,
        timestamp: (c.createdAt ?? new Date(0)).toISOString(),
      }));
  }

  private loadLowConfidenceIntents(): EvolutionExportData["low_confidence_intents"] {
    // 从 cbrStore 中提取低置信度案例（置信度通过 similarity_keys 推断）
    const cases = (this.runtime.cbrStore?.list({ limit: 200 }) ?? []) as unknown as CbrCase[];
    return cases
      .filter((c) => c.useCount <= 1)
      .slice(0, 50)
      .map((c) => ({
        text_hash: this.hashText(c.problem),
        text_preview: c.problem.slice(0, 20),
        classified_intent: typeof c.tags?.[0] === "string" ? c.tags[0] : "unknown",
        confidence: 0.4,
        actual_outcome: c.outcome,
        timestamp: (c.createdAt ?? new Date(0)).toISOString(),
      }));
  }

  private collectRuleTableNames(): string[] {
    const engine = this.runtime.ruleEngine;
    if (!engine) {
      return [];
    }
    try {
      if (typeof engine.listTables === "function") {
        return [
          ...new Set(engine.listTables().map((table) => table.id.split(".")[0] ?? "unknown")),
        ];
      }
      const listRules = (engine as { listRules?: () => Array<{ id: string }> }).listRules;
      if (typeof listRules === "function") {
        return [
          ...new Set(listRules.call(engine).map((rule) => rule.id.split(".")[0] ?? "unknown")),
        ];
      }
      return [];
    } catch {
      return [];
    }
  }

  private collectPromptTemplateNames(): string[] {
    const registry = this.runtime.promptRegistry;
    if (!registry) {
      return [];
    }
    try {
      return registry.list().map((t) => t.id);
    } catch {
      return [];
    }
  }

  private hashText(text: string): string {
    return createHash("sha256").update(text).digest("hex").slice(0, 16);
  }

  private classifyError(error: string): string {
    const e = error.toLowerCase();
    if (e.includes("timeout")) {
      return "timeout";
    }
    if (e.includes("llm") || e.includes("model")) {
      return "llm_error";
    }
    if (e.includes("capability") || e.includes("not found")) {
      return "capability_not_found";
    }
    if (e.includes("permission") || e.includes("hitl") || e.includes("denied")) {
      return "permission_denied";
    }
    if (e.includes("connect") || e.includes("network")) {
      return "connector_error";
    }
    return "unknown";
  }

  private serializePlaybookToYaml(playbook: Record<string, unknown>): string {
    // 将 Playbook 对象序列化为 YAML 字符串。
    // 优先使用 js-yaml（如已安装），降级为简单的 JSON 序列化（playbookEngine.loadFromYaml 支持 JSON 超集）。
    try {
      const yaml = require("js-yaml");
      return yaml.dump(playbook, { indent: 2, lineWidth: 120, noRefs: true }) as string;
    } catch {
      // js-yaml 不可用时退回 JSON（playbookEngine.loadFromYaml 可解析 JSON）
      return JSON.stringify(playbook, null, 2);
    }
  }
}
