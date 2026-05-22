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
 *      ANTHROPIC_API_KEY=sk-ant-... node scripts/generate-evolution-pack.mjs evolution-data.json
 *      # 或使用 OpenAI：
 *      OPENAI_API_KEY=sk-...         node scripts/generate-evolution-pack.mjs evolution-data.json
 *
 *   4. 将生成的 evolution-pack-<timestamp>.json 传输回私域机器人
 *
 *   5. 导入进化包（热更新，无需重启）：
 *      claworks evolution import evolution-pack-<timestamp>.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

// ── API 配置 ────────────────────────────────────────────────────────────────

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";

if (!ANTHROPIC_KEY && !OPENAI_KEY) {
  console.error("错误：需要设置 ANTHROPIC_API_KEY 或 OPENAI_API_KEY 环境变量");
  process.exit(1);
}

const USE_ANTHROPIC = Boolean(ANTHROPIC_KEY);
const MODEL = USE_ANTHROPIC ? "claude-sonnet-4-5" : "gpt-4o";

// ── 主流程 ───────────────────────────────────────────────────────────────────

const dataFile = process.argv[2] ?? "evolution-data.json";
await generateEvolutionPack(dataFile);

async function generateEvolutionPack(dataFile) {
  let exportData;
  try {
    exportData = JSON.parse(readFileSync(dataFile, "utf-8"));
  } catch (err) {
    console.error(`错误：无法读取文件 ${dataFile}: ${err.message}`);
    process.exit(1);
  }

  if (exportData.version !== "1.0") {
    console.error("错误：进化数据版本不兼容（需要 1.0）");
    process.exit(1);
  }

  console.log(`\n📊 正在处理来自机器人 "${exportData.robot_id}" 的进化数据...`);
  console.log(`   • 失败执行记录：${exportData.failed_executions?.length ?? 0} 条`);
  console.log(`   • 低置信度意图：${exportData.low_confidence_intents?.length ?? 0} 条`);
  console.log(`   • HITL 决策记录：${exportData.hitl_decisions?.length ?? 0} 条`);
  console.log(`   • 用户反馈：${exportData.feedback_records?.length ?? 0} 条`);
  console.log(`   • Playbook 清单：${exportData.playbook_manifest?.length ?? 0} 个`);
  console.log(`\n🤖 使用模型：${MODEL}\n`);

  /** @type {import('../packages/claworks-runtime/src/kernel/evolution-sync.js').EvolutionPack} */
  const pack = {
    version: "1.0",
    generated_at: new Date().toISOString(),
    generated_by: MODEL,
    source_robot_id: exportData.robot_id,
    improved_playbooks: [],
    updated_rule_tables: [],
    improved_prompt_templates: [],
    kb_additions: [],
    summary: "",
  };

  // ── 分析失败模式，生成改进的 Playbook ──────────────────────────────────

  const failures = exportData.failed_executions ?? [];
  if (failures.length > 0) {
    console.log("🔧 分析 Playbook 失败模式...");
    const failuresByPlaybook = groupBy(failures, (f) => f.playbook_id);
    const frequentFailures = Object.entries(failuresByPlaybook)
      .filter(([, list]) => list.length >= 2)
      .slice(0, 5);

    if (frequentFailures.length > 0) {
      const prompt = buildPlaybookImprovementPrompt(
        frequentFailures,
        exportData.playbook_manifest ?? [],
      );
      const raw = await callModel(prompt);
      const improved = safeParseArray(raw);
      if (improved.length > 0) {
        pack.improved_playbooks.push(...improved);
        console.log(`   ✅ 生成了 ${improved.length} 个改进的 Playbook`);
      } else {
        console.log("   ⚠️  无法解析 Playbook 改进建议");
      }
    } else {
      console.log("   ℹ️  没有频繁失败的 Playbook，跳过");
    }
  }

  // ── 分析低置信度意图，改进分类规则 ────────────────────────────────────

  const lowIntents = exportData.low_confidence_intents ?? [];
  if (lowIntents.length >= 5) {
    console.log("🧠 优化意图分类规则...");
    const prompt = buildRuleTablePrompt(lowIntents);
    const raw = await callModel(prompt);
    const table = safeParseObject(raw);
    if (table?.name) {
      pack.updated_rule_tables.push(table);
      console.log(`   ✅ 生成了改进的意图识别规则表: ${table.name}`);
    } else {
      console.log("   ⚠️  无法解析规则表改进");
    }
  }

  // ── 根据 HITL 纠正，优化提示词模板 ─────────────────────────────────────

  const modifiedDecisions = (exportData.hitl_decisions ?? []).filter(
    (d) => d.decision === "modified",
  );
  if (modifiedDecisions.length >= 3) {
    console.log("📝 优化提示词模板（基于人工纠正记录）...");
    const prompt = buildPromptTemplatePrompt(modifiedDecisions);
    const raw = await callModel(prompt);
    const template = safeParseObject(raw);
    if (template?.id && template?.template) {
      pack.improved_prompt_templates.push(template);
      console.log(`   ✅ 生成了改进的提示词模板: ${template.id}`);
    } else {
      console.log("   ⚠️  无法解析提示词模板改进");
    }
  }

  // ── 生成 KB 补充条目（常见失败场景的处理知识） ────────────────────────

  if (failures.length > 0 || lowIntents.length > 0) {
    console.log("📚 生成知识库补充条目...");
    const prompt = buildKbAdditionsPrompt(failures, lowIntents);
    const raw = await callModel(prompt);
    const items = safeParseArray(raw);
    if (items.length > 0) {
      pack.kb_additions.push(...items);
      console.log(`   ✅ 生成了 ${items.length} 条 KB 补充`);
    }
  }

  // ── 汇总 ────────────────────────────────────────────────────────────────

  const parts = [];
  if (pack.improved_playbooks.length > 0) {
    parts.push(`${pack.improved_playbooks.length} 个改进 Playbook`);
  }
  if (pack.updated_rule_tables.length > 0) {
    parts.push(`${pack.updated_rule_tables.length} 个规则表更新`);
  }
  if (pack.improved_prompt_templates.length > 0) {
    parts.push(`${pack.improved_prompt_templates.length} 个提示词模板优化`);
  }
  if (pack.kb_additions.length > 0) {
    parts.push(`${pack.kb_additions.length} 条 KB 新增`);
  }

  pack.summary =
    parts.length > 0
      ? `本次进化包包含：${parts.join("、")}`
      : "本次分析未发现需要改进的内容（机器人运行良好！）";

  // ── 写出结果 ─────────────────────────────────────────────────────────────

  const outputFile = `evolution-pack-${Date.now()}.json`;
  writeFileSync(outputFile, JSON.stringify(pack, null, 2), "utf-8");

  console.log(`\n✅ 进化包已生成：${outputFile}`);
  console.log(`   ${pack.summary}`);
  console.log(`\n下一步：将 ${outputFile} 传输到私域机器人，运行：`);
  console.log(`   claworks evolution import ${outputFile}`);
}

// ── Prompt 构建 ──────────────────────────────────────────────────────────────

function buildPlaybookImprovementPrompt(frequentFailures, playbookManifest) {
  return `你是 ClaWorks 机器人 Playbook 工程师。
以下是频繁失败的 Playbook 记录（失败次数 >= 2）：

${JSON.stringify(
  frequentFailures.map(([id, list]) => ({
    playbook_id: id,
    failure_count: list.length,
    error_types: [...new Set(list.map((f) => f.error_type))],
    step_reached: [...new Set(list.map((f) => f.step_reached))],
  })),
  null,
  2,
)}

当前 Playbook 清单（用于参考）：
${JSON.stringify(
  playbookManifest.filter((p) => frequentFailures.some(([id]) => id === p.id)),
  null,
  2,
)}

请为每个频繁失败的 Playbook 生成改进版本，重点：
1. 添加合适的 on_failure 处理策略（continue/retry/fallback）
2. 为可能超时的步骤添加 timeout_seconds
3. 为关键操作添加降级路径
4. 如果是 capability_not_found 错误，用 message.handle 作为兜底

返回 JSON 数组（每个元素是一个改进的 Playbook 对象）：
[{"id": "playbook_id", "name": "可读名称", "pack": "user_evolved", "trigger": {...}, "steps": [...]}]

只返回 JSON，不要任何解释文字。`;
}

function buildRuleTablePrompt(lowIntents) {
  return `你是 ClaWorks 规则引擎专家。
以下是机器人经常识别不准确的用户意图样本（置信度 < 0.6）：

${JSON.stringify(
  lowIntents.slice(0, 30).map((i) => ({
    text_preview: i.text_preview,
    classified_intent: i.classified_intent,
    confidence: i.confidence,
    actual_outcome: i.actual_outcome,
  })),
  null,
  2,
)}

请生成改进的 im.quick_rules 决策表，提高这些意图的识别准确率。
该表包含关键词→意图的映射规则，用于快速路由（LLM 调用前的前置过滤）。

返回格式（JSON 对象）：
{
  "name": "im.quick_rules",
  "description": "IM 意图快速规则表",
  "columns": ["condition", "intent", "confidence", "description"],
  "rows": [
    {"condition": "关键词或正则", "intent": "意图名称", "confidence": 0.9, "description": "说明"}
  ]
}

只返回 JSON，不要任何解释文字。`;
}

function buildPromptTemplatePrompt(modifiedDecisions) {
  return `你是 ClaWorks 提示词工程师。
以下是人工审核人员修改过的机器人响应记录，说明当前提示词存在不足：

${JSON.stringify(
  modifiedDecisions.slice(0, 20).map((d) => ({
    context_type: d.context_type,
    modification_hint: d.modification_hint,
    timestamp: d.timestamp,
  })),
  null,
  2,
)}

请基于这些纠正记录，生成改进的 intent_classify 提示词模板。
包含 few-shot 示例，避免已知的分类错误。

返回格式（JSON 对象）：
{
  "id": "intent_classify",
  "description": "意图分类提示词模板（改进版）",
  "template": "你是 ClaWorks 机器人助手...\\n用户消息：{{message}}\\n..."
}

只返回 JSON，不要任何解释文字。`;
}

function buildKbAdditionsPrompt(failures, lowIntents) {
  const errorTypes = [...new Set(failures.map((f) => f.error_type))].slice(0, 5);
  const intents = [...new Set(lowIntents.map((i) => i.classified_intent))].slice(0, 5);

  return `你是 ClaWorks 知识库维护者。
机器人遇到了以下问题类型：
- 失败类型：${errorTypes.join("、") || "无"}
- 低置信度意图：${intents.join("、") || "无"}

请生成 2-5 条知识库条目，帮助机器人更好地处理这些场景。
每条应包含：问题场景描述、推荐的处理方式、注意事项。

返回 JSON 数组：
[
  {
    "id": "kb_item_001",
    "content": "知识条目内容（含处理建议）",
    "source": "evolution-pack"
  }
]

只返回 JSON，不要任何解释文字。`;
}

// ── LLM 调用 ─────────────────────────────────────────────────────────────────

async function callModel(prompt) {
  try {
    if (USE_ANTHROPIC) {
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
        throw new Error(`Anthropic API 错误 ${resp.status}: ${err.slice(0, 200)}`);
      }
      const data = await resp.json();
      return data.content?.[0]?.text ?? "{}";
    } else {
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
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
        throw new Error(`OpenAI API 错误 ${resp.status}: ${err.slice(0, 200)}`);
      }
      const data = await resp.json();
      return data.choices?.[0]?.message?.content ?? "{}";
    }
  } catch (err) {
    console.error(`   ⚠️  模型调用失败: ${err.message}`);
    return "{}";
  }
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

function safeParseArray(raw) {
  try {
    const cleaned = extractJson(raw);
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeParseObject(raw) {
  try {
    const cleaned = extractJson(raw);
    const parsed = JSON.parse(cleaned);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractJson(text) {
  // 提取最外层 JSON（兼容模型在 markdown 代码块中返回的情况）
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  // 找到第一个 { 或 [
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
