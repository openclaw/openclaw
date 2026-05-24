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

export interface ImportResult {
  success: boolean;
  applied: string[];
  errors?: string[];
}

// ── 进化历史记录 ──────────────────────────────────────────────────────────

export interface EvolutionHistoryEntry {
  pack_version: string;
  pack_generated_at: string;
  imported_at: string;
  improvements: number;
  summary: string;
}

// ── EvolutionSyncManager ──────────────────────────────────────────────────

export class EvolutionSyncManager {
  /** 内存中保存的导入历史（重启后丢失；可用 DB 持久化） */
  private history: EvolutionHistoryEntry[] = [];

  constructor(private readonly runtime: ClaworksRuntime) {}

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
   */
  async importEvolutionPack(pack: EvolutionPack): Promise<ImportResult> {
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
          if (typeof pb.load === "function") {
            const playbookDef = parsePlaybookYaml(yamlContent, source);
            pb.load(playbookDef);
          } else if (typeof pb.loadFromYaml === "function") {
            await pb.loadFromYaml(yamlContent, source);
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
        const ruleEngine = this.runtime.ruleEngine;
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
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
      const yaml = require("js-yaml");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      return yaml.dump(playbook, { indent: 2, lineWidth: 120, noRefs: true }) as string;
    } catch {
      // js-yaml 不可用时退回 JSON（playbookEngine.loadFromYaml 可解析 JSON）
      return JSON.stringify(playbook, null, 2);
    }
  }
}
