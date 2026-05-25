import { evaluateCondition } from "../../kernel/playbook-matcher.js";
import { interpolate } from "./step-executor.js";
import { resolveLenExpression } from "./template-resolve.js";

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
    if (interpolated === "" || interpolated === "false" || interpolated === "0") {
      return false;
    }
    // 若插值后是非空非 false 的普通值（如频道 ID "feishu"），说明字段存在 → true
    // 若原 condition 本身是纯值表达式（没有 {{ 模板），继续走条件解析
    // 注意：插值结果若含比较运算符（如 "5 > 3"），不能直接 return true，要继续解析
    if (condition.trim().startsWith("{{") && !/[><=!]/.test(interpolated)) {
      return true;
    }
  }
  const expr = interpolated.trim();
  const payload = (variables.payload ?? variables) as Record<string, unknown>;
  const steps = (variables.steps ?? {}) as StepsMap;

  // ── or（最低优先级，先于 and 检查避免短路错误） ────────────────────────
  // 按 " or " 分割；若任意一段为 true，整体为 true
  if (/ or /.test(expr)) {
    const parts = expr.split(/ or /);
    return parts.some((part) => evaluatePlaybookCondition(part.trim(), variables));
  }

  // ── and ───────────────────────────────────────────────────────────────
  if (/ and /.test(expr)) {
    const parts = expr.split(/ and /);
    return parts.every((part) => evaluatePlaybookCondition(part.trim(), variables));
  }

  // ── not <expr> ────────────────────────────────────────────────────────
  if (/^not\s+/.test(expr)) {
    return !evaluatePlaybookCondition(expr.slice(4).trim(), variables);
  }

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
    /float\(\s*steps\[['"](\w+)['"]\]\[['"]result['"]\]\.get\(\s*['"](\w+)['"]\s*,\s*([^)]+)\)\s*\)\s*(>|>=|<|<=|==|!=)\s*([\d.]+)/,
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
    if (op === "!=") {
      return left !== right;
    }
  }

  const stepsStatus = expr.match(
    /steps\.get\(\s*['"](\w+)['"]\s*,\s*\{\}\)\.get\(\s*['"]status['"]\s*\)\s*==\s*['"](\w+)['"]/,
  );
  if (stepsStatus) {
    return steps[stepsStatus[1]]?.status === stepsStatus[2];
  }

  const lenGt = expr.match(/^len\((.+)\)\s*>\s*(\d+)$/);
  if (lenGt) {
    const length = resolveLenExpression(`len(${lenGt[1]})`, variables);
    return length != null && length > Number(lenGt[2]);
  }

  // steps['x']['result'].get('key') == 'value'（值允许含空格、点号等）
  const stepsChoice = expr.match(
    /steps\[['"](\w+)['"]\]\[['"]result['"]\]\.get\(\s*['"](\w+)['"]\s*(?:,\s*[^)]+)?\s*\)\s*(==|!=)\s*['"]([^'"]*)['"]/,
  );
  if (stepsChoice) {
    const result = steps[stepsChoice[1]]?.result ?? {};
    const actual = String(result[stepsChoice[2]] ?? "");
    return stepsChoice[3] === "==" ? actual === stepsChoice[4] : actual !== stepsChoice[4];
  }

  // ── 简单数值/字符串比较（插值后剩余的裸比较式，如 "5 > 3"、"foo == bar"） ──
  const simpleCmp = expr.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (simpleCmp) {
    const lhs = simpleCmp[1].trim().replace(/^['"]|['"]$/g, "");
    const op = simpleCmp[2];
    const rhs = simpleCmp[3].trim().replace(/^['"]|['"]$/g, "");
    const lNum = Number(lhs);
    const rNum = Number(rhs);
    if (!Number.isNaN(lNum) && !Number.isNaN(rNum)) {
      if (op === ">") {
        return lNum > rNum;
      }
      if (op === ">=") {
        return lNum >= rNum;
      }
      if (op === "<") {
        return lNum < rNum;
      }
      if (op === "<=") {
        return lNum <= rNum;
      }
      if (op === "==") {
        return lNum === rNum;
      }
      if (op === "!=") {
        return lNum !== rNum;
      }
    }
    if (op === "==") {
      return lhs === rhs;
    }
    if (op === "!=") {
      return lhs !== rhs;
    }
  }

  if (expr.includes("payload.")) {
    return evaluateCondition(expr, payload);
  }

  return true;
}
