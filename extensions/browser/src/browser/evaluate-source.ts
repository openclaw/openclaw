// Normalizes browser evaluate input while preserving the public `fn` string API.
import { parse } from "acorn";

const FUNCTION_SOURCE_PATTERN = /^(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/;
const EXPRESSION_RESULT_NAME = "__openclawEvaluateExpressionResult";

function canParseAsExpression(source: string): boolean {
  try {
    // Parse only. Browser evaluate input is intentionally executable, but the
    // Gateway should not run caller-provided page JavaScript while routing.
    parse(`"use strict";\n(${source});`, { ecmaVersion: "latest" });
    return true;
  } catch {
    return false;
  }
}

export function normalizeBrowserEvaluateFunctionSource(
  source: string,
  params: { argumentName?: string } = {},
): string {
  const trimmed = source.trim();
  if (!trimmed) {
    return "";
  }
  const isExpression = canParseAsExpression(trimmed);
  if (FUNCTION_SOURCE_PATTERN.test(trimmed) && isExpression) {
    return trimmed;
  }
  const argumentName = params.argumentName;
  const args = argumentName ? `(${argumentName})` : "()";
  if (isExpression) {
    const invokeArgs = argumentName ? argumentName : "";
    return [
      `${args} => {`,
      `const ${EXPRESSION_RESULT_NAME} = (${trimmed});`,
      `return typeof ${EXPRESSION_RESULT_NAME} === "function" ? ${EXPRESSION_RESULT_NAME}(${invokeArgs}) : ${EXPRESSION_RESULT_NAME};`,
      "}",
    ].join("\n");
  }
  return `async ${args} => {\n${trimmed}\n}`;
}

/** Wait predicates must parse before any passive wait starts. */
export function normalizeBrowserWaitFunctionSource(source: string): string {
  const normalized = normalizeBrowserEvaluateFunctionSource(source);
  parse(`(${normalized});`, { ecmaVersion: "latest" });
  return normalized;
}
