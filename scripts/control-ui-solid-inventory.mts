// Shared syntax census for the migration report and the Lit growth ratchet.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript/unstable/ast";
import { createNativeTypeScriptParser } from "./lib/native-typescript.mts";
import { loadRatchetSources } from "./lib/shrink-ratchet.mts";

const ROOTS = ["ui/src", "extensions/workboard/browser", "extensions/x/src"];
const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const MAX_BUFFER = 256 * 1024 * 1024;

function unwrap(input: ts.Node): ts.Node {
  let node = input;
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

function isLitModule(node: ts.Node | undefined) {
  if (!node) {
    return false;
  }
  const literal = unwrap(node);
  return (
    (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)) &&
    /^(?:lit(?:-html|-element)?|@lit(?:-labs)?\/[^/]+)(?:\/|$)/u.test(literal.text)
  );
}

export function readInventorySources(
  root: string,
  { ref, staged = false, roots = ROOTS }: { ref?: string; staged?: boolean; roots?: string[] } = {},
) {
  const args = ref
    ? ["ls-tree", "-r", "--name-only", "-z", ref, "--", ...roots]
    : [
        "ls-files",
        "-z",
        ...(staged ? [] : ["--cached", "--others", "--exclude-standard"]),
        "--",
        ...roots,
      ];
  const paths = [
    ...new Set(
      execFileSync("git", args, { cwd: root, maxBuffer: MAX_BUFFER })
        .toString("utf8")
        .split("\0")
        .filter((file) => CODE.test(file)),
    ),
  ].toSorted();
  if (ref || staged) {
    return loadRatchetSources(root, paths, ref);
  }
  return new Map(
    paths
      .filter((file) => fs.existsSync(path.join(root, file)))
      .map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]),
  );
}

function emptyMetrics() {
  return {
    litImports: 0,
    htmlTemplates: 0,
    svgTemplates: 0,
    cssTemplates: 0,
    waTags: 0,
    requestUpdate: 0,
    stateDecorators: 0,
    propertyDecorators: 0,
    tasks: 0,
    reactiveControllers: 0,
    customElementDefines: 0,
    consume: 0,
    directives: 0,
    todoSolid2: 0,
  };
}
export type MigrationMetrics = ReturnType<typeof emptyMetrics>;

function nameOf(input: ts.Node): string | undefined {
  const node = unwrap(input);
  if (ts.isComputedPropertyName(node)) {
    return nameOf(node.expression);
  }
  if (
    ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node)
  ) {
    return node.text;
  }
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  if (ts.isQualifiedName(node)) {
    return node.right.text;
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    return nameOf(node.argumentExpression);
  }
  return undefined;
}

function isLitLoad(input: ts.Node): boolean {
  const node = unwrap(input);
  if (ts.isAwaitExpression(node)) {
    return isLitLoad(node.expression);
  }
  return (
    ts.isCallExpression(node) &&
    (unwrap(node.expression).kind === ts.SyntaxKind.ImportKeyword ||
      nameOf(node.expression) === "require") &&
    isLitModule(node.arguments[0])
  );
}

type LitReference = { kind: "namespace" } | { kind: "member"; name: string };
type LitBinding = {
  imported?: LitReference;
  initializer?: ts.Expression;
  property?: string;
};

// Sibling views may use the same local name for different Lit exports.
function createLitNameResolver(tree: ts.SourceFile) {
  const scopes = new WeakMap<ts.Node, Map<string, LitBinding>>();
  const scopeFor = (node: ts.Node, functionOnly = false): ts.Node => {
    for (let scope: ts.Node | undefined = node.parent; scope; scope = scope.parent) {
      if (
        ts.isSourceFile(scope) ||
        ts.isFunctionLikeDeclaration(scope) ||
        ts.isClassStaticBlockDeclaration(scope)
      ) {
        return scope;
      }
      if (
        !functionOnly &&
        (ts.isBlock(scope) ||
          ts.isModuleBlock(scope) ||
          ts.isCaseBlock(scope) ||
          ts.isCatchClause(scope) ||
          ts.isForStatement(scope) ||
          ts.isForInStatement(scope) ||
          ts.isForOfStatement(scope))
      ) {
        return scope;
      }
    }
    return tree;
  };
  const bind = (scope: ts.Node, name: string, binding: LitBinding) => {
    let entries = scopes.get(scope);
    if (!entries) {
      entries = new Map();
      scopes.set(scope, entries);
    }
    entries.set(name, binding);
  };
  const bindPattern = (scope: ts.Node, name: ts.BindingName, binding: LitBinding): void => {
    if (ts.isIdentifier(name)) {
      bind(scope, name.text, binding);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isBindingElement(element) || !element.name) {
        continue;
      }
      const property =
        ts.isObjectBindingPattern(name) && !element.dotDotDotToken
          ? nameOf(element.propertyName ?? element.name)
          : undefined;
      bindPattern(
        scope,
        element.name,
        ts.isObjectBindingPattern(name) ? { ...binding, property } : {},
      );
    }
  };
  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const lit = isLitModule(node.moduleSpecifier);
      const clause = node.importClause;
      if (clause?.name) {
        bind(scopeFor(node), clause.name.text, {});
      }
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        bind(scopeFor(node), bindings.name.text, lit ? { imported: { kind: "namespace" } } : {});
      }
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          bind(
            scopeFor(node),
            specifier.name.text,
            lit
              ? {
                  imported: {
                    kind: "member",
                    name: (specifier.propertyName ?? specifier.name).text,
                  },
                }
              : {},
          );
        }
      }
    }
    if (ts.isImportEqualsDeclaration(node)) {
      bind(
        scopeFor(node),
        node.name.text,
        ts.isExternalModuleReference(node.moduleReference) &&
          isLitModule(node.moduleReference.expression)
          ? { imported: { kind: "namespace" } }
          : {},
      );
    }
    if (ts.isVariableDeclaration(node)) {
      const isVar =
        ts.isVariableDeclarationList(node.parent) &&
        !(node.parent.flags & ts.NodeFlags.BlockScoped);
      bindPattern(scopeFor(node, isVar), node.name, { initializer: node.initializer });
    }
    if (ts.isFunctionLikeDeclaration(node)) {
      for (const parameter of node.parameters) {
        bindPattern(node, parameter.name, { initializer: parameter.initializer });
      }
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      bind(scopeFor(node), node.name.text, {});
    }
    if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) {
      bind(node, node.name.text, {});
    }
    node.forEachChild(collect);
  };
  collect(tree);
  const lookup = (node: ts.Identifier): LitBinding | undefined => {
    for (let scope: ts.Node | undefined = node.parent; scope; scope = scope.parent) {
      const binding = scopes.get(scope)?.get(node.text);
      if (binding) {
        return binding;
      }
    }
    return undefined;
  };
  const resolve = (input: ts.Node, seen = new Set<LitBinding>()): LitReference | undefined => {
    const node = unwrap(input);
    if (ts.isAwaitExpression(node)) {
      return resolve(node.expression, seen);
    }
    if (isLitLoad(node)) {
      return { kind: "namespace" };
    }
    if (ts.isIdentifier(node)) {
      const binding = lookup(node);
      if (!binding || seen.has(binding)) {
        return undefined;
      }
      if (binding.imported) {
        return binding.imported;
      }
      if (!binding.initializer) {
        return undefined;
      }
      seen.add(binding);
      const reference = resolve(binding.initializer, seen);
      return binding.property
        ? reference?.kind === "namespace"
          ? { kind: "member", name: binding.property }
          : undefined
        : reference;
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      resolve(node.expression, seen)?.kind === "namespace"
    ) {
      return { kind: "member", name: node.name.text };
    }
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      resolve(node.expression, seen)?.kind === "namespace"
    ) {
      const argument = unwrap(node.argumentExpression);
      if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
        return { kind: "member", name: argument.text };
      }
    }
    return undefined;
  };
  return (node: ts.Node) => {
    const reference = resolve(node);
    return reference?.kind === "member" ? reference.name : nameOf(node);
  };
}

export function countMigrationSources(root: string, sources: ReadonlyMap<string, string>) {
  using parser = createNativeTypeScriptParser({ cwd: root });
  const result = new Map<string, MigrationMetrics>();
  const files = [...sources].map(([fileName, text]) => ({ fileName, text }));
  const trees = parser.parseSourceFiles(files);
  for (const tree of trees) {
    const fileName = path.relative(root, tree.fileName).split(path.sep).join("/");
    const text = tree.text;
    const diagnostic = parser.getSyntacticDiagnostics(tree.fileName)[0];
    if (diagnostic) {
      throw new Error(
        `${fileName}:${tree.getLineAndCharacterOfPosition(diagnostic.pos).line + 1}: ${diagnostic.text}`,
      );
    }
    const metrics = emptyMetrics();
    const canonicalName = createLitNameResolver(tree);
    const visit = (node: ts.Node): void => {
      // Count module references, including side-effect imports, exports, import types,
      // and dynamic imports. Comments and ordinary strings never become imports.
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        isLitModule(node.moduleSpecifier)
      ) {
        metrics.litImports++;
      }
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        isLitModule(node.argument.literal)
      ) {
        metrics.litImports++;
      }
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        isLitModule(node.moduleReference.expression)
      ) {
        metrics.litImports++;
      }
      if (ts.isCallExpression(node)) {
        const expression = unwrap(node.expression);
        if (isLitLoad(node)) {
          metrics.litImports++;
        }
        if (nameOf(node.expression) === "requestUpdate") {
          metrics.requestUpdate++;
        }
        if (
          ts.isPropertyAccessExpression(expression) &&
          nameOf(expression.expression) === "customElements" &&
          expression.name.text === "define"
        ) {
          metrics.customElementDefines++;
        }
      }
      if (ts.isTaggedTemplateExpression(node)) {
        const name = canonicalName(node.tag);
        if (name === "html") {
          metrics.htmlTemplates++;
        }
        if (name === "svg") {
          metrics.svgTemplates++;
        }
        if (name === "css") {
          metrics.cssTemplates++;
        }
      }
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        metrics.waTags += (node.text.match(/<wa-[a-z0-9-]+(?=[\s/>])/giu) ?? []).length;
      }
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        node.tagName.getText(tree).startsWith("wa-")
      ) {
        metrics.waTags++;
      }
      if (ts.isDecorator(node)) {
        const expression = unwrap(node.expression);
        const name = canonicalName(
          ts.isCallExpression(expression) ? expression.expression : expression,
        );
        if (name === "state") {
          metrics.stateDecorators++;
        }
        if (name === "property") {
          metrics.propertyDecorators++;
        }
        if (name === "consume") {
          metrics.consume++;
        }
        if (name === "customElement") {
          metrics.customElementDefines++;
        }
      }
      if (ts.isNewExpression(node) && canonicalName(node.expression) === "Task") {
        metrics.tasks++;
      }
      if (ts.isHeritageClause(node)) {
        for (const type of node.types) {
          const name = canonicalName(
            ts.isTypeReferenceNode(type) ? type.typeName : type.expression,
          );
          if (node.token === ts.SyntaxKind.ImplementsKeyword && name === "ReactiveController") {
            metrics.reactiveControllers++;
          }
          if (
            node.token === ts.SyntaxKind.ExtendsKeyword &&
            (name === "Directive" || name === "AsyncDirective")
          ) {
            metrics.directives++;
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(tree);
    metrics.todoSolid2 = (text.match(/TODO\(solid2\)/gu) ?? []).length;
    result.set(fileName, metrics);
  }
  return result;
}

export function isTest(file: string) {
  return /(?:\.(?:test|spec|fixture|test-support)\.|-test-(?:support|harness)\.)|(?:^|\/)(?:__tests__|test-helpers|fixtures|e2e)\//u.test(
    file,
  );
}
function bucket(file: string) {
  const parts = file.split("/");
  if (parts[0] === "extensions") {
    return parts.slice(0, 2).join("/");
  }
  if ((parts[2] === "pages" || parts[2] === "components") && parts.length > 4) {
    return parts.slice(2, 4).join("/");
  }
  return parts.length > 3 ? parts.slice(2, 3).join("/") : "(root)";
}
function emptyRow() {
  return {
    prodFiles: 0,
    prodLines: 0,
    testFiles: 0,
    litImportFiles: 0,
    ...emptyMetrics(),
    testLitFiles: 0,
    testUpdateCompleteFiles: 0,
    testWaSelectorFiles: 0,
  };
}

export function main(root = process.cwd(), argv = process.argv.slice(2)) {
  let ref: string | undefined;
  let asJson = false;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--json") {
      asJson = true;
    } else if (argv[index] === "--ref" && argv[index + 1]) {
      ref = argv[++index];
    } else {
      throw new Error("Usage: pnpm ui:solid:inventory [--json] [--ref <commit>]");
    }
  }
  const revision = execFileSync(
    "git",
    ["rev-parse", "--verify", "--end-of-options", `${ref ?? "HEAD"}^{commit}`],
    {
      cwd: root,
      encoding: "utf8",
    },
  ).trim();
  const sources = readInventorySources(root, ref ? { ref: revision } : {});
  const counts = countMigrationSources(root, sources);
  const rows = new Map<string, ReturnType<typeof emptyRow>>();
  const totals = emptyRow();
  for (const [file, metrics] of counts) {
    const key = bucket(file);
    let row = rows.get(key);
    if (!row) {
      row = emptyRow();
      rows.set(key, row);
    }
    const text = sources.get(file)!;
    for (const target of [row, totals]) {
      if (isTest(file)) {
        target.testFiles++;
        target.testLitFiles += Number(metrics.litImports > 0);
        target.testUpdateCompleteFiles += Number(/\bupdateComplete\b/u.test(text));
        target.testWaSelectorFiles += Number(/\bwa-[a-z-]+/u.test(text));
      } else {
        target.prodFiles++;
        target.prodLines += text.split("\n").length - Number(text.endsWith("\n"));
        target.litImportFiles += Number(metrics.litImports > 0);
        for (const metric of Object.keys(metrics) as (keyof MigrationMetrics)[]) {
          target[metric] += metrics[metric];
        }
      }
    }
  }
  const buckets = Object.fromEntries(
    [...rows].toSorted(
      ([a, left], [b, right]) => right.prodLines - left.prodLines || a.localeCompare(b),
    ),
  );
  const head = revision.slice(0, 12);
  if (asJson) {
    console.log(JSON.stringify({ head, roots: ROOTS, totals, buckets }, null, 2));
  } else {
    const columns = [
      "prodLines",
      "litImportFiles",
      "htmlTemplates",
      "waTags",
      "requestUpdate",
      "stateDecorators",
      "tasks",
      "reactiveControllers",
      "todoSolid2",
      "testFiles",
      "testLitFiles",
    ] as const;
    console.log(
      `# Control UI Solid migration inventory @ ${head}\n\n| bucket | ${columns.join(" | ")} |\n|---|${columns.map(() => "---:").join("|")}|`,
    );
    for (const [key, row] of Object.entries(buckets)) {
      console.log(`| ${key} | ${columns.map((column) => row[column]).join(" | ")} |`);
    }
    console.log(`| **total** | ${columns.map((column) => `**${totals[column]}**`).join(" | ")} |`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
