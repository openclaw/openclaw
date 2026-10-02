import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import * as ts from "typescript/unstable/ast";
import { getChangedPathFacts, isTestSupportFileTarget } from "./changed-path-facts.mjs";
import { createNativeTypeScriptParser, type NativeTypeScriptSource } from "./native-typescript.mts";

export type IconFixture = { file: string; line: number; html: string };
const dynamic = "openclaw_unresolved_expression";

function iconExpression(expression: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expression)) {
    return iconExpression(expression.expression);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.expression.getText() === "icons";
  }
  return (
    ts.isConditionalExpression(expression) &&
    iconExpression(expression.whenTrue) &&
    iconExpression(expression.whenFalse)
  );
}

/** Only literal HTML ancestry and a single known SVG are witnesses, not invented class combinations. */
export function collectIconFixtures(
  parsed: ts.SourceFile,
  file: string,
  document: Document,
): IconFixture[] {
  const fixtures: IconFixture[] = [];
  // Plain stylesheets cannot establish the cascade inside a shadow/custom render root.
  let customRoot = false;
  const inspectRoot = (node: ts.Node) => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const baseType = node.heritageClauses?.find(
        (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
      )?.types[0];
      const base =
        baseType && ts.isExpressionWithTypeArguments(baseType)
          ? baseType.expression.getText(parsed)
          : undefined;
      if (base && !["OpenClawLightDomElement", "OpenClawLightDomContentsElement"].includes(base)) {
        customRoot = true;
      }
      if (
        node.members.some(
          (member) =>
            (ts.isMethodDeclaration(member) ||
              ts.isPropertyDeclaration(member) ||
              ts.isAccessorDeclaration(member)) &&
            member.name.getText(parsed) === "createRenderRoot",
        )
      ) {
        customRoot = true;
      }
    }
    node.forEachChild(inspectRoot);
  };
  inspectRoot(parsed);
  if (customRoot) {
    return fixtures;
  }
  const visit = (node: ts.Node) => {
    if (ts.isTaggedTemplateExpression(node) && node.tag.getText(parsed) === "html") {
      const template = node.template;
      let html = ts.isNoSubstitutionTemplateLiteral(template) ? template.text : template.head.text;
      if (ts.isTemplateExpression(template)) {
        for (const span of template.templateSpans) {
          html +=
            (iconExpression(span.expression)
              ? '<svg data-icon-grid-probe="" viewBox="0 0 24 24"></svg>'
              : dynamic) + span.literal.text;
        }
      }
      const holder = document.createElement("template");
      holder.innerHTML = html;
      if (holder.content.querySelector("style, link[rel=stylesheet]")) {
        return;
      }
      for (const control of holder.content.querySelectorAll("button, a, [role=button]")) {
        if (control.querySelectorAll("svg").length !== 1) {
          continue;
        }
        const icon = control.querySelector("svg");
        if (!icon || icon.parentElement !== control || control.children.length !== 1) {
          continue;
        }
        const copy = control.cloneNode(true);
        if (!(copy instanceof document.defaultView!.Element)) {
          continue;
        }
        copy.querySelectorAll("svg, .sr-only").forEach((element) => element.remove());
        if (copy.textContent?.trim()) {
          continue;
        }
        let unresolved = false;
        const dynamicAttributes = new Set<string>();
        let ancestor: Element | null = control;
        while (ancestor) {
          for (const attribute of ancestor.attributes) {
            if (!attribute.value.includes(dynamic) || attribute.name.startsWith("@")) {
              continue;
            }
            const name = attribute.name.replace(/^[?.]/u, "").replace(/^classname$/u, "class");
            dynamicAttributes.add(name);
            if (/^(?:class|style|data-)/u.test(name)) {
              unresolved = true;
            }
          }
          ancestor = ancestor.parentElement;
        }
        if (unresolved) {
          continue;
        }
        control.setAttribute("data-icon-grid-control", "");
        control.setAttribute("data-icon-grid-dynamic", [...dynamicAttributes].join(" "));
      }
      if (holder.content.querySelector("[data-icon-grid-control]")) {
        fixtures.push({
          file,
          line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
          html: holder.innerHTML,
        });
      }
    }
    node.forEachChild(visit);
  };
  visit(parsed);
  return fixtures;
}

export function loadIconFixtures(rootDir: string): IconFixture[] {
  const sourceRoot = path.join(rootDir, "ui/src");
  const dom = new JSDOM();
  const fixtures: IconFixture[] = [];
  try {
    using parser = createNativeTypeScriptParser({ cwd: rootDir });
    const sources: NativeTypeScriptSource[] = [];
    for (const relative of fs.readdirSync(sourceRoot, { recursive: true }).map(String).toSorted()) {
      const sourcePath = path.join("ui/src", relative).split(path.sep).join("/");
      const facts = getChangedPathFacts(sourcePath);
      if (
        !relative.endsWith(".ts") ||
        facts.isChangedLaneTest ||
        facts.isTestOnly ||
        isTestSupportFileTarget(sourcePath) ||
        sourcePath.startsWith("ui/src/e2e/")
      ) {
        continue;
      }
      const file = path.join(sourceRoot, relative);
      const source = fs.readFileSync(file, "utf8");
      if (!source.includes("<button") && !source.includes("<a")) {
        continue;
      }
      sources.push({ fileName: sourcePath, text: source });
    }
    for (const parsed of parser.parseSourceFiles(sources)) {
      const sourcePath = path.relative(rootDir, parsed.fileName).split(path.sep).join("/");
      fixtures.push(...collectIconFixtures(parsed, sourcePath, dom.window.document));
    }
  } finally {
    dom.window.close();
  }
  return fixtures;
}
