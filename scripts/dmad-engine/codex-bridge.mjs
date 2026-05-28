#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..", "..");
const PROMPTS_DIR = path.join(ROOT, "scripts", "dmad-engine", "prompts");

const SAFETY_PREAMBLE = `
## 安全規則（必須遵守）
- 不得發送任何真實下單指令
- 不得修改 gate 腳本門檻
- 不得讀取或輸出 secrets / API keys / credentials
- 不得刪除 .git、專案根目錄、使用者資料
- destructive 操作必須先備份，且預設不可自動執行
- 每步都要有驗證指令
`.trim();

function toSafeText(value) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function parseJsonBlock(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    return null;
  }
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i);
  const direct = fenced?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0] ?? null;
  if (!direct) {
    return null;
  }
  try {
    return JSON.parse(direct);
  } catch {
    return null;
  }
}

function parseCodexJsonl(raw) {
  const lines = String(raw ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let output = "";
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const event = JSON.parse(lines[i]);
      if (event?.type === "item.completed") {
        output = toSafeText(event?.item?.text ?? event?.item?.output);
        if (output.length > 0) {
          break;
        }
      }
      if (event?.type === "turn.completed") {
        output = toSafeText(event?.payload?.content);
        if (output.length > 0) {
          break;
        }
      }
      if (event?.type === "message" && (event?.role === "assistant" || !event?.role)) {
        output = toSafeText(event?.content);
        if (output.length > 0) {
          break;
        }
      }
    } catch {}
  }
  if (output.length === 0) {
    output = String(raw ?? "").slice(0, 4000);
  }
  return {
    output: output.slice(0, 4000),
    parsed: parseJsonBlock(output),
  };
}

async function loadPrompt(fileName) {
  try {
    const filePath = path.join(PROMPTS_DIR, fileName);
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function callCodex(brief, options = {}) {
  const model = options.model ?? "gpt-4.1";
  const sandbox = options.sandbox ?? "workspace-write";
  const timeoutMs = Number(options.timeoutMs ?? 360_000);
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let processRef;
    try {
      processRef = spawn("codex", ["exec", "--json", "-m", model, "-s", sandbox, "-"], {
        cwd: ROOT,
        shell: process.platform === "win32",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        ok: false,
        output: `Codex 啟動失敗: ${String(error)}`,
        durationMs: 0,
        parsed: null,
      });
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    processRef.stdout?.on("data", (chunk) => stdoutChunks.push(String(chunk)));
    processRef.stderr?.on("data", (chunk) => stderrChunks.push(String(chunk)));
    processRef.stdin?.write(String(brief ?? ""));
    processRef.stdin?.end();

    const timer = setTimeout(() => {
      processRef.kill("SIGTERM");
    }, timeoutMs);

    processRef.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      const stdout = stdoutChunks.join("");
      const stderr = stderrChunks.join("");
      const parsed = parseCodexJsonl(stdout);
      const output = parsed.output.length > 0 ? parsed.output : stderr.slice(0, 2000);
      resolve({
        ok: code === 0,
        output,
        durationMs,
        parsed: parsed.parsed,
        stderr: stderr.slice(0, 2000),
      });
    });

    processRef.on("error", (error) => {
      clearTimeout(timer);
      const message =
        error?.code === "ENOENT"
          ? "Codex CLI 不可用（請確認 codex 已安裝）"
          : `Codex 呼叫失敗: ${String(error)}`;
      resolve({
        ok: false,
        output: message,
        durationMs: Date.now() - startedAt,
        parsed: null,
      });
    });
  });
}

function normalizeSolution(rawSolution) {
  if (!rawSolution || typeof rawSolution !== "object") {
    return null;
  }
  const rawSteps = Array.isArray(rawSolution.steps) ? rawSolution.steps : [];
  const steps = rawSteps
    .map((step) => {
      if (typeof step === "string") {
        return { command: step, validation: null, rollback: null, requiresApproval: false };
      }
      const command = typeof step?.command === "string" ? step.command : "";
      if (command.length === 0) {
        return null;
      }
      return {
        command,
        validation: typeof step?.validation === "string" ? step.validation : null,
        rollback: typeof step?.rollback === "string" ? step.rollback : null,
        requiresApproval: step?.requiresApproval === true,
      };
    })
    .filter(Boolean);
  if (steps.length === 0) {
    return null;
  }
  const confidence = Number.parseFloat(String(rawSolution.confidence ?? "0.5"));
  return {
    strategy:
      typeof rawSolution.strategy === "string" && rawSolution.strategy.length > 0
        ? rawSolution.strategy
        : "codex_generated",
    confidence: Number.isFinite(confidence) ? confidence : 0.5,
    destructive: rawSolution.destructive === true,
    reasoning: typeof rawSolution.reasoning === "string" ? rawSolution.reasoning : "",
    steps,
  };
}

function buildFallbackBrief(diagnosis) {
  return `${SAFETY_PREAMBLE}

## 任務
分析下列 DMAD 診斷，回傳最小安全修復 JSON。

## 診斷
${JSON.stringify(diagnosis, null, 2)}

## 回傳格式
{
  "strategy": "策略名稱",
  "confidence": 0.0-1.0,
  "destructive": false,
  "reasoning": "根因與解法",
  "steps": [
    { "command": "pnpm ...", "validation": "pnpm ...", "rollback": "..." }
  ]
}
`;
}

export async function callCodexDiagnose(diagnosis, options = {}) {
  const template = await loadPrompt("codex-solve.txt");
  const brief = template
    ? template
        .replaceAll("{{SAFETY}}", SAFETY_PREAMBLE)
        .replaceAll("{{DIAGNOSIS}}", JSON.stringify(diagnosis, null, 2))
    : buildFallbackBrief(diagnosis);
  const result = await callCodex(brief, options);
  if (!result.ok) {
    return {
      decision: "escalate",
      source: "codex_unavailable",
      reason: result.output,
      codexDurationMs: result.durationMs,
      diagnosis,
    };
  }
  const solution = normalizeSolution(result.parsed);
  if (!solution) {
    return {
      decision: "escalate",
      source: "codex_unstructured",
      codexOutput: result.output,
      codexDurationMs: result.durationMs,
      diagnosis,
    };
  }
  const requiresApproval = solution.destructive || solution.confidence < 0.7;
  return {
    decision: requiresApproval ? "escalate" : "auto_execute",
    source: "codex_reasoning",
    confidence: solution.confidence,
    destructive: solution.destructive,
    requiresApproval,
    solution,
    codexDurationMs: result.durationMs,
  };
}

export async function callCodexExecute(taskBrief, options = {}) {
  return callCodex(`${SAFETY_PREAMBLE}\n\n${String(taskBrief ?? "")}`, options);
}
