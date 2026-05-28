#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callCodexDiagnose } from "./codex-bridge.mjs";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..", "..");
const PATTERN_FILE = path.join(
  ROOT,
  ".openclaw",
  "dmad",
  "patterns",
  "dmad-pattern-registry.jsonl",
);
const PROMPTS_DIR = path.join(ROOT, "scripts", "dmad-engine", "prompts");
const OLLAMA_URL = "http://127.0.0.1:11434/v1/chat/completions";
const OLLAMA_MODEL = "qwen3:14b";
const OLLAMA_MODELS_URL = "http://127.0.0.1:11434/v1/models";
const OLLAMA_TIMEOUT_MS = 12_000;

const codexRequiredBlockers = new Set([
  "tail_risk_positive",
  "multi_file_refactor",
  "code_generation",
]);
let ollamaAvailabilityCache = {
  checkedAt: 0,
  available: true,
};

async function loadPatterns() {
  try {
    const raw = await fs.readFile(PATTERN_FILE, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function loadPrompt(fileName, fallback = "") {
  try {
    return await fs.readFile(path.join(PROMPTS_DIR, fileName), "utf8");
  } catch {
    return fallback;
  }
}

function parseJsonFromText(text) {
  if (typeof text !== "string") {
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

function normalizeOllamaSolution(rawSolution) {
  if (!rawSolution || typeof rawSolution !== "object") {
    return null;
  }
  const rawSteps = Array.isArray(rawSolution.steps) ? rawSolution.steps : [];
  const steps = rawSteps
    .map((entry) => {
      if (typeof entry === "string") {
        return { command: entry, validation: null, rollback: null, requiresApproval: false };
      }
      const command = typeof entry?.command === "string" ? entry.command : "";
      if (command.length === 0) {
        return null;
      }
      return {
        command,
        validation: typeof entry?.validation === "string" ? entry.validation : null,
        rollback: typeof entry?.rollback === "string" ? entry.rollback : null,
        requiresApproval: entry?.requiresApproval === true,
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
        : "ollama_generated",
    confidence: Number.isFinite(confidence) ? confidence : 0.5,
    destructive:
      rawSolution.destructive === true ||
      steps.some((step) => /delete|remove|drop|truncate/i.test(step.command)),
    needsCodex: rawSolution.needs_codex === true || rawSolution.escalate_to === "codex",
    steps,
    reasoning: typeof rawSolution.reasoning === "string" ? rawSolution.reasoning : "",
  };
}

function buildOllamaPrompt(diagnosis, similarPatterns) {
  const snippets = similarPatterns.slice(0, 3).map((pattern) => ({
    blocker: pattern.blocker,
    strategy: pattern?.bestSolution?.strategy ?? "",
    confidenceFromHistory: pattern?.bestSolution?.confidenceFromHistory ?? 0,
    steps: pattern?.bestSolution?.steps ?? [],
  }));
  return [
    "## 問題診斷",
    JSON.stringify(diagnosis, null, 2),
    "",
    "## 類似 patterns",
    JSON.stringify(snippets, null, 2),
    "",
    "請回傳嚴格 JSON（strategy/confidence/destructive/needs_codex/steps）。",
  ].join("\n");
}

async function callOllama(systemPrompt, userPrompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, OLLAMA_TIMEOUT_MS);
  const requestBody = {
    model: OLLAMA_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.2,
    max_tokens: 3072,
    extra_body: { enable_thinking: true },
  };
  let response;
  try {
    response = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer ollama-local",
      },
      signal: controller.signal,
      body: JSON.stringify(requestBody),
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`ollama_http_${response.status}`);
  }
  const payload = await response.json();
  const content = String(payload?.choices?.[0]?.message?.content ?? "");
  const parsed = parseJsonFromText(content);
  return parsed ?? { raw: content };
}

async function checkOllamaAvailability() {
  const now = Date.now();
  if (now - ollamaAvailabilityCache.checkedAt < 30_000) {
    return ollamaAvailabilityCache.available;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 3000);
  try {
    const response = await fetch(OLLAMA_MODELS_URL, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timer);
    ollamaAvailabilityCache = {
      checkedAt: Date.now(),
      available: response.ok,
    };
    return response.ok;
  } catch {
    clearTimeout(timer);
    ollamaAvailabilityCache = {
      checkedAt: Date.now(),
      available: false,
    };
    return false;
  }
}

function shouldPreferCodex(diagnosis) {
  const blocker = String(diagnosis?.blocker ?? "");
  if (codexRequiredBlockers.has(blocker)) {
    return true;
  }
  const evidenceLength = JSON.stringify(diagnosis?.evidence ?? {}).length;
  return evidenceLength > 2500;
}

function findPatternMatch(diagnosis, patterns) {
  const blocker = String(diagnosis?.blocker ?? "");
  const gateId = String(diagnosis?.gateId ?? diagnosis?.category ?? "");
  return (
    patterns.find(
      (pattern) =>
        String(pattern?.blocker ?? "") === blocker &&
        String(pattern?.category ?? "") === gateId &&
        Number(pattern?.bestSolution?.confidenceFromHistory ?? 0) >= 0.7,
    ) ?? null
  );
}

export async function think(diagnosis, options = {}) {
  const patterns = await loadPatterns();
  const pattern = findPatternMatch(diagnosis, patterns);
  if (pattern) {
    return {
      decision: "auto_execute",
      source: "pattern_exact_match",
      patternId: pattern.patternId,
      confidence: Number(pattern?.bestSolution?.confidenceFromHistory ?? 0),
      solution: {
        strategy: pattern?.bestSolution?.strategy ?? "pattern_match",
        steps: Array.isArray(pattern?.bestSolution?.steps) ? pattern.bestSolution.steps : [],
      },
      requiresApproval: false,
    };
  }

  const codexFallback = async (reason) => {
    if (options.skipCodex === true) {
      return {
        decision: "escalate",
        source: "codex_deferred_dry_run",
        reason,
        diagnosis,
      };
    }
    return callCodexDiagnose(diagnosis);
  };

  if (options.codexOnly === true || shouldPreferCodex(diagnosis)) {
    return codexFallback("prefer_codex");
  }

  if (!(await checkOllamaAvailability())) {
    return codexFallback("ollama_unavailable_precheck");
  }

  const systemPrompt = await loadPrompt(
    "solve.txt",
    "你是 DMAD 安全修復代理，僅回傳 JSON，優先最小可驗證解法。",
  );
  const similarPatterns = patterns.filter(
    (pattern) => String(pattern?.category ?? "") === String(diagnosis?.gateId ?? ""),
  );
  try {
    const ollamaRaw = await callOllama(systemPrompt, buildOllamaPrompt(diagnosis, similarPatterns));
    const solution = normalizeOllamaSolution(ollamaRaw?.solution ?? ollamaRaw);
    if (!solution) {
      return codexFallback("ollama_unstructured");
    }
    if (solution.needsCodex || (solution.confidence < 0.5 && solution.destructive !== true)) {
      return codexFallback("ollama_low_confidence_or_needs_codex");
    }
    if (solution.destructive) {
      return {
        decision: "escalate",
        source: "destructive_needs_approval",
        confidence: solution.confidence,
        destructive: true,
        suggestedSolution: solution,
        diagnosis,
      };
    }
    return {
      decision: "auto_execute",
      source: "ollama_reasoning",
      confidence: solution.confidence,
      destructive: false,
      solution: {
        strategy: solution.strategy,
        steps: solution.steps,
        reasoning: solution.reasoning,
      },
      requiresApproval: solution.confidence < 0.7,
    };
  } catch (error) {
    const fallback = await codexFallback("ollama_unavailable");
    return { ...fallback, ollamaError: String(error?.message ?? error) };
  }
}
