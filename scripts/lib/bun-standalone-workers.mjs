import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Keep launcher ownership in the runtime manifest; discover additional module workers. */
export function discoverStandaloneWorkers({
  runtimeRoot,
  moduleEntries,
  runtimeEntrypoints,
  parse,
}) {
  const entries = new Set(
    Object.values(runtimeEntrypoints).map(({ distWorkerPath }) => `dist/${distWorkerPath}`),
  );
  for (const entry of moduleEntries) {
    if (
      (entry.startsWith("dist/worker/") && !path.basename(entry).startsWith("worker-chunk-")) ||
      /(?:\.worker|\.child|-worker\.runtime)\.[cm]?js$/.test(entry) ||
      entry === "dist/telegram-ingress-worker.runtime.js"
    ) {
      entries.add(entry);
    } else if (/\.[cm]?js$/.test(entry) && !entry.split(/[\\/]/).includes("node_modules")) {
      const contents = fs.readFileSync(path.join(runtimeRoot, entry), "utf8");
      if (
        contents.includes("import.meta") &&
        /\b(?:Worker|createCpuTrackedWorker|createRetainedNativeWorker)\b/.test(contents) &&
        hasSelfTargetedWorker(
          contents,
          parse(contents, { ecmaVersion: "latest", sourceType: "module" }),
        )
      ) {
        entries.add(entry);
      }
    }
  }
  const workers = [...entries].toSorted((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const missing = workers.filter((entry) => !fs.existsSync(path.join(runtimeRoot, entry)));
  if (missing.length) {
    throw new Error(`Missing standalone worker outputs: ${missing.join(", ")}`);
  }
  return workers;
}

function visitNodes(node, visit) {
  if (!node || typeof node !== "object") {
    return;
  }
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      value.forEach((child) => visitNodes(child, visit));
    } else if (value && typeof value === "object") {
      visitNodes(value, visit);
    }
  }
}

// Resolve fixed programs without executing an application module during the build.
function fixedProgramEvaluator(contents, ast, isModuleBinding) {
  const bindings = new Map();
  const declared = new Set();
  for (const statement of ast.body) {
    const node = statement.declaration ?? statement;
    if (node.type === "FunctionDeclaration" && node.id) {
      bindings.set(node.id.name, node);
    }
    if (node.type === "VariableDeclaration") {
      for (const declaration of node.declarations) {
        if (declaration.id.type === "Identifier") {
          declared.add(declaration.id.name);
          if (declaration.init) {
            bindings.set(declaration.id.name, declaration.init);
          }
        }
      }
    }
  }
  // Bundled lazy module initializers assign their module-level constants once.
  const assignments = new Map();
  visitNodes(ast, (node) => {
    if (
      node.type === "AssignmentExpression" &&
      node.operator === "=" &&
      node.left.type === "Identifier" &&
      declared.has(node.left.name) &&
      isModuleBinding(node.left)
    ) {
      const candidates = assignments.get(node.left.name) ?? [];
      candidates.push(node.right);
      assignments.set(node.left.name, candidates);
    }
  });
  for (const [name, candidates] of assignments) {
    if (bindings.has(name)) {
      bindings.delete(name);
    } else if (candidates.length === 1) {
      bindings.set(name, candidates[0]);
    }
  }
  const resolving = new Set();
  function evaluate(node) {
    if (node?.type === "Literal") {
      return node.value;
    }
    if (
      node?.type === "Identifier" &&
      isModuleBinding(node) &&
      bindings.has(node.name) &&
      !resolving.has(node.name)
    ) {
      resolving.add(node.name);
      try {
        return evaluate(bindings.get(node.name));
      } finally {
        resolving.delete(node.name);
      }
    }
    if (node?.type === "TemplateLiteral") {
      return node.quasis.reduce(
        (result, part, index) =>
          result +
          part.value.cooked +
          (index < node.expressions.length ? evaluate(node.expressions[index]) : ""),
        "",
      );
    }
    if (
      node?.type === "TaggedTemplateExpression" &&
      node.tag.type === "MemberExpression" &&
      !node.tag.computed &&
      node.tag.object.name === "String" &&
      node.tag.property.name === "raw"
    ) {
      return node.quasi.quasis.reduce(
        (result, part, index) =>
          result +
          part.value.raw +
          (index < node.quasi.expressions.length ? evaluate(node.quasi.expressions[index]) : ""),
        "",
      );
    }
    if (node?.type === "BinaryExpression" && node.operator === "+") {
      return evaluate(node.left) + evaluate(node.right);
    }
    if (
      node?.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      !node.callee.computed
    ) {
      const { object, property } = node.callee;
      if (object.name === "JSON" && property.name === "stringify" && node.arguments.length === 1) {
        return JSON.stringify(evaluate(node.arguments[0]));
      }
      if (property.name === "toString" && node.arguments.length === 0) {
        const target =
          object.type === "Identifier"
            ? isModuleBinding(object) && bindings.get(object.name)
            : object;
        if (
          ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
            target?.type,
          )
        ) {
          return contents.slice(target.start, target.end);
        }
      }
    }
    throw new Error(
      `Unsupported fixed worker source expression: ${node?.type ?? "missing"}${node?.name ? ` ${node.name}` : ""}`,
    );
  }
  return evaluate;
}

function workerBindings(contents, ast) {
  const scopes = new WeakMap();
  const root = { bindings: new Map(), functionScope: true };
  const lookup = (name, scope) => {
    for (let owner = scope; owner; owner = owner.parent) {
      if (owner.bindings.has(name)) {
        const binding = owner.bindings.get(name);
        return typeof binding === "function" ? binding() : binding;
      }
    }
    return false;
  };
  const kind = (node, scope) => {
    if (node?.type === "AwaitExpression") {
      return kind(node.argument, scope);
    }
    if (node?.type === "Identifier") {
      return lookup(node.name, scope);
    }
    if (
      (node?.type === "ImportExpression" &&
        ["worker_threads", "node:worker_threads"].includes(node.source.value)) ||
      (node?.type === "CallExpression" &&
        node.callee.name === "require" &&
        ["worker_threads", "node:worker_threads"].includes(node.arguments[0]?.value))
    ) {
      return "namespace";
    }
    if (
      node?.type === "MemberExpression" &&
      !node.computed &&
      node.property.name === "Worker" &&
      kind(node.object, scope) === "namespace"
    ) {
      return "worker";
    }
    // Existing owners permit an injected factory while retaining their native fallback.
    if (node?.type === "LogicalExpression" && node.operator === "??") {
      return kind(node.right, scope);
    }
    return false;
  };
  const bind = (pattern, scope, value = false) => {
    if (!pattern) {
      return;
    }
    if (pattern.type === "Identifier") {
      scope.bindings.set(pattern.name, value);
    } else if (pattern.type === "ObjectPattern") {
      for (const property of pattern.properties) {
        bind(
          property.value ?? property.argument,
          scope,
          property.key?.name === "Worker" && value === "namespace" ? "worker" : false,
        );
      }
    } else if (pattern.type === "ArrayPattern") {
      pattern.elements.forEach((entry) => bind(entry, scope));
    } else if (pattern.type === "AssignmentPattern" || pattern.type === "RestElement") {
      bind(pattern.left ?? pattern.argument, scope);
    }
  };
  const knownFactory = (name) =>
    (name === "createCpuTrackedWorker" && contents.includes("//#region src/infra/worker-cpu.ts")) ||
    (name === "createRetainedNativeWorker" &&
      contents.includes("//#region src/infra/worker-native-lifecycle.ts"));
  const visit = (node, outer) => {
    if (!node || typeof node !== "object" || !node.type) {
      return;
    }
    const isFunction = [
      "FunctionDeclaration",
      "FunctionExpression",
      "ArrowFunctionExpression",
    ].includes(node.type);
    if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
      bind(node.id, outer, knownFactory(node.id?.name) ? "worker" : false);
    }
    let scope = outer;
    if (
      isFunction ||
      [
        "BlockStatement",
        "CatchClause",
        "ForStatement",
        "ForInStatement",
        "ForOfStatement",
        "SwitchStatement",
        "ClassExpression",
        "ClassDeclaration",
        "StaticBlock",
      ].includes(node.type)
    ) {
      scope = {
        parent: outer,
        bindings: new Map(),
        functionScope: isFunction || node.type === "StaticBlock",
      };
      if (isFunction) {
        bind(node.id, scope, knownFactory(node.id?.name) ? "worker" : false);
        node.params.forEach((parameter) => bind(parameter, scope));
      } else if (node.type === "CatchClause") {
        bind(node.param, scope);
      } else if (node.type.startsWith("Class")) {
        bind(node.id, scope);
      }
    }
    scopes.set(node, scope);
    if (node.type === "ImportDeclaration") {
      const native = ["worker_threads", "node:worker_threads"].includes(node.source.value);
      const factoryModule = /(?:^|\/)(?:worker-cpu|worker-native-lifecycle)(?:[.-]|$)/.test(
        node.source.value,
      );
      for (const specifier of node.specifiers) {
        bind(
          specifier.local,
          scope,
          native
            ? specifier.type === "ImportSpecifier"
              ? specifier.imported.name === "Worker" && "worker"
              : "namespace"
            : factoryModule &&
                [specifier.imported?.name, specifier.local.name].some((name) =>
                  ["createCpuTrackedWorker", "createRetainedNativeWorker"].includes(name),
                )
              ? "worker"
              : false,
        );
      }
    }
    if (node.type === "VariableDeclaration") {
      let owner = scope;
      while (node.kind === "var" && !owner.functionScope) {
        owner = owner.parent;
      }
      for (const declaration of node.declarations) {
        // Direct namespace destructuring is enough for native require/import forms.
        const value =
          declaration.id.type === "ObjectPattern" ? kind(declaration.init, scope) : false;
        bind(declaration.id, owner, value);
        if (declaration.id.type === "Identifier" && declaration.init) {
          owner.bindings.set(declaration.id.name, () => kind(declaration.init, scope));
        }
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        value.forEach((child) => visit(child, scope));
      } else {
        visit(value, scope);
      }
    }
  };
  visit(ast, root);
  return {
    isWorkerCall: (node) => kind(node.callee, scopes.get(node)) === "worker",
    isModuleBinding(node) {
      for (let scope = scopes.get(node); scope; scope = scope.parent) {
        if (scope.bindings.has(node.name)) {
          return scope === root;
        }
      }
      return false;
    },
  };
}

function hasSelfTargetedWorker(contents, ast) {
  const { isWorkerCall } = workerBindings(contents, ast);
  let found = false;
  visitNodes(ast, (node) => {
    if (!["CallExpression", "NewExpression"].includes(node.type) || !isWorkerCall(node)) {
      return;
    }
    let target = node.arguments[0];
    if (
      target?.type === "NewExpression" &&
      target.callee.name === "URL" &&
      target.arguments.length === 1
    ) {
      target = target.arguments[0];
    }
    if (
      target?.type === "MemberExpression" &&
      !target.computed &&
      target.property.name === "url" &&
      target.object.type === "MetaProperty" &&
      target.object.meta.name === "import" &&
      target.object.property.name === "meta"
    ) {
      found = true;
    }
  });
  return found;
}

function inlineWorkerPrograms(contents, ast, bindings) {
  const evaluate = fixedProgramEvaluator(contents, ast, bindings.isModuleBinding);
  const programs = [];
  visitNodes(ast, (node) => {
    if (!["CallExpression", "NewExpression"].includes(node.type)) {
      return;
    }
    const options = node.arguments[1];
    if (options?.type !== "ObjectExpression") {
      return;
    }
    const flag = options.properties.find(
      (property) =>
        property.type === "Property" &&
        (property.computed ? property.key.value : (property.key.name ?? property.key.value)) ===
          "eval" &&
        property.value.type === "Literal" &&
        property.value.value === true,
    );
    if (!flag || !bindings.isWorkerCall(node)) {
      return;
    }
    const source = evaluate(node.arguments[0]);
    if (typeof source !== "string") {
      throw new Error("Fixed worker source must be a string");
    }
    programs.push({ node, flag, source });
  });
  return programs;
}

function fixedEvalChildren(contents, ast, bindings) {
  const evaluate = fixedProgramEvaluator(contents, ast, bindings.isModuleBinding);
  const programs = [];
  const text = (node) =>
    node?.type === "Literal"
      ? node.value
      : node?.type === "TemplateLiteral" && node.expressions.length === 0
        ? node.quasis[0].value.cooked
        : undefined;
  visitNodes(ast, (node) => {
    if (node.type !== "ArrayExpression" || node.elements.length !== 5) {
      return;
    }
    const [executable, preload, inputType, flag, body] = node.elements;
    if (
      executable?.type !== "MemberExpression" ||
      executable.computed ||
      executable.object.name !== "process" ||
      executable.property.name !== "execPath" ||
      preload?.type !== "SpreadElement" ||
      text(inputType) !== "--input-type=module" ||
      text(flag) !== "--eval"
    ) {
      return;
    }
    const source = evaluate(body);
    // Only this fixed reader drops the original preload; its generated entry runs the bootstrap.
    if (
      typeof source !== "string" ||
      !source.includes("const { loadLanceDbModule } = await import(input.moduleUrl);")
    ) {
      return;
    }
    programs.push({ node, source });
  });
  return programs;
}

/** Give each worker an embedded entry while retaining physical paths for admission checks. */
export function prepareStandaloneWorkers({
  runtimeRoot,
  outputRoot,
  workerEntries,
  runtimeBootstrap,
  moduleAliases = {},
  moduleEntries,
  parse,
}) {
  const wrapperRoot = path.join(outputRoot, "standalone-workers");
  const entrypoints = [];
  const workerMap = {};
  const inlineWorkers = [];
  const inlineResiduals = [];
  const inlineBySource = new Map();
  const evalChildBySource = new Map();
  const evalChildEntries = [];
  for (const entry of new Set(moduleEntries)) {
    if (entry.split(/[\\/]/).includes("node_modules") || !/\.[cm]?js$/.test(entry)) {
      continue;
    }
    const filename = path.resolve(runtimeRoot, entry);
    const contents = fs.readFileSync(filename, "utf8");
    if (!/\beval\b/.test(contents)) {
      continue;
    }
    let programs;
    let children;
    try {
      const ast = parse(contents, { ecmaVersion: "latest", sourceType: "module" });
      const bindings = workerBindings(contents, ast);
      programs = inlineWorkerPrograms(contents, ast, bindings);
      children = fixedEvalChildren(contents, ast, bindings);
    } catch (error) {
      inlineResiduals.push({ file: entry, error: String(error) });
      throw new Error(`Cannot embed inline worker in ${entry}: ${error.message}`, { cause: error });
    }
    for (const { source, node } of programs) {
      let record = inlineBySource.get(source);
      if (!record) {
        const id = createHash("sha256").update(source).digest("hex");
        const wrapper = path.join(wrapperRoot, "inline", `${id}.mjs`);
        const payload = path.join(wrapperRoot, "inline", `${id}.body.cjs`);
        fs.mkdirSync(path.dirname(wrapper), { recursive: true });
        // The ESM wrapper installs runtime hooks before executing the CJS worker body.
        fs.writeFileSync(
          wrapper,
          `import ${JSON.stringify(runtimeBootstrap)};\nawait import(${JSON.stringify(payload)});\n`,
        );
        fs.writeFileSync(payload, source + "\n");
        entrypoints.push(wrapper);
        record = {
          id,
          embedded: `file:///$bunfs/root/standalone-workers/inline/${id}.js`,
          sites: [],
        };
        inlineWorkers.push(record);
        inlineBySource.set(source, record);
      }
      record.sites.push({ file: entry, offset: node.start });
    }
    for (const { source, node } of children) {
      let record = evalChildBySource.get(source);
      if (!record) {
        const id = createHash("sha256").update(source).digest("hex");
        const relative = `dist/standalone-fixed-eval/${id}.mjs`;
        const childFilename = path.join(runtimeRoot, relative);
        fs.mkdirSync(path.dirname(childFilename), { recursive: true });
        fs.writeFileSync(childFilename, source + "\n");
        moduleEntries.push(relative);
        record = { id, entry: relative, sites: [] };
        evalChildEntries.push(record);
        evalChildBySource.set(source, record);
      }
      record.sites.push({ file: entry, offset: node.start });
    }
  }
  fs.writeFileSync(
    path.join(outputRoot, "fixed-eval-child-entries.json"),
    JSON.stringify(evalChildEntries, null, 2),
  );
  for (const entry of workerEntries) {
    const wrapper = path.join(wrapperRoot, entry);
    fs.mkdirSync(path.dirname(wrapper), { recursive: true });
    fs.writeFileSync(
      wrapper,
      `import ${JSON.stringify(runtimeBootstrap)};\nawait import(${JSON.stringify(path.join(runtimeRoot, entry))});\n`,
    );
    entrypoints.push(wrapper);
    workerMap[entry] =
      `file:///$bunfs/root/standalone-workers/${entry.replace(/\.[cm]?js$/, ".js")}`;
  }

  const workerThreadsShim = path.join(outputRoot, "standalone-worker-threads.cjs");
  // CJS consumers must share this bundled factory, not require a relocated ESM chunk.
  fs.writeFileSync(
    workerThreadsShim,
    `const path = require("node:path");
const { fileURLToPath } = require("node:url");
const native = require("node:worker_threads");
const root = path.join(path.dirname(process.execPath), "runtime");
const entries = ${JSON.stringify(workerMap)};
function embeddedWorker(filename, options) {
  if (options?.eval) return filename;
  const url = filename instanceof URL ? filename : undefined;
  if (url && url.protocol !== "file:") return filename;
  const pathname = url ? fileURLToPath(url) : filename;
  if (typeof pathname !== "string" || !path.isAbsolute(pathname)) return filename;
  const relative = path.relative(root, pathname).split(path.sep).join("/");
  return entries[relative] ? new URL(entries[relative]) : filename;
}
class Worker extends native.Worker {
  constructor(filename, options) {
    super(embeddedWorker(filename, options), options);
  }
}
module.exports = { ...native, Worker };
`,
  );
  function rewriteWorkerImports(filename, contents, ast) {
    if (filename === workerThreadsShim) {
      return contents;
    }
    const edits = [];
    const pending = [ast];
    while (pending.length) {
      const node = pending.pop();
      if (!node || typeof node !== "object") {
        continue;
      }
      const source =
        node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration" ||
        node.type === "ImportExpression"
          ? node.source
          : node.type === "CallExpression" && node.callee?.name === "require"
            ? node.arguments[0]
            : undefined;
      if (
        source?.value === "node:worker_threads" ||
        source?.value === "worker_threads" ||
        moduleAliases[source?.value]
      ) {
        edits.push([source.start, source.end, moduleAliases[source.value] ?? workerThreadsShim]);
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          pending.push(...value);
        } else if (value && typeof value === "object") {
          pending.push(value);
        }
      }
    }
    let transformed = contents;
    for (const [start, end, target] of edits.toSorted((a, b) => b[0] - a[0])) {
      transformed = transformed.slice(0, start) + JSON.stringify(target) + transformed.slice(end);
    }
    return transformed;
  }
  function rewriteInlineWorkers(filename, contents, ast) {
    if (
      !filename.startsWith(runtimeRoot + path.sep) ||
      filename.split(path.sep).includes("node_modules")
    ) {
      return contents;
    }
    if (!/\beval\b/.test(contents)) {
      return contents;
    }
    const parsed = ast ?? parse(contents, { ecmaVersion: "latest", sourceType: "module" });
    const bindings = workerBindings(contents, parsed);
    const edits = [];
    for (const { node, flag, source } of inlineWorkerPrograms(contents, parsed, bindings)) {
      const record = inlineBySource.get(source);
      if (!record) {
        throw new Error(`Uncaptured inline worker in ${filename}`);
      }
      edits.push([
        node.arguments[0].start,
        node.arguments[0].end,
        `new URL(${JSON.stringify(record.embedded)})`,
      ]);
      edits.push([flag.value.start, flag.value.end, "false"]);
    }
    const children = fixedEvalChildren(contents, parsed, bindings);
    for (const { node, source } of children) {
      const record = evalChildBySource.get(source);
      if (!record) {
        throw new Error(`Uncaptured fixed eval child in ${filename}`);
      }
      edits.push([
        node.start,
        node.end,
        `[process.execPath, __openclawStandaloneChildPath(new URL(${JSON.stringify(record.entry)}, globalThis.__openclawStandaloneRootUrl))]`,
      ]);
    }
    let transformed = contents;
    for (const [start, end, replacement] of edits.toSorted((left, right) => right[0] - left[0])) {
      transformed = transformed.slice(0, start) + replacement + transformed.slice(end);
    }
    return children.length
      ? `import { fileURLToPath as __openclawStandaloneChildPath } from "node:url";\n${transformed}`
      : transformed;
  }
  return {
    entrypoints,
    workerMap,
    workerThreadsShim,
    rewriteWorkerImports,
    rewriteInlineWorkers,
    inlineWorkers,
    inlineResiduals,
    evalChildEntries,
  };
}
