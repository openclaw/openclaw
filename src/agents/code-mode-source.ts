/** Validate guest JavaScript before execution. */
import { tokenizer } from "acorn";
import { parseCodeModeScriptSyntax } from "./code-mode-script-syntax.js";
import {
  CODE_MODE_SHELL_SOURCE_ERROR,
  isShellLikeCodeModeSource,
} from "./code-mode-shell-source.js";
import { ToolInputError } from "./tool-input-error.js";

function maskCodeLiteralsAndComments(code: string): string {
  // Parser and tokenizer offsets are UTF-16 code units, not Unicode points.
  const masked = code.split("");
  const maskRange = (start: number, end: number) => {
    for (let index = start; index < Math.min(end, masked.length); index += 1) {
      if (masked[index] !== "\n" && masked[index] !== "\r") {
        masked[index] = " ";
      }
    }
  };
  // Malformed JavaScript needs a conservative lexical pass: never trust a
  // context-free regexp token to hide executable module access.
  try {
    for (const token of tokenizer(code, {
      ecmaVersion: "latest",
      onComment: (_isBlock, _text, start, end) => maskRange(start, end),
    })) {
      if (token.type.label === "string" || token.type.label === "template") {
        maskRange(token.start, token.end);
      }
    }
    return masked.join("");
  } catch {
    // Never inspect partially masked input after a tokenizer failure.
    return code;
  }
}

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
    node.type === "ImportDeclaration" ||
    node.type === "ImportExpression" ||
    (node.type === "MetaProperty" && node.meta.name === "import") ||
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

function rejectsModuleAccess(
  code: string,
  parsed: ReturnType<typeof parseCodeModeScriptSyntax>,
): boolean {
  // Unicode escapes can spell a loader identifier without its literal name.
  if (!code.includes("import") && !code.includes("require") && !code.includes("\\u")) {
    return false;
  }
  if (parsed.ok) {
    // The WASI guest has no host module loader. Only executable module syntax
    // belongs in this early check; ordinary guest methods are not capabilities.
    return containsModuleAccess(parsed.program);
  }
  const source = maskCodeLiteralsAndComments(code);
  return /\bimport\b\s*(?:\.|\(|["'`{*]|\w)|\brequire\b\s*\(/u.test(source);
}

export function prepareSource(code: string): string {
  const parsed = parseCodeModeScriptSyntax(code);
  if (rejectsModuleAccess(code, parsed)) {
    throw new ToolInputError("code mode module access is disabled.");
  }
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
  return code;
}
