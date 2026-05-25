#!/usr/bin/env node
/**
 * claworks-evolution-export-helper.mjs — 商业模型离线进化辅助（无 API Key）
 *
 * 读取 evolution export JSON（stdin 或 --input），输出：
 *   1) 结构化 prompt 模板（供运维粘贴到 Claude/GPT）
 *   2) EvolutionPack JSON 骨架（generated_by=manual_review）
 *
 * 用法：
 *   claworks evolution export --days 30 --output evolution-data.json
 *   node scripts/claworks-evolution-export-helper.mjs --input evolution-data.json
 *   cat evolution-data.json | node scripts/claworks-evolution-export-helper.mjs
 *
 * 有 API Key 时可直接用 scripts/generate-evolution-pack.mjs 全自动生成。
 */

import { readFileSync } from "node:fs";

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = { input: null, output: null, skeletonOnly: false };
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
      case "--skeleton-only":
        result.skeletonOnly = true;
        break;
      default:
        if (!args[i].startsWith("-") && !result.input) {
          result.input = args[i];
        }
    }
  }
  return result;
}

function readInput(inputPath) {
  if (inputPath) {
    return readFileSync(inputPath, "utf8");
  }
  return readFileSync(0, "utf8");
}

function groupBy(arr, keyFn) {
  const map = {};
  for (const item of arr) {
    const key = keyFn(item);
    (map[key] ??= []).push(item);
  }
  return map;
}

function summarizeExport(data) {
  const failures = data.failed_executions ?? [];
  const failuresByPlaybook = groupBy(failures, (f) => f.playbook_id);
  const frequentFailures = Object.entries(failuresByPlaybook)
    .filter(([, list]) => list.length >= 2)
    .sort(([, a], [, b]) => b.length - a.length);

  return {
    robotId: data.robot_id ?? "unknown",
    exportedAt: data.exported_at ?? "unknown",
    failureCount: failures.length,
    frequentFailures,
    lowIntents: data.low_confidence_intents ?? [],
    hitlModified: (data.hitl_decisions ?? []).filter(
      (d) => d.decision === "modified" || d.decision === "rejected",
    ),
    negativeFeedback: (data.feedback_records ?? []).filter((f) => f.feedback_score <= 2),
    playbookManifest: data.playbook_manifest ?? [],
    ruleTables: data.rule_table_names ?? [],
    promptTemplates: data.prompt_template_names ?? [],
  };
}

function buildPromptTemplate(summary, rawJson) {
  const frequentBlock =
    summary.frequentFailures.length > 0
      ? summary.frequentFailures
          .slice(0, 10)
          .map(
            ([id, list]) =>
              `- ${id}: ${list.length} failures (${[...new Set(list.map((f) => f.error_type))].join(", ")})`,
          )
          .join("\n")
      : "- (none with ≥2 failures)";

  const intentBlock =
    summary.lowIntents.length > 0
      ? summary.lowIntents
          .slice(0, 8)
          .map(
            (i) =>
              `- "${i.text_preview}" → ${i.classified_intent} (confidence ${Number(i.confidence ?? 0).toFixed(2)})`,
          )
          .join("\n")
      : "- (none)";

  return `# ClaWorks EvolutionPack generation task

You are a ClaWorks playbook and rules engineer. Read the sanitized export below and produce **one valid EvolutionPack JSON** (version "1.0") with:
- \`improved_playbooks\` for playbooks with repeated failures
- \`updated_rule_tables\` from low-confidence intents and HITL patterns
- \`improved_prompt_templates\` when intent classification needs few-shot help
- \`kb_additions\` for negative feedback and edge cases
- \`summary\` in Chinese for operators

Constraints:
- Do not invent user PII; use only hashed/preview fields from export
- Prefer on_failure / HITL / notify fallbacks for industrial playbooks
- Return **JSON only** (no markdown fences)

## Export metadata
- robot_id: ${summary.robotId}
- exported_at: ${summary.exportedAt}
- failed_executions: ${summary.failureCount}
- low_confidence_intents: ${summary.lowIntents.length}
- hitl modified/rejected: ${summary.hitlModified.length}
- negative feedback (≤2): ${summary.negativeFeedback.length}

## Frequent playbook failures
${frequentBlock}

## Low-confidence intent samples
${intentBlock}

## Playbook manifest (reference)
${JSON.stringify(summary.playbookManifest.slice(0, 20), null, 2)}

## Full export JSON (sanitized)
${rawJson}
`;
}

function buildEvolutionPackSkeleton(summary) {
  const generatedAt = new Date().toISOString();
  return {
    version: "1.0",
    generated_at: generatedAt,
    generated_by: "manual_review",
    source_robot_id: summary.robotId,
    improved_playbooks: [],
    updated_rule_tables: [],
    improved_prompt_templates: [],
    kb_additions: [],
    summary:
      summary.failureCount + summary.lowIntents.length > 0
        ? "待运维审核：请用上方 prompt 让商业模型填充 improved_playbooks / rule_tables / kb_additions"
        : "导出数据未发现明显改进点（机器人运行良好）",
  };
}

const cli = parseArgs(process.argv);
const raw = readInput(cli.input);
let exportData;
try {
  exportData = JSON.parse(raw);
} catch (err) {
  console.error(
    `错误：无法解析 evolution export JSON: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

if (exportData.version !== "1.0") {
  console.error(`错误：进化数据版本不兼容（需要 "1.0"，实际为 "${exportData.version}"）`);
  process.exit(1);
}

const summary = summarizeExport(exportData);
const skeleton = buildEvolutionPackSkeleton(summary);
const prompt = buildPromptTemplate(summary, JSON.stringify(exportData, null, 2));

const outputText = cli.skeletonOnly
  ? `${JSON.stringify(skeleton, null, 2)}\n`
  : `# === ClaWorks EvolutionPack skeleton ===\n${JSON.stringify(skeleton, null, 2)}\n\n# === Paste into Claude/GPT (commercial model) ===\n${prompt}\n`;

if (cli.output) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(cli.output, outputText, "utf8");
  console.error(`✅ 已写入 ${cli.output}（${outputText.length} 字节）`);
} else {
  process.stdout.write(outputText);
}
