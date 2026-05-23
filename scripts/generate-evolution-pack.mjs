#!/usr/bin/env node
/**
 * generate-evolution-pack.mjs — ClaWorks 进化包生成器
 *
 * 在有互联网连接的机器上运行，将私域机器人导出的进化数据转化为改进包。
 *
 * 使用流程：
 *   1. 从私域机器人导出数据：
 *      claworks evolution export --days 30 --output evolution-data.json
 *
 *   2. 将 evolution-data.json 传输到有网络的机器（USB/SCP/邮件）
 *
 *   3. 在有网络的机器上运行（需设置 API Key）：
 *      ANTHROPIC_API_KEY=sk-ant-... node scripts/generate-evolution-pack.mjs \
 *        --input evolution-data.json --output evolution-pack.json
 *      # 或使用 OpenAI / 兼容接口：
 *      OPENAI_API_KEY=sk-... OPENAI_BASE_URL=https://api.example.com/v1 \
 *        node scripts/generate-evolution-pack.mjs \
 *        --input evolution-data.json --output evolution-pack.json --model gpt-4o
 *      # 预览模式（不调用 LLM，不写文件）：
 *      node scripts/generate-evolution-pack.mjs --input evolution-data.json --dry-run
 *
 *   4. 将生成的 JSON 传输回私域机器人
 *
 *   5. 导入进化包（热更新，无需重启）：
 *      claworks evolution import evolution-pack.json
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// ── CLI 参数解析 ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    input: null,
    output: null,
    model: null,
    dryRun: false,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--input":
      case "-i":
        result.input = args[++i];
        break;
      case "--output":
      case "-o":
        result.output = args[++i];
        break;
      case "--model":
      case "-m":
        result.model = args[++i];
        break;
      case "--dry-run":
        result.dryRun = true;
        break;
      default:
        // 兼容旧的位置参数：第一个非 flag 参数作为 input
        if (!args[i].startsWith("-") && !result.input) {
          result.input = args[i];
        }
    }
  }
  return result;
}

const cliArgs = parseArgs(process.argv);

// ── API 配置 ────────────────────────────────────────────────────────────────

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(
  /\/+$/,
  "",
);

if (!cliArgs.dryRun && !ANTHROPIC_KEY && !OPENAI_KEY) {
  console.error("错误：需要设置 ANTHROPIC_API_KEY 或 OPENAI_API_KEY 环境变量");
  console.error("提示：可以使用 --dry-run 预览数据而不调用 LLM");
  process.exit(1);
}

const USE_ANTHROPIC = Boolean(ANTHROPIC_KEY) && !OPENAI_KEY;
const DEFAULT_MODEL = USE_ANTHROPIC ? "claude-sonnet-4-5" : "gpt-4o";
const MODEL = cliArgs.model ?? DEFAULT_MODEL;

// ── 主流程 ───────────────────────────────────────────────────────────────────

const inputFile = cliArgs.input ?? "evolution-data.json";
const outputFile = cliArgs.output ?? `evolution-pack-${Date.now()}.json`;

await generateEvolutionPack(inputFile, outputFile, cliArgs.dryRun);

async function generateEvolutionPack(inputFile, outputFile, dryRun) {
  /** @type {import('../packages/claworks-runtime/src/kernel/evolution-sync.js').EvolutionExportData} */
  let exportData;
  try {
    exportData = JSON.parse(readFileSync(inputFile, "utf-8"));
  } catch (err) {
    console.error(`错误：无法读取文件 ${inputFile}: ${err.message}`);
    process.exit(1);
  }

  if (exportData.version !== "1.0") {
    console.error(`错误：进化数据版本不兼容（需要 "1.0"，实际为 "${exportData.version}"）`);
    process.exit(1);
  }

  const failureCount = exportData.failed_executions?.length ?? 0;
  const intentCount = exportData.low_confidence_intents?.length ?? 0;
  const hitlCount = exportData.hitl_decisions?.length ?? 0;
  const feedbackCount = exportData.feedback_records?.length ?? 0;

  console.log(`\n📊 进化数据来自机器人 "${exportData.robot_id}"`);
  console.log(`   导出时间：${exportData.exported_at}`);
  console.log(`   失败执行记录：${failureCount} 条`);
  console.log(`   低置信度意图：${intentCount} 条`);
  console.log(`   HITL 决策记录：${hitlCount} 条`);
  console.log(`   用户反馈：${feedbackCount} 条`);
  console.log(`   Playbook 清单：${exportData.playbook_manifest?.length ?? 0} 个`);

  if (dryRun) {
    console.log("\n🔍 Dry-run 模式：仅预览数据，不调用 LLM，不写入文件。\n");
    previewData(exportData);
    return;
  }

  console.log(
    `\n🤖 使用模型：${MODEL}（${USE_ANTHROPIC ? "Anthropic" : `OpenAI 兼容 ${OPENAI_BASE_URL}`}）\n`,
  );

  const generatedAt = new Date().toISOString();

  /** @type {import('../packages/claworks-runtime/src/kernel/evolution-sync.js').EvolutionPack} */
  const pack = {
    version: "1.0",
    generated_at: generatedAt,
    generated_by: MODEL,
    source_robot_id: exportData.robot_id,
    improved_playbooks: [],
    updated_rule_tables: [],
    improved_prompt_templates: [],
    kb_additions: [],
    summary: "",
  };

  // ── A. 分析失败执行 → 生成修复版 Playbook ──────────────────────────────

  const failures = exportData.failed_executions ?? [];
  if (failures.length > 0) {
    console.log("🔧 [A] 分析失败执行，生成修复版 Playbook...");
    const failuresByPlaybook = groupBy(failures, (f) => f.playbook_id);
    // 只处理失败 >= 2 次的，最多 10 个
    const frequentFailures = Object.entries(failuresByPlaybook)
      .filter(([, list]) => list.length >= 2)
      .sort(([, a], [, b]) => b.length - a.length)
      .slice(0, 10);

    if (frequentFailures.length > 0) {
      const batches = chunk(frequentFailures, 10);
      for (const batch of batches) {
        const prompt = buildPlaybookFixPrompt(batch, exportData.playbook_manifest ?? []);
        const raw = await callModel(prompt);
        const improved = safeParseArray(raw);
        if (improved.length > 0) {
          pack.improved_playbooks.push(...improved);
          console.log(`   ✅ 生成 ${improved.length} 个修复版 Playbook`);
        } else {
          console.log("   ⚠️  无法解析 Playbook 改进（原始响应已跳过）");
        }
      }
    } else {
      console.log("   ℹ️  无频繁失败（≥2次）的 Playbook，跳过");
    }
  }

  // ── B. 低置信度意图 → 改进 scaffold/few-shot ──────────────────────────

  const lowIntents = exportData.low_confidence_intents ?? [];
  if (lowIntents.length >= 3) {
    console.log("🧠 [B] 分析低置信度意图，生成改进 few-shot 和规则表...");
    const batches = chunk(lowIntents, 10);
    for (const batch of batches) {
      const prompt = buildIntentImprovementPrompt(batch);
      const raw = await callModel(prompt);
      // 期望返回 { rule_table?: {...}, prompt_template?: {...} }
      const result = safeParseObject(raw);
      if (result?.rule_table?.name) {
        pack.updated_rule_tables.push(result.rule_table);
        console.log(`   ✅ 生成规则表：${result.rule_table.name}`);
      }
      if (result?.prompt_template?.id && result.prompt_template.template) {
        pack.improved_prompt_templates.push(result.prompt_template);
        console.log(`   ✅ 生成提示词模板：${result.prompt_template.id}`);
      }
      if (!result?.rule_table && !result?.prompt_template) {
        console.log("   ⚠️  无法解析意图改进结果");
      }
    }
  } else if (lowIntents.length > 0) {
    console.log(`   ℹ️  低置信度意图数量不足（${lowIntents.length} < 3），跳过`);
  }

  // ── C. HITL 决策模式 → 生成新 Rule ────────────────────────────────────

  const hitlDecisions = exportData.hitl_decisions ?? [];
  const modifiedOrRejected = hitlDecisions.filter(
    (d) => d.decision === "modified" || d.decision === "rejected",
  );
  if (modifiedOrRejected.length >= 3) {
    console.log("📋 [C] 分析 HITL 决策模式，生成改进 Rule...");
    const batches = chunk(modifiedOrRejected, 10);
    for (const batch of batches) {
      const prompt = buildHitlRulePrompt(batch);
      const raw = await callModel(prompt);
      const table = safeParseObject(raw);
      if (table?.name) {
        pack.updated_rule_tables.push(table);
        console.log(`   ✅ 生成 HITL 规则表：${table.name}`);
      } else {
        console.log("   ⚠️  无法解析 HITL 规则");
      }
    }
  } else if (modifiedOrRejected.length > 0) {
    console.log(`   ℹ️  HITL 修改/拒绝记录不足（${modifiedOrRejected.length} < 3），跳过`);
  }

  // ── D. 负向反馈 → 生成改进建议（KB 条目） ─────────────────────────────

  const feedbackRecords = exportData.feedback_records ?? [];
  const negativeFeedback = feedbackRecords.filter((f) => f.feedback_score <= 2);
  if (negativeFeedback.length >= 2) {
    console.log("💬 [D] 分析负向反馈，生成改进建议...");
    const batches = chunk(negativeFeedback, 10);
    for (const batch of batches) {
      const prompt = buildFeedbackImprovementPrompt(batch);
      const raw = await callModel(prompt);
      const items = safeParseArray(raw);
      if (items.length > 0) {
        pack.kb_additions.push(...items);
        console.log(`   ✅ 生成 ${items.length} 条改进建议（KB 条目）`);
      } else {
        console.log("   ⚠️  无法解析反馈改进建议");
      }
    }
  } else if (feedbackRecords.length > 0) {
    console.log(`   ℹ️  负向反馈不足（${negativeFeedback.length} < 2），跳过`);
  }

  // ── E. 综合生成 KB 补充（失败场景处理知识） ──────────────────────────

  if (failures.length > 0 || lowIntents.length > 0) {
    console.log("📚 [E] 生成通用知识库补充条目...");
    const prompt = buildKbAdditionsPrompt(failures, lowIntents);
    const raw = await callModel(prompt);
    const items = safeParseArray(raw);
    if (items.length > 0) {
      pack.kb_additions.push(...items);
      console.log(`   ✅ 生成 ${items.length} 条 KB 补充`);
    }
  }

  // ── 汇总 ────────────────────────────────────────────────────────────────

  const summaryParts = [];
  if (pack.improved_playbooks.length > 0)
    summaryParts.push(`${pack.improved_playbooks.length} 个改进 Playbook`);
  if (pack.updated_rule_tables.length > 0)
    summaryParts.push(`${pack.updated_rule_tables.length} 个规则表更新`);
  if (pack.improved_prompt_templates.length > 0)
    summaryParts.push(`${pack.improved_prompt_templates.length} 个提示词模板优化`);
  if (pack.kb_additions.length > 0) summaryParts.push(`${pack.kb_additions.length} 条 KB 新增`);

  pack.summary =
    summaryParts.length > 0
      ? `本次进化包包含：${summaryParts.join("、")}`
      : "本次分析未发现需要改进的内容（机器人运行良好！）";

  // ── 计算签名 ─────────────────────────────────────────────────────────────

  const packJson = JSON.stringify(pack);
  const signature = createHash("sha256")
    .update(packJson + generatedAt)
    .digest("hex");

  // 签名附加在顶层（非 EvolutionPack 接口字段，供人工验证）
  const outputPayload = { ...pack, _signature: signature };

  // ── 写出结果 ─────────────────────────────────────────────────────────────

  writeFileSync(outputFile, JSON.stringify(outputPayload, null, 2), "utf-8");

  console.log(`\n✅ 进化包已写入：${outputFile}`);
  console.log(`   ${pack.summary}`);
  console.log(`   SHA256 签名：${signature.slice(0, 16)}...`);
  console.log(`\n下一步：将文件传输到私域机器人，运行：`);
  console.log(`   claworks evolution import ${outputFile}`);
}

// ── 预览模式 ─────────────────────────────────────────────────────────────────

function previewData(data) {
  const failuresByPlaybook = groupBy(data.failed_executions ?? [], (f) => f.playbook_id);
  const frequentFailures = Object.entries(failuresByPlaybook)
    .filter(([, list]) => list.length >= 2)
    .sort(([, a], [, b]) => b.length - a.length);

  console.log("=== 预览：需要处理的数据 ===\n");
  console.log(`[A] 频繁失败 Playbook（≥2次）：${frequentFailures.length} 个`);
  for (const [id, list] of frequentFailures.slice(0, 5)) {
    const errorTypes = [...new Set(list.map((f) => f.error_type))].join(", ");
    console.log(`   • ${id}: ${list.length} 次失败（${errorTypes}）`);
  }

  const lowIntents = data.low_confidence_intents ?? [];
  console.log(`\n[B] 低置信度意图：${lowIntents.length} 条`);
  for (const i of lowIntents.slice(0, 3)) {
    console.log(
      `   • "${i.text_preview}" → ${i.classified_intent}（置信度 ${i.confidence?.toFixed(2)}）`,
    );
  }

  const hitlModified = (data.hitl_decisions ?? []).filter(
    (d) => d.decision === "modified" || d.decision === "rejected",
  );
  console.log(`\n[C] HITL 修改/拒绝记录：${hitlModified.length} 条`);

  const negFeedback = (data.feedback_records ?? []).filter((f) => f.feedback_score <= 2);
  console.log(`\n[D] 负向反馈（评分≤2）：${negFeedback.length} 条`);
}

// ── Prompt 构建 ──────────────────────────────────────────────────────────────

function buildPlaybookFixPrompt(frequentFailures, playbookManifest) {
  const failureSummaries = frequentFailures.map(([id, list]) => ({
    playbook_id: id,
    failure_count: list.length,
    error_types: [...new Set(list.map((f) => f.error_type))],
    steps_reached: [...new Set(list.map((f) => f.step_reached))],
    trigger_types: [...new Set(list.map((f) => f.trigger_type))],
  }));

  const relevantManifest = playbookManifest.filter((p) =>
    frequentFailures.some(([id]) => id === p.id),
  );

  return `你是 ClaWorks 机器人 Playbook 工程师，擅长修复工业/企业场景的自动化工作流。

以下是频繁失败的 Playbook（失败 ≥ 2 次）：
${JSON.stringify(failureSummaries, null, 2)}

当前 Playbook 清单（参考）：
${JSON.stringify(relevantManifest, null, 2)}

请为每个失败 Playbook 生成完整的修复版本。修复原则：
- capability_not_found / action_not_found：添加 on_failure: continue，并在末尾加兜底 notify 步骤
- timeout：为相关步骤添加 timeout_seconds: 30，并加重试逻辑
- permission_denied：添加 HITL 步骤请求人工授权
- 通用：添加 on_failure 策略

每个 Playbook 必须是完整格式（含 id/pack/trigger/steps）。

返回 JSON 数组，每个元素格式：
{
  "id": "playbook_id",
  "name": "可读名称",
  "pack": "user_evolved",
  "version": "1.0",
  "trigger": { "kind": "event|im_message|schedule", "pattern": "..." },
  "steps": [
    { "id": "step_id", "kind": "action|hitl|condition|llm", ... }
  ]
}

只返回 JSON 数组，不要任何解释。`;
}

function buildIntentImprovementPrompt(lowIntents) {
  const samples = lowIntents.map((i) => ({
    text_preview: i.text_preview,
    classified_intent: i.classified_intent,
    confidence: i.confidence,
    actual_outcome: i.actual_outcome,
  }));

  return `你是 ClaWorks 意图识别工程师，负责改善企业 IM 机器人的意图分类准确率。

以下是低置信度意图样本（置信度 < 0.6）：
${JSON.stringify(samples, null, 2)}

请生成两项改进：
1. 改进的 im.quick_rules 规则表（关键词→意图快速映射，LLM 前置过滤）
2. 改进的 intent_classify 提示词模板（含 few-shot 示例）

返回 JSON 对象：
{
  "rule_table": {
    "name": "im.quick_rules",
    "description": "IM 意图快速规则表（进化版）",
    "columns": ["condition", "intent", "confidence", "description"],
    "rows": [
      { "condition": "关键词或正则", "intent": "意图名", "confidence": 0.9, "description": "说明" }
    ]
  },
  "prompt_template": {
    "id": "intent_classify",
    "description": "意图分类提示词（few-shot 增强版）",
    "template": "你是 ClaWorks 意图分类器...\\n示例：\\n用户：...\\n意图：...\\n用户：{{message}}\\n意图："
  }
}

只返回 JSON，不要任何解释。`;
}

function buildHitlRulePrompt(hitlDecisions) {
  const samples = hitlDecisions.map((d) => ({
    context_type: d.context_type,
    decision: d.decision,
    modification_hint: d.modification_hint,
    timestamp: d.timestamp,
  }));

  return `你是 ClaWorks 规则引擎专家，负责从人工审核记录中提炼自动化规则。

以下是人工审核人员修改或拒绝的机器人行为记录：
${JSON.stringify(samples, null, 2)}

基于这些记录，生成一个新的决策规则表，让机器人在相似场景下自动做出正确决策，
减少需要人工干预的情况。

返回 JSON 对象：
{
  "name": "hitl.auto_decision_rules",
  "description": "HITL 决策自动化规则表（基于历史审核模式）",
  "columns": ["context_type", "condition", "auto_decision", "confidence", "rationale"],
  "rows": [
    {
      "context_type": "场景类型",
      "condition": "触发条件（正则或关键词）",
      "auto_decision": "approve|reject|escalate",
      "confidence": 0.85,
      "rationale": "规则依据"
    }
  ]
}

只返回 JSON，不要任何解释。`;
}

function buildFeedbackImprovementPrompt(negativeFeedback) {
  const samples = negativeFeedback.map((f) => ({
    interaction_type: f.interaction_type,
    feedback_score: f.feedback_score,
    feedback_hint: f.feedback_hint,
    timestamp: f.timestamp,
  }));

  return `你是 ClaWorks 用户体验改进专家，负责分析负向反馈并生成改进建议。

以下是用户评分 ≤ 2 的负向反馈记录：
${JSON.stringify(samples, null, 2)}

请分析失败模式，生成 2-5 条具体的改进建议，每条作为知识库条目。
重点关注：
- 哪类交互类型最容易引发负向反馈
- 机器人可以改变什么行为来避免负向评价
- 推荐的应对策略（含具体话术或步骤）

返回 JSON 数组：
[
  {
    "id": "feedback_kb_<number>",
    "content": "改进建议详细内容（含触发场景、问题描述、推荐策略）",
    "tags": ["feedback", "improvement"],
    "source": "evolution-pack-feedback"
  }
]

只返回 JSON 数组，不要任何解释。`;
}

function buildKbAdditionsPrompt(failures, lowIntents) {
  const errorTypes = [...new Set(failures.map((f) => f.error_type))].slice(0, 5);
  const intents = [...new Set(lowIntents.map((i) => i.classified_intent))].slice(0, 5);

  return `你是 ClaWorks 知识库维护者，负责补充机器人处理边缘场景的知识。

机器人遇到了以下问题：
- 执行失败类型：${errorTypes.join("、") || "无"}
- 低置信度意图：${intents.join("、") || "无"}

请生成 2-4 条知识库条目，帮助机器人更好地处理这些场景。
每条应包含：问题场景描述、推荐处理方式、注意事项。

返回 JSON 数组：
[
  {
    "id": "kb_evolved_<number>",
    "content": "知识条目内容（场景描述 + 处理建议 + 注意事项）",
    "tags": ["evolved", "edge-case"],
    "source": "evolution-pack"
  }
]

只返回 JSON 数组，不要任何解释。`;
}

// ── LLM 调用 ─────────────────────────────────────────────────────────────────

async function callModel(prompt) {
  if (USE_ANTHROPIC) {
    return callAnthropic(prompt);
  }
  return callOpenAICompat(prompt);
}

async function callAnthropic(prompt) {
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Anthropic API ${resp.status}: ${err.slice(0, 300)}`);
    }
    const data = await resp.json();
    return data.content?.[0]?.text ?? "{}";
  } catch (err) {
    console.error(`   ⚠️  Anthropic 调用失败: ${err.message}`);
    return "{}";
  }
}

async function callOpenAICompat(prompt) {
  try {
    const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`OpenAI 兼容 API ${resp.status}: ${err.slice(0, 300)}`);
    }
    const data = await resp.json();
    return data.choices?.[0]?.message?.content ?? "{}";
  } catch (err) {
    console.error(`   ⚠️  OpenAI 兼容接口调用失败: ${err.message}`);
    return "{}";
  }
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

function safeParseArray(raw) {
  try {
    const parsed = JSON.parse(extractJson(raw));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeParseObject(raw) {
  try {
    const parsed = JSON.parse(extractJson(raw));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 从模型输出中提取最外层 JSON（兼容 markdown 代码块包裹的情况） */
function extractJson(text) {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const startBrace = stripped.indexOf("{");
  const startBracket = stripped.indexOf("[");
  let start = -1;
  if (startBrace >= 0 && (startBracket < 0 || startBrace < startBracket)) {
    start = startBrace;
  } else if (startBracket >= 0) {
    start = startBracket;
  }
  if (start < 0) return stripped;
  const endBrace = stripped.lastIndexOf("}");
  const endBracket = stripped.lastIndexOf("]");
  const end = Math.max(endBrace, endBracket);
  return end > start ? stripped.slice(start, end + 1) : stripped;
}

function groupBy(arr, keyFn) {
  const map = {};
  for (const item of arr) {
    const key = keyFn(item);
    (map[key] ??= []).push(item);
  }
  return map;
}

/** 将数组拆分为最大 size 的批次 */
function chunk(arr, size) {
  const result = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}
