import { evaluateCondition } from "../../kernel/playbook-matcher.js";
import { interpolate } from "./step-executor.js";

type StepsMap = Record<string, { status?: string; result?: Record<string, unknown> }>;

/** Evaluate pack YAML step/trigger conditions (Python-style subset). */
export function evaluatePlaybookCondition(
  condition: string | undefined,
  variables: Record<string, unknown>,
): boolean {
  if (!condition?.trim()) {
    return true;
  }
  // 先做模板插值：condition: "{{channel_id}}" → "feishu"（truthy）或 ""（falsy）
  const interpolated = interpolate(condition.trim(), variables);
  // 如果插值后不含 {{ 说明是纯值结果——按 truthy/falsy 直接判断
  if (!interpolated.includes("{{")) {
    if (interpolated === "" || interpolated === "false" || interpolated === "0") return false;
    // 若插值后是非空非 false 的普通值（如频道 ID "feishu"），说明字段存在 → true
    // 若原 condition 本身是纯值表达式（没有 {{ 模板），继续走条件解析
    if (condition.trim().startsWith("{{")) return true;
  }
  const expr = interpolated.trim();
  const payload = (variables.payload ?? variables) as Record<string, unknown>;
  const steps = (variables.steps ?? {}) as StepsMap;

  const inList = expr.match(
    /payload\.get\(\s*['"](\w+)['"]\s*(?:,\s*[^)]+)?\s*\)\s+in\s+\(([^)]+)\)/,
  );
  if (inList) {
    const value = String(payload[inList[1]] ?? "");
    const options = inList[2]
      .split(",")
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
    return options.includes(value);
  }

  const floatCmp = expr.match(
    /float\(\s*steps\[['"](\w+)['"]\]\[['"]result['"]\]\.get\(\s*['"](\w+)['"]\s*,\s*([^)]+)\)\s*\)\s*(>|>=|<|<=|==)\s*([\d.]+)/,
  );
  if (floatCmp) {
    const step = steps[floatCmp[1]]?.result ?? {};
    const raw = step[floatCmp[2]];
    const fallback = Number.parseFloat(floatCmp[3]);
    const left = Number.parseFloat(String(raw ?? fallback));
    const op = floatCmp[4];
    const right = Number.parseFloat(floatCmp[5]);
    if (op === ">") {
      return left > right;
    }
    if (op === ">=") {
      return left >= right;
    }
    if (op === "<") {
      return left < right;
    }
    if (op === "<=") {
      return left <= right;
    }
    if (op === "==") {
      return left === right;
    }
  }

  const stepsStatus = expr.match(
    /steps\.get\(\s*['"](\w+)['"]\s*,\s*\{\}\)\.get\(\s*['"]status['"]\s*\)\s*==\s*['"](\w+)['"]/,
  );
  if (stepsStatus) {
    return steps[stepsStatus[1]]?.status === stepsStatus[2];
  }

  if (expr.includes(" and ")) {
    const parts = expr.split(/\s+and\s+/);
    return parts.every((part) => evaluatePlaybookCondition(part.trim(), variables));
  }

  if (expr.includes("payload.")) {
    return evaluateCondition(expr, payload);
  }

  return true;
}
