/**
 * script-library.ts — 可复用脚本库（纯 TypeScript，完全不依赖 LLM）
 *
 * Script 是原子能力：把能用规则/脚本完成的事交给脚本，不让弱模型"发挥"。
 * Playbook 的 kind:script 步骤可直接调用，无需 LLM。
 *
 * @note 命名约定（与 OpenClaw 对齐）：
 *   - Script / ScriptLibrary：ClaWorks 内置纯代码脚本（本文件）
 *   - Skill（OpenClaw）：通过 runEmbeddedAgent 调用的 AI 推理能力（SKILL.md 驱动）
 */

import type { ClaworksRuntime } from "../claworks/runtime-types.js";

// ── 类型定义 ──────────────────────────────────────────────────────────────

export type ScriptContext = {
  params: Record<string, unknown>;
  runtime: ClaworksRuntime;
  logger: (msg: string) => void;
};

export type ScriptDefinition = {
  id: string;
  name: string;
  description: string;
  /** 参数 schema（文档用途） */
  paramsSchema?: Record<string, { type: string; required?: boolean; description?: string }>;
  /** 纯函数实现，无 LLM */
  execute: (ctx: ScriptContext) => Promise<Record<string, unknown>>;
};

/** Pack 通过 `PackContribution.scripts` 声明的轻量脚本入口 */
export type PackScriptEntry = {
  id: string;
  name: string;
  description?: string;
  run: (params: unknown, runtime?: ClaworksRuntime) => unknown | Promise<unknown>;
};

export interface ScriptLibrary {
  register(script: ScriptDefinition): void;
  get(id: string): ScriptDefinition | undefined;
  list(): ScriptDefinition[];
  /**
   * 主调用入口（runtime 由 registerBuiltinScripts 时的闭包捕获）。
   * Playbook kind:script 步骤经由 deps.scriptRun 最终调用此方法。
   */
  invoke(id: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** @deprecated 使用 invoke；仅保留给需要外部 runtime 的边界场景 */
  execute(
    scriptId: string,
    params: Record<string, unknown>,
    runtime: ClaworksRuntime,
    logger?: (msg: string) => void,
  ): Promise<Record<string, unknown>>;
  /**
   * Pack onLoad 时批量注册脚本（自动命名空间前缀）。
   * 若 id 已包含 "."，则原样注册；否则注册为 `{packId}.{id}`。
   * Pack 开发者无需修改核心代码，只需在 PackContribution.scripts 中声明。
   */
  registerFromPack(packId: string, scripts: PackScriptEntry[]): void;
}

// ── 向后兼容别名 ──────────────────────────────────────────────────────────

/** @deprecated 使用 ScriptContext */
export type SkillContext = ScriptContext;
/** @deprecated 使用 ScriptDefinition */
export type SkillDefinition = ScriptDefinition;
/** @deprecated 使用 ScriptLibrary */
export type SkillLibrary = ScriptLibrary;

// ── 工厂函数 ──────────────────────────────────────────────────────────────

export function createScriptLibrary(): ScriptLibrary {
  const scripts = new Map<string, ScriptDefinition>();
  let _runtime: ClaworksRuntime | undefined;

  const lib: ScriptLibrary = {
    register(script) {
      scripts.set(script.id, script);
    },

    get(id) {
      return scripts.get(id);
    },

    list() {
      return [...scripts.values()];
    },

    registerFromPack(packId, packScripts) {
      for (const entry of packScripts) {
        const qualifiedId = entry.id.includes(".") ? entry.id : `${packId}.${entry.id}`;
        lib.register({
          id: qualifiedId,
          name: entry.name,
          description: entry.description ?? "",
          execute: async (ctx) => {
            const result = await entry.run(ctx.params, ctx.runtime);
            if (result !== null && typeof result === "object" && !Array.isArray(result)) {
              return result as Record<string, unknown>;
            }
            return { result };
          },
        });
      }
    },

    async invoke(id, params = {}) {
      const script = scripts.get(id);
      if (!script) {
        throw new Error(`Script not found: ${id}`);
      }
      if (!_runtime) {
        throw new Error(`ScriptLibrary: runtime not bound; call registerBuiltinScripts first`);
      }
      return script.execute({ params, runtime: _runtime, logger: () => undefined });
    },

    async execute(scriptId, params, runtime, logger) {
      const script = scripts.get(scriptId);
      if (!script) {
        throw new Error(`Script not found: ${scriptId}`);
      }
      const noop = () => undefined;
      return script.execute({ params, runtime, logger: logger ?? noop });
    },
  };

  (lib as unknown as { _bindRuntime: (r: ClaworksRuntime) => void })._bindRuntime = (r) => {
    _runtime = r;
  };

  return lib;
}

/** @deprecated 使用 createScriptLibrary */
export const createSkillLibrary = createScriptLibrary;

// ── 内置脚本注册 ───────────────────────────────────────────────────────────

/** 注册所有内置脚本到给定的 ScriptLibrary，并绑定 runtime 以支持 invoke() */
export function registerBuiltinScripts(library: ScriptLibrary, runtime: ClaworksRuntime): void {
  const binder = (library as unknown as { _bindRuntime?: (r: ClaworksRuntime) => void })
    ._bindRuntime;
  binder?.(runtime);

  // calc.expression — 计算数学表达式（生产指标计算）
  library.register({
    id: "calc.expression",
    name: "数学表达式计算",
    description: "安全计算数学表达式，用于生产指标计算（不依赖 LLM）",
    paramsSchema: {
      expression: { type: "string", required: true, description: "数学表达式，如 '(a+b)*c'" },
    },
    execute: async ({ params }) => {
      const expr = String(params.expression ?? "");
      const safe = expr.replace(/[^0-9+\-*/().%\s]/g, "");
      if (!safe.trim()) {
        return { result: 0, expression: expr, error: "表达式为空或包含非法字符" };
      }
      try {
        const result = Function(`"use strict"; return (${safe})`)() as number;
        return { result, expression: expr };
      } catch (err) {
        return { result: null, expression: expr, error: String(err) };
      }
    },
  });

  // time.format — 时间格式化
  library.register({
    id: "time.format",
    name: "时间格式化",
    description: "格式化时间戳为指定格式字符串，工业场景常用（不依赖 LLM）",
    paramsSchema: {
      timestamp: { type: "string", description: "ISO 时间戳，默认当前时间" },
      format: { type: "string", description: "格式串，如 YYYY-MM-DD HH:mm:ss" },
    },
    execute: async ({ params }) => {
      const ts = params.timestamp ? new Date(params.timestamp as string) : new Date();
      const format = String(params.format ?? "YYYY-MM-DD HH:mm:ss");
      const pad = (n: number) => n.toString().padStart(2, "0");
      const formatted = format
        .replace("YYYY", ts.getFullYear().toString())
        .replace("MM", pad(ts.getMonth() + 1))
        .replace("DD", pad(ts.getDate()))
        .replace("HH", pad(ts.getHours()))
        .replace("mm", pad(ts.getMinutes()))
        .replace("ss", pad(ts.getSeconds()));
      return { formatted, timestamp: ts.toISOString() };
    },
  });

  // data.extract_fields — 从对象中提取指定字段
  library.register({
    id: "data.extract_fields",
    name: "字段提取",
    description: "从对象中提取指定字段集合，用于数据转换（不依赖 LLM）",
    paramsSchema: {
      source: { type: "object", required: true, description: "源对象" },
      fields: { type: "array", required: true, description: "要提取的字段名列表" },
    },
    execute: async ({ params }) => {
      const source = (params.source ?? {}) as Record<string, unknown>;
      const fields = Array.isArray(params.fields) ? (params.fields as string[]) : [];
      const result: Record<string, unknown> = {};
      for (const f of fields) {
        result[f] = source[f];
      }
      return { extracted: result, count: fields.length };
    },
  });

  // text.template_fill — 模板填充
  library.register({
    id: "text.template_fill",
    name: "模板填充",
    description:
      "用变量值填充 {{variable}} 占位符，弱模型补偿核心：预写回复模板，模型只填空（不依赖 LLM）",
    paramsSchema: {
      template: { type: "string", required: true, description: "模板文本，含 {{变量名}} 占位符" },
      variables: { type: "object", required: true, description: "变量值映射" },
    },
    execute: async ({ params }) => {
      const template = String(params.template ?? "");
      const variables = (params.variables ?? {}) as Record<string, unknown>;
      const filled = template.replace(/\{\{(\w+)\}\}/g, (_, k: string) =>
        String(variables[k] ?? `{{${k}}}`),
      );
      return { text: filled, template };
    },
  });

  // default.severity_classifier — 通用严重度分类器（基于规则，无需 LLM）
  library.register({
    id: "default.severity_classifier",
    name: "默认严重度分类器",
    description:
      "基于规则的通用严重度分类（无需LLM）。从 item.severity/level/priority 字段推断等级",
    paramsSchema: {
      item: { type: "object", description: "待分类的事项对象，含 severity/level/priority 等字段" },
    },
    execute: async ({ params }) => {
      const item = (params.item as Record<string, unknown>) ?? params;
      const rawLevel = String(item.severity ?? item.level ?? item.priority ?? "").toLowerCase();
      if (["critical", "emergency", "p1", "p2", "high"].includes(rawLevel)) {
        return { level: "critical", score: 1.0, raw: rawLevel };
      }
      if (["medium", "normal", "p3", "warn", "warning"].includes(rawLevel)) {
        return { level: "medium", score: 0.5, raw: rawLevel };
      }
      return { level: "low", score: 0.2, raw: rawLevel || "unset" };
    },
  });

  // alarm.classify_severity — 报警严重程度分类
  library.register({
    id: "alarm.classify_severity",
    name: "报警严重程度分类",
    description: "基于阈值规则判断报警严重程度（normal/high/critical），完全不需要 LLM",
    paramsSchema: {
      value: { type: "number", required: true, description: "报警指标值" },
      high_threshold: { type: "number", description: "高级阈值，默认 90" },
      critical_threshold: { type: "number", description: "紧急阈值，默认 95" },
    },
    execute: async ({ params }) => {
      const value = Number(params.value ?? 0);
      const highThreshold = Number(params.high_threshold ?? 90);
      const criticalThreshold = Number(params.critical_threshold ?? 95);
      const severity =
        value >= criticalThreshold ? "critical" : value >= highThreshold ? "high" : "normal";
      return { severity, value, exceeded: value >= highThreshold };
    },
  });

  // work_order.auto_assign — 自动分配工单
  library.register({
    id: "work_order.auto_assign",
    name: "工单自动分配",
    description: "根据设备绑定规则自动推断工单责任人，不依赖 LLM",
    paramsSchema: {
      equipment_id: { type: "string", required: true, description: "设备 ID" },
    },
    execute: async ({ params }) => {
      const equipmentId = String(params.equipment_id ?? "");
      const bindings = runtime.notificationRouter
        ?.listBindings()
        .find((b) => b.subjectType === "equipment" && b.subjectId === equipmentId);
      const assignee = bindings?.userIds[0] ?? "unassigned";
      return { assigned_to: assignee, equipment_id: equipmentId, method: "rule-based" };
    },
  });

  // kb.quick_search — 知识库快速搜索
  library.register({
    id: "kb.quick_search",
    name: "知识库快速搜索",
    description: "直接检索知识库返回最相关片段，不调用 LLM（RAG-first 策略）",
    paramsSchema: {
      query: { type: "string", required: true, description: "搜索查询词" },
      limit: { type: "number", description: "返回条数，默认 1" },
    },
    execute: async ({ params }) => {
      const query = String(params.query ?? "");
      const limit = typeof params.limit === "number" ? params.limit : 1;
      const results = await runtime.kb.search(query, { limit });
      return {
        found: results.length > 0,
        text: results[0]?.text ?? "",
        score: results[0]?.score ?? 0,
        results: results.map((r) => ({ text: r.text, score: r.score })),
      };
    },
  });

  // json.path_query — JSONPath 查询
  library.register({
    id: "json.path_query",
    name: "JSONPath 查询",
    description: "在嵌套 JSON 对象中按路径查询值（支持点路径和数组索引），不依赖 LLM",
    paramsSchema: {
      data: { type: "object", required: true, description: "要查询的 JSON 对象" },
      path: {
        type: "string",
        required: true,
        description: "查询路径，如 'a.b[0].c'，支持 * 通配符",
      },
    },
    execute: async ({ params }) => {
      const data = params.data as Record<string, unknown>;
      const path = String(params.path ?? "");

      function queryPath(obj: unknown, segments: string[]): unknown[] {
        if (segments.length === 0) {
          return [obj];
        }
        const [head, ...rest] = segments;
        if (head === "*") {
          if (Array.isArray(obj)) {
            return obj.flatMap((item) => queryPath(item, rest));
          }
          if (typeof obj === "object" && obj !== null) {
            return Object.values(obj).flatMap((v) => queryPath(v, rest));
          }
          return [];
        }
        const idxMatch = head.match(/^(.+)\[(\d+)\]$/);
        if (idxMatch) {
          const key = idxMatch[1];
          const idx = Number.parseInt(idxMatch[2], 10);
          const sub = key ? (obj as Record<string, unknown>)[key] : obj;
          return Array.isArray(sub) ? queryPath(sub[idx], rest) : [];
        }
        if (typeof obj === "object" && obj !== null) {
          return queryPath((obj as Record<string, unknown>)[head], rest);
        }
        return [];
      }

      const segments = path.split(".").filter(Boolean);
      const results = queryPath(data, segments);
      return {
        results,
        count: results.length,
        first: results[0] ?? null,
        path,
      };
    },
  });

  // array.aggregate — 数组聚合
  library.register({
    id: "array.aggregate",
    name: "数组聚合",
    description: "对数组执行聚合计算（sum/avg/max/min/count），处理批量数值数据，不依赖 LLM",
    paramsSchema: {
      items: { type: "array", required: true, description: "数字数组或对象数组" },
      op: {
        type: "string",
        required: true,
        description: "聚合操作：sum | avg | max | min | count",
      },
      field: { type: "string", description: "如果 items 是对象数组，指定要聚合的字段名" },
    },
    execute: async ({ params }) => {
      const items = Array.isArray(params.items) ? params.items : [];
      const op = String(params.op ?? "count");
      const field = params.field ? String(params.field) : undefined;

      const nums = items
        .map((item) => {
          const v =
            field && typeof item === "object" && item !== null
              ? (item as Record<string, unknown>)[field]
              : item;
          return typeof v === "number" ? v : Number.parseFloat(String(v ?? "NaN"));
        })
        .filter((n) => !Number.isNaN(n));

      switch (op) {
        case "count":
          return { result: items.length, op, count: items.length };
        case "sum":
          return { result: nums.reduce((a, b) => a + b, 0), op, count: nums.length };
        case "avg":
          return {
            result: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0,
            op,
            count: nums.length,
          };
        case "max":
          return { result: nums.length ? Math.max(...nums) : null, op, count: nums.length };
        case "min":
          return { result: nums.length ? Math.min(...nums) : null, op, count: nums.length };
        default:
          return { result: null, op, error: `不支持的聚合操作: ${op}` };
      }
    },
  });

  // text.truncate — 文本截断
  library.register({
    id: "text.truncate",
    name: "文本截断",
    description: "将文本截断到指定最大字符数，尾部加省略标记，确保消息不超过 IM 长度限制",
    paramsSchema: {
      text: { type: "string", required: true, description: "原始文本" },
      max_length: { type: "number", description: "最大字符数，默认 4000（飞书单消息上限）" },
      suffix: { type: "string", description: "截断后缀，默认 '…（内容已截断）'" },
    },
    execute: async ({ params }) => {
      const text = String(params.text ?? "");
      const maxLength = typeof params.max_length === "number" ? params.max_length : 4000;
      const suffix = typeof params.suffix === "string" ? params.suffix : "…（内容已截断）";

      if (text.length <= maxLength) {
        return { text, truncated: false, original_length: text.length };
      }
      const truncated = text.slice(0, maxLength - suffix.length) + suffix;
      return {
        text: truncated,
        truncated: true,
        original_length: text.length,
        truncated_length: truncated.length,
      };
    },
  });

  // system.timestamp — 高精度时间戳生成
  library.register({
    id: "system.timestamp",
    name: "高精度时间戳",
    description: "生成高精度时间戳（ISO格式 + Unix毫秒 + 纳秒），用于事件去重和排序，不依赖 LLM",
    paramsSchema: {
      format: { type: "string", description: "返回格式：iso|unix_ms|unix_s|all，默认 all" },
    },
    execute: async ({ params }) => {
      const now = new Date();
      const format = String(params.format ?? "all");
      const unix_ms = now.getTime();
      const unix_s = Math.floor(unix_ms / 1000);
      const iso = now.toISOString();

      if (format === "iso") {
        return { timestamp: iso };
      }
      if (format === "unix_ms") {
        return { timestamp: unix_ms };
      }
      if (format === "unix_s") {
        return { timestamp: unix_s };
      }

      return {
        iso,
        unix_ms,
        unix_s,
        sortable: iso.replace(/[:\-T.Z]/g, ""),
        dedup_key: `${unix_ms}`,
      };
    },
  });

  // card.build_alarm — 构建报警卡片
  library.register({
    id: "card.build_alarm",
    name: "构建报警卡片",
    description: "组装飞书报警互动卡片，纯数据拼装不依赖 LLM",
    paramsSchema: {
      alarm_id: { type: "string", required: true, description: "报警 ID" },
      equipment_id: { type: "string", required: true, description: "设备 ID" },
      severity: { type: "string", description: "严重程度" },
      description: { type: "string", description: "报警描述" },
      time: { type: "string", description: "报警时间" },
    },
    execute: async ({ params }) => {
      const card = runtime.cardBuilder?.alarm({
        alarmId: String(params.alarm_id ?? ""),
        equipmentId: String(params.equipment_id ?? ""),
        severity: String(params.severity ?? "medium"),
        description: String(params.description ?? ""),
        time: params.time ? String(params.time) : undefined,
      });
      return { card, feishu_json: card ? runtime.cardBuilder?.toFeishu(card) : undefined };
    },
  });

  // card.build_daily_report — 构建每日生产日报卡片
  library.register({
    id: "card.build_daily_report",
    name: "构建每日生产日报卡片",
    description:
      "将预聚合的生产统计数据组装成飞书互动日报卡片（含四格数据展示 + 亮点/警告列表 + 操作按钮），纯模板填充不依赖 LLM",
    paramsSchema: {
      date: { type: "string", description: "报告日期，如 2026-05-22" },
      summary: { type: "string", required: true, description: "LLM 生成的简报摘要文字" },
      alarm_count: { type: "number", description: "未处置报警数，默认 0" },
      work_order_count: { type: "number", description: "待处理工单数，默认 0" },
      completed_task_count: { type: "number", description: "今日完成任务数，默认 0" },
      equipment_health: { type: "number", description: "设备健康分 0-100，默认 100" },
      highlights: { type: "array", description: "今日亮点列表（字符串数组）" },
      warnings: { type: "array", description: "注意事项列表（字符串数组）" },
    },
    execute: async ({ params }) => {
      const date = params.date
        ? String(params.date)
        : new Date().toLocaleDateString("zh-CN", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          });
      const summary = String(params.summary ?? "");
      const alarmCount = Number(params.alarm_count ?? 0);
      const workOrderCount = Number(params.work_order_count ?? 0);
      const completedCount = Number(params.completed_task_count ?? 0);
      const equipHealth = Math.max(0, Math.min(100, Number(params.equipment_health ?? 100)));
      const highlights = Array.isArray(params.highlights) ? (params.highlights as string[]) : [];
      const warnings = Array.isArray(params.warnings) ? (params.warnings as string[]) : [];

      const statCol = (
        label: string,
        value: string,
        indicator: "red" | "green" | "blue" | "orange",
      ) => {
        const dot = { red: "🔴", green: "🟢", blue: "🔵", orange: "🟡" }[indicator];
        return {
          tag: "column",
          elements: [
            {
              tag: "div",
              text: { tag: "lark_md", content: `${label}\n**${dot} ${value}**` },
            },
          ],
        };
      };

      const elements: unknown[] = [
        { tag: "div", text: { tag: "lark_md", content: `**今日摘要**\n${summary}` } },
        { tag: "hr" },
        {
          tag: "column_set",
          flex_mode: "stretch",
          columns: [
            statCol("🚨 报警", String(alarmCount), alarmCount > 5 ? "red" : "green"),
            statCol("🔧 工单", String(workOrderCount), "blue"),
            statCol("✅ 完成", String(completedCount), "green"),
            statCol("⚙️ 设备健康", `${equipHealth}%`, equipHealth < 80 ? "orange" : "green"),
          ],
        },
      ];

      if (highlights.length > 0) {
        elements.push({ tag: "hr" });
        elements.push({
          tag: "div",
          text: {
            tag: "lark_md",
            content: `**✨ 今日亮点**\n${highlights.map((h) => `• ${h}`).join("\n")}`,
          },
        });
      }
      if (warnings.length > 0) {
        elements.push({
          tag: "div",
          text: {
            tag: "lark_md",
            content: `**⚠️ 注意事项**\n${warnings.map((w) => `• ${w}`).join("\n")}`,
          },
        });
      }

      elements.push({ tag: "hr" });
      elements.push({
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "📋 查看详情" },
            type: "primary",
            value: { action: "view_daily_detail", date },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "📤 导出报告" },
            type: "default",
            value: { action: "export_report", date },
          },
        ],
      });

      const feishuCard = {
        msg_type: "interactive",
        card: {
          config: { wide_screen_mode: true, enable_forward: true },
          header: {
            title: { tag: "plain_text", content: `📊 每日生产报告 · ${date}` },
            template: alarmCount > 5 ? "red" : "blue",
          },
          elements,
        },
      };

      const cwCard = runtime.cardBuilder?.report({
        title: `每日生产报告 · ${date}`,
        period: date,
        metrics: [
          { label: "🚨 未处置报警", value: String(alarmCount) },
          { label: "🔧 待处理工单", value: String(workOrderCount) },
          { label: "✅ 今日完成", value: String(completedCount) },
          { label: "⚙️ 设备健康", value: `${equipHealth}%` },
        ],
      });

      return {
        date,
        feishu_card: feishuCard,
        card: cwCard,
        stats: {
          alarm_count: alarmCount,
          work_order_count: workOrderCount,
          completed_task_count: completedCount,
          equipment_health: equipHealth,
        },
      };
    },
  });
}

/** @deprecated 使用 registerBuiltinScripts */
export const registerBuiltinSkills = registerBuiltinScripts;
