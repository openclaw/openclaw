/** Validate guest JavaScript before execution. */
import { parseCodeModeScriptSyntax } from "./code-mode-script-syntax.js";
import {
  CODE_MODE_SHELL_SOURCE_ERROR,
  isShellLikeCodeModeSource,
} from "./code-mode-shell-source.js";
import { ToolInputError } from "./tool-input-error.js";

function isModuleLoaderCallee(callee: import("acorn").Expression | import("acorn").Super): boolean {
  if (callee.type === "ParenthesizedExpression") {
    return isModuleLoaderCallee(callee.expression);
  }
  if (callee.type === "ChainExpression") {
    return isModuleLoaderCallee(callee.expression);
  }
  if (callee.type === "SequenceExpression") {
    const expression = callee.expressions[callee.expressions.length - 1];
    return expression !== undefined && isModuleLoaderCallee(expression);
  }
  return callee.type === "Identifier" && callee.name === "require";
}

function containsModuleAccess(node: import("acorn").AnyNode): boolean {
  if (
    node.type === "ImportExpression" ||
    (node.type === "CallExpression" && isModuleLoaderCallee(node.callee))
  ) {
    return true;
  }

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (
          child !== null &&
          typeof child === "object" &&
          "type" in child &&
          typeof child.type === "string" &&
          // SAFETY: Children are taken directly from Acorn's parsed AST.
          containsModuleAccess(child as import("acorn").AnyNode)
        ) {
          return true;
        }
      }
      continue;
    }
    if (
      value !== null &&
      typeof value === "object" &&
      "type" in value &&
      typeof value.type === "string" &&
      // SAFETY: Child fields are taken directly from Acorn's parsed AST.
      containsModuleAccess(value as import("acorn").AnyNode)
    ) {
      return true;
    }
  }
  return false;
}

// Existing test assertions match the leading sentence; keep it verbatim.
export const CODE_MODE_MODULE_ACCESS_ERROR =
  "code mode module access is disabled. " +
  "Call an enabled async tool global from guest JavaScript; use " +
  "catalog.search(query) when the bounded quick index omits it. " +
  "Do not retry the same source with require() or an import.";

export function prepareSource(code: string): string {
  const parsed = parseCodeModeScriptSyntax(code);
  if (isShellLikeCodeModeSource(code)) {
    throw new ToolInputError(CODE_MODE_SHELL_SOURCE_ERROR);
  }
  if (!parsed.ok) {
    // Keep parser text bounded: some diagnostics include a user-sized identifier.
    const message = parsed.message.slice(0, 240);
    throw new ToolInputError(
      `SyntaxError at openclaw-code-mode:user.js:${parsed.line}:${parsed.column + 1}: ${message}. No tools were dispatched; correct the JavaScript source and submit it again.`,
    );
  }
  // Unicode escapes can spell a loader identifier without its literal name.
  if (
    (code.includes("import") || code.includes("require") || code.includes("\\u")) &&
    containsModuleAccess(parsed.program)
  ) {
    throw new ToolInputError(CODE_MODE_MODULE_ACCESS_ERROR);
  }
  return code;
}
