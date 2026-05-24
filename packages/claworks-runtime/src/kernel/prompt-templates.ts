/**
 * prompt-templates.ts — ClaWorks 弱模型脚手架：Prompt 模板注册表
 *
 * 为常见工业场景提供精心设计的中文 Prompt 模板，让弱开源模型
 * (Qwen/Deepseek/Llama) 也能稳定完成结构化输出任务。
 *
 * 内置模板（6 个）：
 *   intent_classify         — 意图分类（15 类，few-shot）
 *   alarm_analysis          — 报警根因分析（步骤引导）
 *   work_order_description  — 自动生成工单描述
 *   kb_answer               — 知识库检索增强问答
 *   shift_summary           — 班次总结生成
 *   report_narrative        — 报告文字描述生成
 *
 * 设计原则：
 *   - 模板变量用 {{variable}} 占位，render() 替换
 *   - system prompt 简短、明确，避免弱模型迷失
 *   - 每个模板指定 outputFormat（json/text/list）
 *   - few-shot 示例让弱模型「有样学样」
 */

// ── 类型定义 ──────────────────────────────────────────────────────────────

export type PromptTemplate = {
  id: string;
  name: string;
  description: string;
  /** {{variable}} 占位符会被 render() 替换 */
  system: string;
  user: string;
  outputFormat: "json" | "text" | "list";
  examples?: Array<{ input: Record<string, string>; output: string }>;
};

export interface PromptTemplateRegistry {
  register(template: PromptTemplate): void;
  get(id: string): PromptTemplate | undefined;
  list(): PromptTemplate[];
  /** 渲染模板，替换 {{variable}} 占位符 */
  render(
    id: string,
    variables: Record<string, string>,
  ): { system: string; user: string; template_name: string };
}

// ── render 工具函数 ───────────────────────────────────────────────────────

function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => variables[key] ?? `{{${key}}}`);
}

// ── 内置模板定义 ──────────────────────────────────────────────────────────

const BUILTIN_TEMPLATES: PromptTemplate[] = [
  {
    id: "intent_classify",
    name: "意图分类",
    description: "将用户消息分类到预定义意图，适合弱模型（含 few-shot 示例）",
    outputFormat: "json",
    system: `你是一个工业机器人助手的意图分类器。

你的任务：将用户输入分类为以下意图之一，并返回严格的 JSON。禁止输出 JSON 以外的任何内容。

可用意图列表（必须从中选一个，不能自造新值）：
- alarm_report      上报告警、报警、故障、异常、超标、停机
- alarm_acknowledge 确认告警、已处理、收到、知道了
- workorder_create  创建工单、新建工单、派工、生成工单
- workorder_query   查工单、工单状态、工单进度
- task_query        查任务、任务状态、任务进度
- equipment_status  查设备状态、运行参数、设备读数
- knowledge_query   查知识库、文档、手册、操作规程、日报、日志
- approval_create   创建审批、发起申请
- shift_handover    交班、接班、班次交接
- report_request    生成报告、统计汇总
- maintenance_query 维护保养、保养计划、巡检
- safety_alert      安全隐患、危险、违规
- system_status     查系统状态、系统健康、在线情况
- help              帮助、怎么用、功能介绍
- chat              闲聊、问候、其他对话
- unknown           无法判断意图

输出格式（严格遵守，不加注释，不加 markdown）：
{"intent": "<意图名>", "confidence": <0到1的数字>, "extracted": {}}

示例：
输入：「泵1号振动超标，需要处理」
输出：{"intent": "alarm_report", "confidence": 0.95, "extracted": {"equipment": "泵1号", "issue": "振动超标"}}

输入：「今天的日报在哪里？」
输出：{"intent": "knowledge_query", "confidence": 0.88, "extracted": {"topic": "日报"}}

输入：「帮我创建一个巡检工单」
输出：{"intent": "workorder_create", "confidence": 0.92, "extracted": {"type": "巡检"}}

输入：「E001压缩机温度多少」
输出：{"intent": "equipment_status", "confidence": 0.9, "extracted": {"equipment_id": "E001", "equipment_type": "压缩机"}}

输入：「你好」
输出：{"intent": "chat", "confidence": 0.99, "extracted": {}}`,
    user: "{{message}}",
    examples: [
      {
        input: { message: "E001设备报警了" },
        output: `{"intent": "alarm_report", "confidence": 0.95, "extracted": {"equipment_id": "E001"}}`,
      },
      {
        input: { message: "帮我创建一个紧急维修工单" },
        output: `{"intent": "workorder_create", "confidence": 0.92, "extracted": {"priority": "urgent", "type": "维修"}}`,
      },
      {
        input: { message: "查一下3号工单进度" },
        output: `{"intent": "workorder_query", "confidence": 0.9, "extracted": {"work_order_id": "3"}}`,
      },
    ],
  },

  {
    id: "alarm_analysis",
    name: "报警根因分析",
    description: "按步骤引导弱模型分析设备报警根因，输出结构化诊断结果",
    outputFormat: "json",
    system: `你是设备故障诊断专家。请按以下步骤分析报警，输出 JSON，不要额外解释。

步骤 1：识别设备类型（泵/压缩机/换热器/阀门/仪表/管线/其他）
步骤 2：判断故障类型（机械故障/电气故障/工艺异常/仪表误报/外部因素）
步骤 3：评估紧急程度（1=可延迟处理，3=需当班处理，5=立即停机）
步骤 4：给出处理建议（最多 3 条，简明扼要）
步骤 5：判断是否需要人工确认（true/false）

输出格式（严格 JSON）：
{
  "equipment_type": "",
  "fault_type": "",
  "urgency": 1-5,
  "suggestions": ["建议1", "建议2"],
  "need_human": true/false,
  "confidence": 0.0-1.0
}`,
    user: `设备：{{equipment_id}}
报警描述：{{description}}
报警级别：{{severity}}
{{context}}`,
    examples: [],
  },

  {
    id: "work_order_description",
    name: "工单描述生成",
    description: "根据关键信息自动生成标准化工单描述",
    outputFormat: "text",
    system: `你是工单管理系统助手。根据提供的信息生成一份简洁、专业的工单描述。
要求：
1. 描述清楚故障现象/需求
2. 包含关键设备信息
3. 说明紧急程度和影响范围
4. 150字以内

直接输出描述文字，不要加任何前缀。`,
    user: `类型：{{type}}
设备：{{equipment}}
现象：{{symptom}}
位置：{{location}}
紧急程度：{{priority}}`,
    examples: [
      {
        input: {
          type: "维修",
          equipment: "P-101 离心泵",
          symptom: "振动超标，轴承温度高",
          location: "一车间",
          priority: "紧急",
        },
        output:
          "一车间 P-101 离心泵出现异常振动，轴承温度持续升高，超出正常工作范围。需立即安排维修人员检查轴承状态及对中情况，必要时更换轴承。该泵为生产关键设备，停机将影响当班产量，请优先处理。",
      },
    ],
  },

  {
    id: "kb_answer",
    name: "知识库问答",
    description: "基于检索结果和知识背景回答用户问题（RAG 模式）",
    outputFormat: "text",
    system: `你是工业知识库助手。请基于提供的参考资料回答用户问题。

规则：
1. 优先使用参考资料中的内容
2. 如果资料不足，说明"资料有限"并给出基本建议
3. 回答要准确、简洁，适合工业操作人员阅读
4. 如有操作步骤，用数字列表呈现
5. 不要编造具体数据

直接回答，不要重复问题。`,
    user: `问题：{{question}}

参考资料：
{{context}}`,
    examples: [],
  },

  {
    id: "shift_summary",
    name: "班次总结生成",
    description: "根据班次数据生成简洁的交接班总结",
    outputFormat: "text",
    system: `你是交接班记录助手。根据班次数据生成简洁的交接班总结报告。

格式要求：
- 开头一句话总结本班整体情况
- 关键事项用要点列出（最多 5 条）
- 结尾写下班注意事项
- 全文 200 字以内，语言简练

直接输出报告内容。`,
    user: `班次：{{shift_id}}
操作员：{{operator}}
开始时间：{{start_time}}
结束时间：{{end_time}}
报警数量：{{alarm_count}}
处理工单：{{work_order_count}}
生产数据：{{production_data}}
特殊事件：{{incidents}}`,
    examples: [],
  },

  {
    id: "report_narrative",
    name: "报告文字描述",
    description: "根据数字指标生成人性化的报告叙述文字",
    outputFormat: "text",
    system: `你是数据分析报告助手。根据提供的指标数据，生成一段简洁的中文叙述。

要求：
1. 重点突出趋势变化和异常
2. 对比正常值或上期数据
3. 给出简单的原因推断
4. 100-200 字，语言平实

直接输出叙述段落。`,
    user: `报告标题：{{title}}
统计周期：{{period}}
核心指标：
{{metrics}}

与上期对比：{{comparison}}`,
    examples: [],
  },
];

// ── createPromptTemplateRegistry ─────────────────────────────────────────

export function createPromptTemplateRegistry(): PromptTemplateRegistry {
  const store = new Map<string, PromptTemplate>();

  // 注册内置模板
  for (const t of BUILTIN_TEMPLATES) {
    store.set(t.id, t);
  }

  return {
    register(template) {
      store.set(template.id, template);
    },

    get(id) {
      return store.get(id);
    },

    list() {
      return [...store.values()];
    },

    render(id, variables) {
      const template = store.get(id);
      if (!template) {
        throw new Error(`Prompt template not found: ${id}`);
      }
      return {
        system: renderTemplate(template.system, variables),
        user: renderTemplate(template.user, variables),
        template_name: template.name,
      };
    },
  };
}

/** 全局默认模板注册表 */
export const defaultPromptTemplateRegistry = createPromptTemplateRegistry();
