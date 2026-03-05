/**
 * Declarative rule engine for custom trading strategies.
 * Parses simple expressions (AND, OR, <, >, <=, >=, ==) and generates
 * a StrategyDefinition with an onBar function.
 *
 * Supported indicators: rsi, sma, ema, macd.histogram, bb.upper, bb.lower, atr
 * Supported price fields: close, open, high, low, volume
 * Supports user-defined parameter references.
 */

import type { OHLCV } from "../../shared/types.js";
import type { StrategyDefinition, StrategyContext, Signal } from "../types.js";

type Operator = "<" | ">" | "<=" | ">=" | "==";
type LogicalOp = "AND" | "OR";

interface Comparison {
  left: string;
  op: Operator;
  right: string;
}

interface RuleNode {
  type: "comparison" | "logical";
  comparison?: Comparison;
  logicalOp?: LogicalOp;
  children?: RuleNode[];
}

const OPERATORS: Operator[] = ["<=", ">=", "==", "<", ">"];

function tokenize(expr: string): string[] {
  // Normalize whitespace and split while preserving operators
  const normalized = expr
    .replace(/\bAND\b/gi, " AND ")
    .replace(/\bOR\b/gi, " OR ")
    .replace(/<=/g, " <= ")
    .replace(/>=/g, " >= ")
    .replace(/==/g, " == ")
    .replace(/(?<!=)(?<!<)(?<!>)<(?!=)/g, " < ")
    .replace(/(?<!=)(?<!<)(?<!>)>(?!=)/g, " > ");

  return normalized.split(/\s+/).filter((t) => t.length > 0);
}

function parseRule(expr: string): RuleNode {
  const tokens = tokenize(expr);
  if (tokens.length === 0) {
    throw new Error("Empty rule expression");
  }

  // Split by OR first (lower precedence), then AND
  const orParts = splitByLogical(tokens, "OR");
  if (orParts.length > 1) {
    return {
      type: "logical",
      logicalOp: "OR",
      children: orParts.map((part) => parseRule(part.join(" "))),
    };
  }

  const andParts = splitByLogical(tokens, "AND");
  if (andParts.length > 1) {
    return {
      type: "logical",
      logicalOp: "AND",
      children: andParts.map((part) => parseRule(part.join(" "))),
    };
  }

  // Single comparison: left op right
  if (tokens.length < 3) {
    throw new Error(`Invalid comparison: "${tokens.join(" ")}". Expected: <left> <op> <right>`);
  }

  const op = tokens.find((t) => OPERATORS.includes(t as Operator)) as Operator | undefined;
  if (!op) {
    throw new Error(`No operator found in: "${tokens.join(" ")}". Use <, >, <=, >=, or ==`);
  }

  const opIdx = tokens.indexOf(op);
  const left = tokens.slice(0, opIdx).join(".");
  const right = tokens.slice(opIdx + 1).join(".");

  return { type: "comparison", comparison: { left, op, right } };
}

function splitByLogical(tokens: string[], keyword: string): string[][] {
  const parts: string[][] = [];
  let current: string[] = [];
  for (const t of tokens) {
    if (t.toUpperCase() === keyword) {
      if (current.length > 0) parts.push(current);
      current = [];
    } else {
      current.push(t);
    }
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

function resolveValue(
  name: string,
  bar: OHLCV,
  ctx: StrategyContext,
  params: Record<string, number>,
): number {
  // Try as a number literal first
  const num = Number(name);
  if (!Number.isNaN(num)) return num;

  // Price fields
  switch (name) {
    case "close":
      return bar.close;
    case "open":
      return bar.open;
    case "high":
      return bar.high;
    case "low":
      return bar.low;
    case "volume":
      return bar.volume;
  }

  // User parameters
  if (name in params) return params[name]!;

  // Indicators (take latest value)
  const latest = (arr: number[]) => (arr.length > 0 ? arr[arr.length - 1]! : 0);

  if (name === "rsi") return latest(ctx.indicators.rsi(params.rsiPeriod ?? 14));
  if (name === "sma") return latest(ctx.indicators.sma(params.smaPeriod ?? 20));
  if (name === "ema") return latest(ctx.indicators.ema(params.emaPeriod ?? 20));
  if (name === "atr") return latest(ctx.indicators.atr(params.atrPeriod ?? 14));

  // MACD sub-fields
  if (name === "macd.histogram" || name === "macd.hist") {
    const m = ctx.indicators.macd(
      params.macdFast ?? 12,
      params.macdSlow ?? 26,
      params.macdSignal ?? 9,
    );
    return latest(m.histogram);
  }
  if (name === "macd.signal") {
    const m = ctx.indicators.macd(
      params.macdFast ?? 12,
      params.macdSlow ?? 26,
      params.macdSignal ?? 9,
    );
    return latest(m.signal);
  }
  if (name === "macd.macd" || name === "macd.line") {
    const m = ctx.indicators.macd(
      params.macdFast ?? 12,
      params.macdSlow ?? 26,
      params.macdSignal ?? 9,
    );
    return latest(m.macd);
  }

  // Bollinger Bands
  if (name === "bb.upper") {
    const bb = ctx.indicators.bollingerBands(params.bbPeriod ?? 20, params.bbStdDev ?? 2);
    return latest(bb.upper);
  }
  if (name === "bb.lower") {
    const bb = ctx.indicators.bollingerBands(params.bbPeriod ?? 20, params.bbStdDev ?? 2);
    return latest(bb.lower);
  }
  if (name === "bb.middle") {
    const bb = ctx.indicators.bollingerBands(params.bbPeriod ?? 20, params.bbStdDev ?? 2);
    return latest(bb.middle);
  }

  throw new Error(`Unknown variable: "${name}"`);
}

function evaluateNode(
  node: RuleNode,
  bar: OHLCV,
  ctx: StrategyContext,
  params: Record<string, number>,
): boolean {
  if (node.type === "comparison" && node.comparison) {
    const left = resolveValue(node.comparison.left, bar, ctx, params);
    const right = resolveValue(node.comparison.right, bar, ctx, params);

    switch (node.comparison.op) {
      case "<":
        return left < right;
      case ">":
        return left > right;
      case "<=":
        return left <= right;
      case ">=":
        return left >= right;
      case "==":
        return Math.abs(left - right) < 1e-10;
    }
  }

  if (node.type === "logical" && node.children) {
    if (node.logicalOp === "AND") {
      return node.children.every((c) => evaluateNode(c, bar, ctx, params));
    }
    if (node.logicalOp === "OR") {
      return node.children.some((c) => evaluateNode(c, bar, ctx, params));
    }
  }

  return false;
}

export interface CustomRules {
  buy: string;
  sell: string;
}

export function buildCustomStrategy(
  name: string,
  rules: CustomRules,
  params: Record<string, number>,
  symbols?: string[],
  timeframes?: string[],
): StrategyDefinition {
  // Parse rules upfront to catch errors early
  const buyRule = parseRule(rules.buy);
  const sellRule = parseRule(rules.sell);

  const def: StrategyDefinition & { _rules?: CustomRules } = {
    id: `custom-${Date.now()}`,
    name,
    version: "1.0.0",
    markets: ["crypto"],
    symbols: symbols ?? ["BTC/USDT"],
    timeframes: timeframes ?? ["1d"],
    parameters: { ...params },
    _rules: rules, // persisted for hydration after JSON deserialization
    async onBar(bar: OHLCV, ctx: StrategyContext): Promise<Signal | null> {
      const hasPosition = ctx.portfolio.positions.some(
        (p) => p.symbol === (symbols?.[0] ?? "BTC/USDT"),
      );

      if (!hasPosition && evaluateNode(buyRule, bar, ctx, params)) {
        return {
          action: "buy",
          symbol: symbols?.[0] ?? "BTC/USDT",
          sizePct: 10,
          orderType: "market",
          reason: `Custom rule: ${rules.buy}`,
          confidence: 0.7,
        };
      }

      if (hasPosition && evaluateNode(sellRule, bar, ctx, params)) {
        return {
          action: "sell",
          symbol: symbols?.[0] ?? "BTC/USDT",
          sizePct: 100,
          orderType: "market",
          reason: `Custom rule: ${rules.sell}`,
          confidence: 0.7,
        };
      }

      return null;
    },
  };
  return def;
}

// Re-export for testing
export { parseRule, evaluateNode, resolveValue };
