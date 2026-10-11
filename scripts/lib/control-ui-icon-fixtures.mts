import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import * as ts from "typescript/unstable/ast";
import { getChangedPathFacts, isTestSupportFileTarget } from "./changed-path-facts.mjs";
import { createNativeTypeScriptParser, type NativeTypeScriptSource } from "./native-typescript.mts";
import { getPropertyNameText, unwrapExpression } from "./ts-guard-utils.mts";

export type IconFixture = { file: string; line: number; html: string };
const dynamic = "openclaw_unresolved_expression";
const htmlVoidTags = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

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

function literalValue(expression: ts.Expression): string | number | boolean | null | undefined {
  const value = unwrapExpression(expression);
  if (ts.isStringLiteralLikeNode(value)) {
    return value.text;
  }
  if (ts.isNumericLiteral(value)) {
    return Number(value.text);
  }
  if (value.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (value.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  if (value.kind === ts.SyntaxKind.NullKeyword) {
    return null;
  }
  return undefined;
}

function literalBranch(expression: ts.Expression): ts.Expression | undefined {
  if (ts.isConditionalExpression(expression)) {
    const condition = literalValue(expression.condition);
    return condition === undefined
      ? undefined
      : condition
        ? expression.whenTrue
        : expression.whenFalse;
  }
  if (ts.isBinaryExpression(expression)) {
    const left = literalValue(expression.left);
    if (left !== undefined) {
      switch (expression.operatorToken.kind) {
        case ts.SyntaxKind.AmpersandAmpersandToken:
          return left ? expression.right : expression.left;
        case ts.SyntaxKind.BarBarToken:
          return left ? expression.left : expression.right;
        case ts.SyntaxKind.QuestionQuestionToken:
          return left === null ? expression.right : expression.left;
        default:
          return undefined;
      }
    }
  }
  return undefined;
}

function resolvedLiteralBranch(expression: ts.Expression): ts.Expression {
  let value = unwrapExpression(expression);
  for (let selected = literalBranch(value); selected; selected = literalBranch(value)) {
    value = unwrapExpression(selected);
  }
  return value;
}

function jsxClass(expression: ts.Expression): string | null | undefined {
  const initial = unwrapExpression(expression);
  if (
    initial.kind === ts.SyntaxKind.NullKeyword ||
    initial.kind === ts.SyntaxKind.FalseKeyword ||
    initial.kind === ts.SyntaxKind.TrueKeyword
  ) {
    return null;
  }
  if (ts.isStringLiteralLikeNode(initial) || ts.isNumericLiteral(initial)) {
    return initial.text;
  }
  const classes = new Map<string, boolean>();
  function collect(node: ts.Expression): boolean {
    const value = unwrapExpression(node);
    if (ts.isArrayLiteralExpression(value)) {
      return value.elements.every(collect);
    }
    if (ts.isObjectLiteralExpression(value)) {
      for (const property of value.properties) {
        if (!ts.isPropertyAssignment(property)) {
          return false;
        }
        const name = getPropertyNameText(property.name);
        const enabled = literalValue(property.initializer);
        if (name === null || name === "__proto__" || enabled === undefined) {
          return false;
        }
        classes.set(name, Boolean(enabled));
      }
      return true;
    }
    const literal = literalValue(value);
    if (literal === undefined || literal === "__proto__") {
      return false;
    }
    if (literal !== null && typeof literal !== "boolean") {
      classes.set(String(literal), true);
    }
    return true;
  }
  if (!collect(expression)) {
    return undefined;
  }
  // Solid merges raw array/object keys before splitting them into class tokens.
  const tokens = new Set<string>();
  for (const [name, enabled] of classes) {
    if (enabled) {
      for (const token of name.trim().split(/\s+/u)) {
        if (token && token !== "undefined") {
          tokens.add(token);
        }
      }
    }
  }
  return tokens.size ? [...tokens].join(" ") : null;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

type JsxFixtureContext = {
  components: ReadonlyMap<string, string>;
  choices: ReadonlyMap<ts.Node, ts.JsxChild | null | true>;
};

function componentCount(
  node: ts.JsxElement | ts.JsxSelfClosingElement,
  kind: string,
): number | undefined {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  for (const attribute of opening.attributes.properties.toReversed()) {
    if (
      ts.isJsxAttribute(attribute) &&
      attribute.name.getText() === (kind === "For" ? "each" : "when")
    ) {
      if (!attribute.initializer || ts.isStringLiteral(attribute.initializer)) {
        return kind === "Show"
          ? Number(!attribute.initializer || Boolean(attribute.initializer.text))
          : undefined;
      }
      if (!ts.isJsxExpression(attribute.initializer) || !attribute.initializer.expression) {
        return undefined;
      }
      const value = unwrapExpression(attribute.initializer.expression);
      if (kind === "Show") {
        const literal = literalValue(value);
        return literal === undefined ? undefined : Number(Boolean(literal));
      }
      if (
        ts.isArrayLiteralExpression(value) &&
        value.elements.every(
          (element) => !ts.isSpreadElement(element) && !ts.isOmittedExpression(element),
        )
      ) {
        return value.elements.length;
      }
    }
  }
  return undefined;
}

function jsxHtml(node: ts.JsxChild, context: JsxFixtureContext): string {
  const chosen = context.choices.get(node);
  if (context.choices.has(node) && chosen !== true) {
    return chosen ? jsxHtml(chosen, context) : "";
  }
  if (ts.isJsxText(node)) {
    const text = node.text.replaceAll("\r", "");
    return (
      text.includes("\n")
        ? text
            .split("\n")
            .map((line, index) => (index > 0 ? line.trimStart() : line))
            .filter((line) => line.trim() !== "")
            .join(" ")
        : text
    ).replace(/\s+/gu, " ");
  }
  if (ts.isJsxExpression(node)) {
    const expression = node.expression && resolvedLiteralBranch(node.expression);
    if (!expression) {
      return "";
    }
    if (iconExpression(expression)) {
      return '<svg data-icon-grid-probe="" viewBox="0 0 24 24"></svg>';
    }
    if (
      ts.isJsxElement(expression) ||
      ts.isJsxSelfClosingElement(expression) ||
      ts.isJsxFragment(expression)
    ) {
      return jsxHtml(expression, context);
    }
    const literal = literalValue(expression);
    return literal === undefined
      ? dynamic
      : literal === null || typeof literal === "boolean"
        ? ""
        : escapeHtml(String(literal));
  }
  if (ts.isJsxFragment(node)) {
    return node.children.map((child) => jsxHtml(child, context)).join("");
  }
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  const tag = opening.tagName.getText();
  const children = ts.isJsxElement(node)
    ? node.children.map((child) => jsxHtml(child, context)).join("")
    : "";
  if (context.components.has(tag)) {
    if (opening.attributes.properties.some(ts.isJsxSpreadAttribute)) {
      return dynamic;
    }
    const component = context.components.get(tag)!;
    const count = componentCount(node, component);
    if (component === "Show" && count === undefined && chosen !== true) {
      return dynamic;
    }
    if (
      count === 0 &&
      opening.attributes.properties.some(
        (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText() === "fallback",
      )
    ) {
      return dynamic;
    }
    if (component === "For") {
      // One branch choice cannot establish the DOM of every callback invocation.
      const repeatedChoice =
        count !== undefined &&
        count > 1 &&
        [...context.choices.keys()].some(
          (choice) =>
            choice.pos > node.pos &&
            choice.end < node.end &&
            (!ts.isJsxExpression(choice) ||
              !choice.expression ||
              jsxBranches(choice.expression, true).length !== 1),
        );
      return count === undefined || repeatedChoice ? dynamic : children.repeat(count);
    }
    return count === 0 ? "" : children;
  }
  // Component output and spread props cannot establish literal DOM ancestry.
  if (!/^[a-z][a-z0-9-]*$/u.test(tag)) {
    return dynamic;
  }
  const attributes: string[] = [`data-icon-grid-source="${node.pos}:${node.end}"`];
  for (const attribute of opening.attributes.properties) {
    if (ts.isJsxSpreadAttribute(attribute)) {
      attributes.push('data-icon-grid-unknown=""');
      continue;
    }
    const rawName = attribute.name.getText();
    if (
      rawName.startsWith("prop:") ||
      ["innerHTML", "innerText", "textContent", "children"].includes(rawName)
    ) {
      attributes.push('data-icon-grid-unknown=""');
    }
    const name = rawName.replace(/^prop:/u, "");
    if (/^on[A-Z]/u.test(name) || name === "ref") {
      continue;
    }
    const initializer = attribute.initializer;
    if (!initializer || ts.isStringLiteral(initializer)) {
      attributes.push(`${name}=${initializer ? initializer.getText() : '""'}`);
      continue;
    }
    const expression = ts.isJsxExpression(initializer) && initializer.expression;
    const value = expression
      ? name === "class"
        ? jsxClass(expression)
        : literalValue(expression)
      : undefined;
    if (value !== null && value !== false) {
      attributes.push(
        `${name}="${escapeHtml(value === undefined ? dynamic : value === true ? "" : String(value))}"`,
      );
    }
  }
  return `<${tag} ${attributes.join(" ")}>${htmlVoidTags.has(tag) ? "" : `${children}</${tag}>`}`;
}

function jsxBranches(expression: ts.Expression, callback: boolean): Array<ts.JsxChild | null> {
  const value = resolvedLiteralBranch(expression);
  if (ts.isJsxElement(value) || ts.isJsxSelfClosingElement(value) || ts.isJsxFragment(value)) {
    return [value];
  }
  if (ts.isConditionalExpression(value)) {
    return [...jsxBranches(value.whenTrue, callback), ...jsxBranches(value.whenFalse, callback)];
  }
  if (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return [null, ...jsxBranches(value.right, callback)];
  }
  if (callback && ts.isArrowFunction(value) && !ts.isBlock(value.body)) {
    return jsxBranches(value.body, false);
  }
  if (
    value.kind === ts.SyntaxKind.NullKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.TrueKeyword
  ) {
    return [null];
  }
  return [];
}

function jsxFixtures(root: ts.JsxChild, components: ReadonlyMap<string, string>) {
  const variants = [{ range: root, choices: new Map<ts.Node, ts.JsxChild | null | true>() }];
  const visit = (
    node: ts.JsxChild,
    choices: Map<ts.Node, ts.JsxChild | null | true>,
    callback = false,
  ) => {
    if (ts.isJsxExpression(node)) {
      if (!node.expression) {
        return;
      }
      const expression = resolvedLiteralBranch(node.expression);
      const direct =
        ts.isJsxElement(expression) ||
        ts.isJsxSelfClosingElement(expression) ||
        ts.isJsxFragment(expression);
      for (const branch of jsxBranches(expression, callback)) {
        const next = new Map(choices);
        if (!direct) {
          next.set(node, branch);
          variants.push({ range: branch ?? node, choices: next });
        }
        if (branch) {
          visit(branch, next);
        }
      }
      return;
    }
    if (ts.isJsxText(node)) {
      return;
    }
    let childChoices = choices;
    let childCallback = callback;
    if (!ts.isJsxFragment(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = opening.tagName.getText();
      if (!/^[a-z][a-z0-9-]*$/u.test(tag) && !components.has(tag)) {
        return;
      }
      childCallback = components.has(tag);
      if (childCallback && opening.attributes.properties.some(ts.isJsxSpreadAttribute)) {
        return;
      }
      const count = components.has(tag) ? componentCount(node, components.get(tag)!) : undefined;
      if (components.get(tag) === "For" && count === undefined) {
        return;
      }
      if (components.get(tag) === "Show" && count === undefined) {
        childChoices = new Map(choices).set(node, true);
        variants.push({ range: node, choices: childChoices });
      }
      if (components.has(tag)) {
        let hasFallback = false;
        for (const attribute of opening.attributes.properties) {
          if (ts.isJsxAttribute(attribute) && attribute.name.getText() === "fallback") {
            hasFallback = true;
            if (count !== undefined && count > 0) {
              continue;
            }
            if (
              !attribute.initializer ||
              !ts.isJsxExpression(attribute.initializer) ||
              !attribute.initializer.expression
            ) {
              continue;
            }
            for (const branch of jsxBranches(attribute.initializer.expression, false)) {
              const next = new Map(choices).set(node, branch);
              variants.push({ range: branch ?? node, choices: next });
              if (branch) {
                visit(branch, next);
              }
            }
          }
        }
        if (!hasFallback && (count === undefined || count === 0)) {
          variants.push({ range: node, choices: new Map(choices).set(node, null) });
        }
      }
      if (count === 0) {
        return;
      }
    }
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      for (const child of node.children) {
        visit(child, childChoices, childCallback);
      }
    }
  };
  visit(root, variants[0]!.choices);
  // One witness per branch keeps mutually exclusive controls out of the same DOM.
  return variants.map(({ range, choices }) => ({
    range,
    html: jsxHtml(root, { components, choices }),
  }));
}

function jsxWitnessKey(control: Element, root: DocumentFragment): string {
  const shape = (element: Element) => [
    element.tagName,
    element.childNodes.length === 0,
    [...element.attributes]
      .filter((attribute) => !attribute.name.startsWith("data-icon-grid-"))
      .map((attribute) => [attribute.name, attribute.value]),
  ];
  const context = [
    control.innerHTML.replaceAll(/ data-icon-grid-source="\d+:\d+"/gu, ""),
    JSON.stringify(shape(control)),
  ];
  let child = control;
  for (let parent = child.parentElement; parent; parent = child.parentElement) {
    context.push(
      JSON.stringify([
        shape(parent),
        [...parent.children].map((sibling) => (sibling === child ? null : shape(sibling))),
      ]),
    );
    child = parent;
  }
  // Descendant-sensitive selectors are deferred; direct emptiness still distinguishes siblings.
  context.push(
    JSON.stringify(
      [...root.children].map((sibling) => (sibling === child ? null : shape(sibling))),
    ),
  );
  return JSON.stringify(context);
}

function unresolvedJsxChildren(parent: Element | DocumentFragment, icon: Element): boolean {
  return (
    [...parent.childNodes].some(
      (child) => child.nodeType === child.TEXT_NODE && child.textContent?.includes(dynamic),
    ) ||
    [...parent.children].some(
      (sibling) =>
        !sibling.contains(icon) &&
        (sibling.textContent?.includes(dynamic) ||
          sibling.hasAttribute("data-icon-grid-unknown") ||
          [...sibling.attributes].some((attribute) => attribute.value.includes(dynamic))),
    )
  );
}

/** Only literal HTML ancestry and a single known SVG are witnesses, not invented class combinations. */
export function collectIconFixtures(
  parsed: ts.SourceFile,
  file: string,
  document: Document,
): IconFixture[] {
  const fixtures: IconFixture[] = [];
  const components = new Map<string, string>();
  for (const statement of parsed.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "solid-js" ||
      statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      for (const name of ["Show", "For"]) {
        components.set(`${bindings.name.text}.${name}`, name);
      }
    }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (!element.isTypeOnly && (imported === "Show" || imported === "For")) {
          components.set(element.name.text, imported);
        }
      }
    }
  }
  // Plain stylesheets cannot establish the cascade inside a shadow/custom render root.
  let customRoot = false;
  const shadowed = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      for (const component of components.keys()) {
        if (component.split(".")[0] === name.text) {
          components.delete(component);
        }
      }
    } else {
      for (const element of name.elements) {
        // Native AST array elisions are binding elements without a name.
        if (ts.isBindingElement(element) && element.name) {
          shadowed(element.name);
        }
      }
    }
  };
  const inspectRoot = (node: ts.Node) => {
    if (ts.isParameterDeclaration(node) || ts.isVariableDeclaration(node)) {
      shadowed(node.name);
    }
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node)) &&
      node.name
    ) {
      shadowed(node.name);
    }
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
    if (/\.[jt]sx$/u.test(parsed.fileName)) {
      if (ts.isConditionalExpression(node) || ts.isBinaryExpression(node)) {
        const selected = literalBranch(node);
        if (selected) {
          visit(selected);
          return;
        }
      }
    }
    const jsx = ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
    if (jsx || (ts.isTaggedTemplateExpression(node) && node.tag.getText(parsed) === "html")) {
      let variants: Array<{ html: string; range: ts.Node }>;
      if (jsx) {
        variants = jsxFixtures(node, components);
      } else {
        const template = node.template;
        let html = ts.isNoSubstitutionTemplateLiteral(template)
          ? template.text
          : template.head.text;
        if (ts.isTemplateExpression(template)) {
          for (const span of template.templateSpans) {
            html +=
              (iconExpression(span.expression)
                ? '<svg data-icon-grid-probe="" viewBox="0 0 24 24"></svg>'
                : dynamic) + span.literal.text;
          }
        }
        variants = [{ html, range: node }];
      }
      const witnessedControls = new Set<string>();
      for (const { html, range } of variants) {
        const holder = document.createElement("template");
        holder.innerHTML = html;
        if (holder.content.querySelector("style, link[rel=stylesheet]")) {
          return;
        }
        for (const control of holder.content.querySelectorAll("button, a, [role=button]")) {
          const [start, end] = (control.getAttribute("data-icon-grid-source") ?? "")
            .split(":")
            .map(Number);
          const containsBranch =
            start !== undefined && end !== undefined && start <= range.pos && end >= range.end;
          const insideBranch = start !== undefined && start >= range.pos && start < range.end;
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
          let unresolved = jsx && unresolvedJsxChildren(holder.content, icon);
          const dynamicAttributes = new Set<string>();
          let ancestor: Element | null = jsx ? icon : control;
          while (ancestor) {
            // An unresolved sibling may be an element and change structural selectors.
            if (jsx && unresolvedJsxChildren(ancestor, icon)) {
              unresolved = true;
            }
            if (ancestor.hasAttribute("data-icon-grid-unknown")) {
              unresolved = true;
            }
            for (const attribute of ancestor.attributes) {
              if (!attribute.value.includes(dynamic) || attribute.name.startsWith("@")) {
                continue;
              }
              const name = jsx
                ? attribute.name
                : attribute.name.replace(/^[?.]/u, "").replace(/^classname$/u, "class");
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
          const witness = jsx ? `${start}:${jsxWitnessKey(control, holder.content)}` : "";
          if (jsx && !containsBranch && !insideBranch && witnessedControls.has(witness)) {
            continue;
          }
          control.setAttribute("data-icon-grid-control", "");
          control.setAttribute("data-icon-grid-dynamic", [...dynamicAttributes].join(" "));
          if (jsx && start !== undefined) {
            witnessedControls.add(witness);
          }
        }
        holder.content
          .querySelectorAll("[data-icon-grid-source]")
          .forEach((element) => element.removeAttribute("data-icon-grid-source"));
        if (holder.content.querySelector("[data-icon-grid-control]")) {
          fixtures.push({
            file,
            line: parsed.getLineAndCharacterOfPosition(range.getStart(parsed)).line + 1,
            html: holder.innerHTML,
          });
        }
      }
      if (jsx) {
        return;
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
        !/\.tsx?$/u.test(relative) ||
        facts.isChangedLaneTest ||
        facts.isTestOnly ||
        isTestSupportFileTarget(sourcePath) ||
        sourcePath.startsWith("ui/src/e2e/")
      ) {
        continue;
      }
      const file = path.join(sourceRoot, relative);
      const source = fs.readFileSync(file, "utf8");
      if (
        !source.includes("<button") &&
        !source.includes("<a") &&
        !(relative.endsWith(".tsx") && /\brole\s*=/u.test(source))
      ) {
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
