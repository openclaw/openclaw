/**
 * scaffold-engine.ts — 弱模型脚手架引擎
 *
 * 核心思想：强模型（离线/初始化时）预生成 Prompt 模板、决策表、Skill 脚本，
 * 弱模型（在线/实时时）只需"填空+规则匹配+结构化输出"即可可靠响应。
 *
 * 分工：
 *   强模型（Claude/GPT）离线生成 → ScaffoldAsset（存内存/注册表）
 *   弱模型（Qwen 7B/35B）在线执行 → 调用预制模板，不自由推理
 *
 * 资产类型：
 *   prompt_template  — 少样本 Prompt，弱模型"填空式"调用
 *   decision_table   — 确定性规则表，完全不调 LLM
 *   skill_script     — 纯函数实现，替代 LLM 处理确定性任务
 *   playbook         — YAML Playbook，强模型生成整套流程
 *   few_shot         — Few-shot 示例集，提升弱模型精度
 */

import type { ClaworksRuntime } from "../claworks/runtime-types.js";

// ── 类型定义 ──────────────────────────────────────────────────────────────

export type ScaffoldAssetType =
  | "playbook"
  | "prompt_template"
  | "decision_table"
  | "skill_script"
  | "few_shot";

export type ScaffoldAsset = {
  id: string;
  type: ScaffoldAssetType;
  name: string;
  description: string;
  /** YAML / TypeScript / JSON / prompt 内容 */
  content: string;
  domain?: string;
  task_type?: string;
  generated_by: string;
  generated_at: Date;
  validated: boolean;
  usage_count: number;
  success_rate: number;
};

export type ScaffoldGenerateResult = {
  playbooks: number;
  prompt_templates: number;
  decision_tables: number;
  skills: number;
};

export interface ScaffoldEngine {
  /** 为某个领域批量生成脚手架（调用强模型，适合离线/初始化时执行） */
  generateDomainScaffold(domain: string, context?: string): Promise<ScaffoldGenerateResult>;

  /** 生成单个少样本 Prompt 模板，让弱模型"有样学样" */
  generatePromptTemplate(
    taskType: string,
    examples: string[],
    opts?: { outputSchema?: unknown; model?: string },
  ): Promise<ScaffoldAsset>;

  /** 从示例中提炼决策表，把模糊 LLM 判断变成确定性规则 */
  generateDecisionTable(
    scenario: string,
    examples: Array<{ input: unknown; output: unknown }>,
  ): Promise<ScaffoldAsset>;

  /** 生成 Skill 脚本（确定性函数，不调 LLM） */
  generateSkillScript(capability: string, description: string): Promise<ScaffoldAsset>;

  /**
   * 从工业 scaffold JSON 格式加载资产（支持 prompt_template/{variable} 占位符格式）。
   * 可在 Pack entry.ts 或 loader 中调用，把磁盘 JSON 文件注册到运行时。
   */
  loadFromJson(data: Record<string, unknown>): ScaffoldAsset;

  get(id: string): ScaffoldAsset | undefined;
  list(filter?: { type?: string; domain?: string; task_type?: string }): ScaffoldAsset[];

  /** 记录使用情况，用于成功率统计 */
  recordUsage(id: string, success: boolean): void;

  /** 将资产部署到 Runtime（注册到 promptRegistry / playbookEngine 等） */
  deploy(asset: ScaffoldAsset): Promise<void>;
}

// ── 工厂函数 ──────────────────────────────────────────────────────────────

export function createScaffoldEngine(runtime: ClaworksRuntime): ScaffoldEngine {
  const assets = new Map<string, ScaffoldAsset>();

  /** 调用 LLM（优先 bridge.llm，回退 runtime.llmComplete） */
  async function callLlm(prompt: string): Promise<string> {
    const completeFn = runtime.bridges?.get("llm")?.complete ?? runtime.llmComplete;
    if (!completeFn) {
      return JSON.stringify({ error: "no_llm", note: "LLM 未配置，无法生成脚手架" });
    }
    const result = await completeFn({ prompt });
    return result.text;
  }

  /** 从 LLM 输出中提取 JSON 对象 */
  function extractJson(text: string): Record<string, unknown> | null {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  const engine: ScaffoldEngine = {
    async generateDomainScaffold(domain, context = "") {
      let promptTemplates = 0;
      let decisionTables = 0;

      // 生成意图分类少样本模板
      const intentPrompt = `你是工业机器人系统架构师，为本地弱模型（Qwen 7B/35B）预制脚手架。
目标：让弱模型通过"填空+多选"完成任务，而不是自由推理。

为 "${domain}" 领域生成一个意图分类少样本 Prompt 模板。

要求：
1. 列出 8-12 个典型意图类别（根据领域特点）
2. 每个类别附带 2-3 个典型用户输入示例
3. 弱模型只需做单选题，从类别列表中选一个
4. 强制 JSON 输出格式

${context ? `领域上下文：${context}` : ""}

以 JSON 格式返回：
{
  "system_prompt": "完整的 system prompt，含类别定义和 few-shot 示例",
  "user_template": "{{message}}",
  "intents": ["意图1", "意图2", "..."]
}`;

      try {
        const intentResult = await callLlm(intentPrompt);
        const intentData = extractJson(intentResult);
        if (intentData?.system_prompt) {
          const asset: ScaffoldAsset = {
            id: `scaffold-intent-${domain}`,
            type: "prompt_template",
            name: `${domain} 意图分类模板`,
            description: `为 ${domain} 领域预制的意图分类少样本提示词，弱模型填空使用`,
            content: JSON.stringify(intentData),
            domain,
            task_type: "intent_classify",
            generated_by: "strong-model",
            generated_at: new Date(),
            validated: false,
            usage_count: 0,
            success_rate: 1.0,
          };
          assets.set(asset.id, asset);
          await engine.deploy(asset);
          promptTemplates++;
        }
      } catch {
        // 强模型调用失败时记录内置兜底模板
        const fallbackAsset: ScaffoldAsset = {
          id: `scaffold-intent-${domain}`,
          type: "prompt_template",
          name: `${domain} 意图分类（内置兜底）`,
          description: `${domain} 领域意图分类模板（强模型不可用时的兜底版本）`,
          content: JSON.stringify({
            system_prompt: `你是 ${domain} 领域助手。将用户消息分类到以下意图之一，只输出 JSON。\n输出：{"intent":"类别名","confidence":0.0-1.0}`,
            user_template: "{{message}}",
            intents: ["query", "create", "update", "alarm", "report", "unknown"],
          }),
          domain,
          task_type: "intent_classify",
          generated_by: "builtin-fallback",
          generated_at: new Date(),
          validated: true,
          usage_count: 0,
          success_rate: 0.8,
        };
        assets.set(fallbackAsset.id, fallbackAsset);
        await engine.deploy(fallbackAsset);
        promptTemplates++;
      }

      // 生成领域决策表（快速意图路由）
      const tablePrompt = `为 "${domain}" 领域生成一个关键词快速路由决策表。
目标：常见指令通过关键词匹配直接路由，完全不调 LLM，响应时间 <1ms。

输出 JSON：
{
  "rules": [
    {"keywords": ["帮助", "功能", "help"], "intent": "help", "confidence": 0.99},
    {"keywords": ["报警", "告警", "异常"], "intent": "alarm_query", "confidence": 0.95},
    ...至少 8 条规则...
  ]
}`;

      try {
        const tableResult = await callLlm(tablePrompt);
        const tableData = extractJson(tableResult);
        if (tableData?.rules) {
          const asset: ScaffoldAsset = {
            id: `scaffold-rules-${domain}`,
            type: "decision_table",
            name: `${domain} 快速路由规则`,
            description: `${domain} 领域关键词快速路由，0ms 直接命中，不调 LLM`,
            content: JSON.stringify(tableData),
            domain,
            task_type: "intent_routing",
            generated_by: "strong-model",
            generated_at: new Date(),
            validated: false,
            usage_count: 0,
            success_rate: 1.0,
          };
          assets.set(asset.id, asset);
          decisionTables++;
        }
      } catch {
        // 决策表生成失败时跳过
      }

      return {
        playbooks: 0,
        prompt_templates: promptTemplates,
        decision_tables: decisionTables,
        skills: 0,
      };
    },

    async generatePromptTemplate(taskType, examples, opts = {}) {
      const schemaHint = opts.outputSchema
        ? `\n输出 JSON Schema: ${JSON.stringify(opts.outputSchema)}`
        : "";
      const examplesText = examples.map((e, i) => `示例${i + 1}: ${e}`).join("\n");

      const prompt = `为 "${taskType}" 任务生成少样本 Prompt 模板，让弱模型（Qwen 35B）可靠执行。

已有示例：
${examplesText || "（无示例，请基于任务类型推断）"}
${schemaHint}

设计原则：
1. system prompt 明确列出所有可能输出选项
2. 包含 3-5 个 few-shot 示例
3. 强制弱模型输出 JSON 格式
4. 避免开放式推理，改为多选/填空

输出 JSON：
{
  "system_prompt": "完整的系统提示词，含 few-shot 示例...",
  "user_template": "用户输入模板，含 {{variable}} 占位符",
  "few_shots": [{"input": "...", "output": "..."}]
}`;

      const result = await callLlm(prompt);
      const data = extractJson(result) ?? {
        system_prompt: result,
        user_template: "{{text}}",
        few_shots: [],
      };

      const asset: ScaffoldAsset = {
        id: `scaffold-prompt-${taskType}-${Date.now()}`,
        type: "prompt_template",
        name: `${taskType} 提示词模板`,
        description: `为弱模型预制的 ${taskType} 任务少样本提示词`,
        content: JSON.stringify(data),
        task_type: taskType,
        generated_by: "strong-model",
        generated_at: new Date(),
        validated: false,
        usage_count: 0,
        success_rate: 1.0,
      };
      assets.set(asset.id, asset);
      return asset;
    },

    async generateDecisionTable(scenario, examples) {
      const examplesText = examples
        .map((e) => `  输入: ${JSON.stringify(e.input)} → 输出: ${JSON.stringify(e.output)}`)
        .join("\n");

      const prompt = `基于以下示例，为 "${scenario}" 场景生成确定性决策表。
目标：把模糊的 AI 判断转换成零 LLM 调用的规则匹配。

示例：
${examplesText || "（无示例，请基于场景推断典型规则）"}

输出 JSON（规则按优先级排列）：
{
  "id": "table_id",
  "name": "决策表名称",
  "rules": [
    {
      "id": "rule_1",
      "priority": 100,
      "condition": {"field": "字段名", "op": "contains|eq|in", "value": "匹配值"},
      "action": {"kind": "return|publish_event", "params": {"key": "value"}},
      "stopOnMatch": true
    }
  ]
}`;

      const result = await callLlm(prompt);
      const data = extractJson(result) ?? { id: `dt-${Date.now()}`, name: scenario, rules: [] };

      const asset: ScaffoldAsset = {
        id: `scaffold-dt-${scenario.replace(/[^a-z0-9]/gi, "_")}-${Date.now()}`,
        type: "decision_table",
        name: scenario,
        description: `为 ${scenario} 预制的确定性决策表，零 LLM 调用`,
        content: JSON.stringify(data),
        task_type: scenario,
        generated_by: "strong-model",
        generated_at: new Date(),
        validated: false,
        usage_count: 0,
        success_rate: 1.0,
      };
      assets.set(asset.id, asset);
      return asset;
    },

    async generateSkillScript(capability, description) {
      const fnName = capability.replace(/[^a-zA-Z0-9]/g, "_");
      const prompt = `为 "${capability}" 能力生成确定性 TypeScript 实现（不调 LLM）。

功能描述：${description}

要求：
1. 纯函数，无副作用
2. 所有逻辑基于规则/数据处理，不调 LLM
3. 参数和返回值都是 Record<string, unknown>

返回 JSON：
{
  "function_name": "${fnName}",
  "implementation": "完整 TypeScript 函数代码（export function ${fnName}...）",
  "params_description": "参数说明"
}`;

      const result = await callLlm(prompt);
      const data = extractJson(result) ?? { function_name: fnName, implementation: result };

      const asset: ScaffoldAsset = {
        id: `scaffold-skill-${fnName}-${Date.now()}`,
        type: "skill_script",
        name: `${capability} skill`,
        description,
        content: JSON.stringify(data),
        task_type: capability,
        generated_by: "strong-model",
        generated_at: new Date(),
        validated: false,
        usage_count: 0,
        success_rate: 1.0,
      };
      assets.set(asset.id, asset);
      return asset;
    },

    loadFromJson(data) {
      const id = String(data.id ?? `scaffold-json-${Date.now()}`);
      const asset: ScaffoldAsset = {
        id,
        type: "prompt_template",
        name: String(data.name ?? data.description ?? id),
        description: String(data.description ?? ""),
        content: JSON.stringify(data),
        domain: data.domain ? String(data.domain) : undefined,
        task_type: data.task_type ? String(data.task_type) : undefined,
        generated_by: String(data.generated_by ?? "json-load"),
        generated_at: new Date(),
        validated: true,
        usage_count: 0,
        success_rate: 1.0,
      };
      assets.set(id, asset);
      return asset;
    },

    get: (id) => assets.get(id),

    list(filter = {}) {
      let result = [...assets.values()];
      if (filter.type) {
        result = result.filter((a) => a.type === filter.type);
      }
      if (filter.domain) {
        result = result.filter((a) => a.domain === filter.domain);
      }
      if (filter.task_type) {
        result = result.filter((a) => a.task_type === filter.task_type);
      }
      return result;
    },

    recordUsage(id, success) {
      const a = assets.get(id);
      if (!a) {
        return;
      }
      const successes = Math.round(a.success_rate * a.usage_count) + (success ? 1 : 0);
      a.usage_count += 1;
      a.success_rate = a.usage_count > 0 ? successes / a.usage_count : 1.0;
    },

    async deploy(asset) {
      if (asset.type === "prompt_template" && runtime.promptRegistry) {
        // 从 JSON 内容提取 system_prompt，组合成完整 prompt 字符串注册
        let templateStr = asset.content;
        try {
          const parsed = JSON.parse(asset.content) as Record<string, unknown>;
          const sys = String(parsed.system_prompt ?? "");
          const user = String(parsed.user_template ?? "{{text}}");
          // 构建完整 prompt 供 render 调用时直接传给 LLM
          templateStr = `${sys}\n\n用户：${user}`;
        } catch {
          // 非 JSON 内容直接作为模板
        }
        runtime.promptRegistry.register(asset.id, templateStr, asset.description);
        if (asset.task_type) {
          // 同时用 task_type 注册一个别名，方便按任务类型查找
          runtime.promptRegistry.register(asset.task_type, templateStr, asset.description);
        }
      } else if (asset.type === "decision_table") {
        // 注册到规则引擎（如果规则引擎支持 addTable）
        if (runtime.ruleEngine) {
          try {
            const tableData = JSON.parse(asset.content) as Record<string, unknown>;
            if (
              typeof runtime.ruleEngine.addRule === "function" &&
              Array.isArray(tableData.rules)
            ) {
              for (const rule of tableData.rules as Array<Record<string, unknown>>) {
                runtime.ruleEngine.addRule(String(tableData.id ?? "default"), {
                  ...(rule as import("./rule-engine.js").Rule),
                });
              }
            }
          } catch {
            // 规则引擎注册失败时忽略
          }
        }
      }
    },
  };

  return engine;
}
