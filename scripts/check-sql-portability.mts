import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript/ast";
import { productionFile, SQL_STATEMENT } from "./database-dialect-inventory.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { createNativeTypeScriptParser } from "./lib/native-typescript.mts";
import { loadRatchetSources } from "./lib/shrink-ratchet.mts";

type Violation = { line: number; construct: string };

// Preserve parentheses/commas outside quoted SQL and comments. Substitutions use
// a parameter token so separated literal pieces cannot manufacture identifiers.
function maskSql(text: string) {
  return text.replace(
    /(\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$)[\s\S]*?\1|'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|--[^\r\n]*|\/\*[\s\S]*?\*\//gu,
    (part) => part.replace(/[^\r\n]/gu, " "),
  );
}

function rawViolations(text: string): Violation[] {
  const masked = maskSql(text);
  const violations: Violation[] = [];
  for (const match of masked.matchAll(/\b(?:max|min)\s*\(/giu)) {
    let depth = 1;
    for (let index = match.index + match[0].length; index < masked.length; index++) {
      const character = masked[index];
      if (character === "(") {
        depth++;
      }
      if (character === ")" && --depth === 0) {
        break;
      }
      if (character === "," && depth === 1) {
        violations.push({
          line: masked.slice(0, match.index).split("\n").length,
          construct: `multi-argument ${match[0].slice(0, 3).toLowerCase()}`,
        });
        break;
      }
    }
  }
  for (const match of masked.matchAll(/\blimit\b/giu)) {
    const tail = masked.slice(match.index + match[0].length);
    const negative = /^\s*(?:\(\s*)*-\s*(?:[1-9]\d*|0*\.\d*[1-9]\d*)\b/u;
    let count = tail;
    // SQLite also accepts LIMIT offset, count. Skip commas inside expressions
    // and stop at the end of this clause rather than another query's select list.
    let depth = 0;
    for (const token of tail.matchAll(
      /[(),;]|\b(?:offset|union|intersect|except|returning)\b/giu,
    )) {
      if (token[0] === "(") {
        depth++;
      } else if (token[0] === ")" && depth > 0) {
        depth--;
      } else if (depth === 0) {
        if (token[0] === ",") {
          count = tail.slice(token.index + 1);
        }
        break;
      }
    }
    if (negative.test(tail) || negative.test(count)) {
      violations.push({
        line: masked.slice(0, match.index).split("\n").length,
        construct: "negative LIMIT",
      });
    }
  }
  return violations;
}

function callName(expression: ts.Expression): string | undefined {
  return ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : ts.isIdentifier(expression)
      ? expression.text
      : undefined;
}

function unwrap(expression: ts.Node): ts.Node {
  let node = expression;
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertion(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

function literalText(node: ts.Node): string | undefined {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined;
}

function negativeLiteral(node: ts.Node): boolean {
  return (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand) &&
    Number(node.operand.text) > 0
  );
}

function negativeLimit(expression: ts.Node): boolean {
  const node = unwrap(expression);
  if (negativeLiteral(node)) {
    return true;
  }
  if (ts.isTaggedTemplateExpression(node)) {
    return negativeLimit(node.template);
  }
  if (
    ts.isTemplateExpression(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isStringLiteral(node)
  ) {
    const text = ts.isTemplateExpression(node) ? templateText(node) : node.text;
    return Number(text.replace(/[()\s]/gu, "")) < 0;
  }
  if (ts.isConditionalExpression(node)) {
    return negativeLimit(node.whenTrue) || negativeLimit(node.whenFalse);
  }
  if (ts.isArrowFunction(node)) {
    return negativeLimit(node.body);
  }
  if (ts.isReturnStatement(node)) {
    return node.expression ? negativeLimit(node.expression) : false;
  }
  if (ts.isBlock(node)) {
    return node.statements.some(negativeLimit);
  }
  if (
    ts.isCallExpression(node) &&
    ["val", "lit", "raw"].includes(callName(node.expression) ?? "")
  ) {
    return node.arguments[0] ? negativeLimit(node.arguments[0]) : false;
  }
  return false;
}

function templateText(template: ts.TemplateLiteral): string {
  return ts.isTemplateExpression(template)
    ? template.head.text +
        template.templateSpans
          .map((span) => {
            const value = negativeLimit(span.expression) ? " -1 " : " ? ";
            return value + span.literal.text;
          })
          .join("")
    : template.text;
}

/** Syntax guard, not reachability analysis: mark only the exact SQLite-only expression. */
export function findSqlPortabilityViolations(source: ts.SourceFile): Violation[] {
  const violations: Violation[] = [];
  const add = (node: ts.Node, construct: string) => {
    const trivia = source.text.slice(node.getFullStart(), node.getStart(source));
    // No file allowlist or blanket dialect-owner exclusion. A marker documents an
    // engine guard or a physically SQLite-only owner; it cannot excuse a PG bug.
    if (/\/\* pg-sqlite-only: [^\r\n]+ \*\/\s*$/u.test(trivia)) {
      return;
    }
    violations.push({
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      construct,
    });
  };
  const raw = (node: ts.Node, text: string) => {
    for (const { construct } of rawViolations(text)) {
      add(node, construct);
    }
  };
  const visit = (node: ts.Node, boundValue = false) => {
    // Executable callbacks do not inherit their caller's data context.
    const inValue = boundValue && !ts.isFunctionLikeDeclaration(node);
    let boundChildren = inValue;
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      const first = node.arguments[0] && unwrap(node.arguments[0]);
      const second = node.arguments[1] && unwrap(node.arguments[1]);
      const text = first && literalText(first);
      if (
        (name === "fn" || name === "agg") &&
        text !== undefined &&
        /^(?:max|min)$/iu.test(text) &&
        second &&
        ts.isArrayLiteralExpression(second) &&
        second.elements.length >= 2
      ) {
        add(node, `multi-argument ${text.toLowerCase()}`);
      }
      if (name === "limit" && first) {
        if (negativeLimit(first)) {
          add(node, "negative LIMIT");
        }
      }
      if ((name === "raw" || name === "prepare" || name === "exec") && first) {
        const query = ts.isTemplateExpression(first) ? templateText(first) : text;
        if (query !== undefined) {
          raw(node, query);
          boundChildren = true;
        }
      }
      if (
        /^(?:val|lit|values|set|doUpdateSet|where|whereRef|having|havingRef|on|onRef)$/u.test(
          name ?? "",
        )
      ) {
        boundChildren = true;
      }
      if (/^(?:run|get|all)$/u.test(name ?? "") && ts.isPropertyAccessExpression(node.expression)) {
        const receiver = unwrap(node.expression.expression);
        if (ts.isCallExpression(receiver) && callName(receiver.expression) === "prepare") {
          boundChildren = true;
        }
      }
    }
    if (ts.isTaggedTemplateExpression(node) && /sql$/iu.test(callName(node.tag) ?? "")) {
      const template = node.template;
      raw(node, templateText(template));
      // Substitutions bind ordinary data; nested SQL/builders still own executable expressions.
      if (ts.isTemplateExpression(template)) {
        for (const span of template.templateSpans) {
          visit(span.expression, true);
        }
      }
      return;
    }
    if (
      !inValue &&
      (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) &&
      SQL_STATEMENT.test(
        maskSql(ts.isTemplateExpression(node) ? node.head.text : node.text).toUpperCase(),
      )
    ) {
      raw(node, templateText(node));
      if (ts.isTemplateExpression(node)) {
        for (const span of node.templateSpans) {
          visit(span.expression);
        }
      }
      return;
    }
    if (
      !inValue &&
      ts.isStringLiteral(node) &&
      SQL_STATEMENT.test(maskSql(node.text).toUpperCase()) &&
      !(
        ts.isCallExpression(node.parent) &&
        ["raw", "prepare", "exec"].includes(callName(node.parent.expression) ?? "")
      )
    ) {
      raw(node, node.text);
    }
    node.forEachChild((child) => visit(child, boundChildren));
  };
  visit(source);
  return violations;
}

export function main(root = process.cwd(), staged = false): number {
  const files = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      ...(staged ? [] : ["--others", "--exclude-standard"]),
      "-z",
      "--",
      "src",
      "extensions",
      "packages",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  )
    .split("\0")
    .filter((file) => productionFile(file) && (staged || fs.existsSync(path.join(root, file))));
  const paths = [...new Set(files)].toSorted();
  const texts = staged
    ? loadRatchetSources(root, paths)
    : new Map(paths.map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]));
  let count = 0;
  const report = (file: string, issues: Violation[]) => {
    for (const { line, construct } of issues) {
      console.error(`${file}:${line}: ${construct}; use the database-engine dialect owner.`);
      count++;
    }
  };
  const candidates = [...texts]
    .filter(([file, text]) => {
      if (file.endsWith(".sql")) {
        report(file, rawViolations(text));
        return false;
      }
      return true;
    })
    .map(([fileName, text]) => ({ fileName, text }))
    // Comments and cooked literal escapes are interpreted by the parser below.
    .filter(({ text }) => /sql|\b(?:fn|agg|max|min|limit|raw|prepare|exec)\b/iu.test(text));
  using parser = createNativeTypeScriptParser({ cwd: root });
  const sources = parser.parseSourceFiles(candidates);
  for (const source of sources) {
    report(path.relative(root, source.fileName), findSqlPortabilityViolations(source));
  }
  console.log(
    `SQL portability: ${count} violations in ${files.length} production files (${candidates.length} parsed).`,
  );
  return count === 0 ? 0 : 1;
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  process.exitCode = main(process.cwd(), process.argv.includes("--staged"));
}
