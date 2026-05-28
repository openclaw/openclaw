#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callClaudeCli } from "../tools/openclaw_runtime/adapters/claude_code_cli_adapter.js";
import { callCodexCli } from "../tools/openclaw_runtime/adapters/codex_cli_adapter.js";
import { callLocalModel } from "../tools/openclaw_runtime/adapters/local_model_adapter.js";
import { openDb } from "./lib/sqlite-compat.mjs";

const moduleFilePath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(moduleFilePath);
const NUWA_DB_PATH = path.resolve(
  scriptDir,
  "../extensions/evolution-learning/.claude/evolution-state/nuwa.db",
);
const REPORT_PATH = path.resolve(scriptDir, "../reports/dmad-smoke-test-latest.json");

function excerpt(text, max = 180) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function bigramVector(text) {
  const map = new Map();
  const normalized = String(text ?? "").replace(/\s+/g, "");
  for (let i = 0; i < normalized.length - 1; i++) {
    const bi = normalized.slice(i, i + 2);
    map.set(bi, (map.get(bi) ?? 0) + 1);
  }
  return map;
}

function cosineSimilarity(a, b) {
  const keys = new Set([...a.keys(), ...b.keys()]);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const k of keys) {
    const av = a.get(k) ?? 0;
    const bv = b.get(k) ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) {
    return 0;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function summarizePattern(row) {
  const target = excerpt(row.target, 60);
  let models = [];
  try {
    models = JSON.parse(row.mental_models ?? "[]");
  } catch {
    models = [];
  }
  const modelHint = Array.isArray(models) ? models.slice(0, 2).join(" / ") : "";
  return `[${row.slug}] ${target}${modelHint ? ` (${modelHint})` : ""}`;
}

function queryTopPatterns(db) {
  const sqlCandidates = [
    `
      SELECT slug, target, context, mental_models
      FROM patterns
      WHERE frozen = 0
      ORDER BY decay_score DESC
      LIMIT 3
    `,
    `
      SELECT slug, target, context, mental_models
      FROM patterns
      ORDER BY id DESC
      LIMIT 3
    `,
    `
      SELECT slug, target, context, mental_models
      FROM patterns
      LIMIT 3
    `,
  ];

  for (const sql of sqlCandidates) {
    try {
      const rows = db.prepare(sql).all();
      if (Array.isArray(rows) && rows.length > 0) {
        return rows;
      }
    } catch {
      // try next SQL
    }
  }
  return [];
}

async function safeAdapterCall(callPromise, label) {
  try {
    const result = await callPromise;
    return result ?? { ok: false, result: "" };
  } catch (err) {
    return {
      ok: false,
      result: `[${label}失敗：${String(err).slice(0, 120)}]`,
    };
  }
}

async function main() {
  const startMs = Date.now();

  let db;
  let patternRows = [];

  try {
    db = await openDb(NUWA_DB_PATH, { readonly: true, fileMustExist: true });
    patternRows = queryTopPatterns(db);
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close failure
    }
  }

  const LANG_RULE =
    "\n\n【語言規則】所有回應必須使用**繁體中文**。禁止使用簡體中文、英文或其他語言回答。";

  const patternSummaries = patternRows.map(summarizePattern);
  const task = [
    "評估 OpenClaw 系統的穩定性，基於以下 patterns：",
    patternSummaries.length > 0 ? patternSummaries.join("\n") : "（無可用 patterns）",
    LANG_RULE,
  ].join("\n");

  const [claudeResult, codexResult, ollamaResult] = await Promise.all([
    safeAdapterCall(
      callClaudeCli({ task }, { model: "claude-haiku-4-5", timeoutMs: 45_000 }),
      "Claude CLI 呼叫",
    ),
    safeAdapterCall(
      callCodexCli(
        { task },
        { model: "gpt-5.3-codex", timeoutMs: 45_000, sandbox: "workspace-write" },
      ),
      "Codex CLI 呼叫",
    ),
    safeAdapterCall(
      callLocalModel({ task }, { model: "qwen3:14b", timeoutMs: 45_000 }),
      "Ollama 呼叫",
    ),
  ]);

  const claudeText = String(claudeResult?.result ?? "");
  const codexText = String(codexResult?.result ?? "");
  const ollamaText = String(ollamaResult?.result ?? "");

  const simCc = cosineSimilarity(bigramVector(claudeText), bigramVector(codexText));
  const simCo = cosineSimilarity(bigramVector(claudeText), bigramVector(ollamaText));
  const simOo = cosineSimilarity(bigramVector(codexText), bigramVector(ollamaText));
  const convergenceScore = Number(((simCc + simCo + simOo) / 3).toFixed(6));

  const report = {
    timestamp: new Date().toISOString(),
    claude: { ok: Boolean(claudeResult?.ok), excerpt: excerpt(claudeText) },
    codex: { ok: Boolean(codexResult?.ok), excerpt: excerpt(codexText) },
    ollama: { ok: Boolean(ollamaResult?.ok), excerpt: excerpt(ollamaText) },
    convergenceScore,
    patternsUsed: patternRows.map((p) => p.slug),
    durationMs: Date.now() - startMs,
  };

  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
