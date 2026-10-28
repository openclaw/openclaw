import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const programOwners = [
  "src/media/staged-inputs.ts",
  "src/gateway/worker-environments/workspace-path-exclusions.ts",
  "src/gateway/worker-environments/workspace-hash-memo.ts",
  "src/worker/workspace-seed-retention.ts",
];
const receiverOwner = "src/worker/workspace-rsync-receiver.ts";
const receiverPrograms = [
  "REMOTE_WORKSPACE_ACCEPTED_RSYNC_RECEIVER_JS",
  "REMOTE_WORKSPACE_RSYNC_RECEIVER_JS",
];

function importedCompileCalls(ast) {
  const root = { parent: undefined, bindings: new Map(), functionScope: true };
  const calls = [];
  const bind = (pattern, scope) => {
    if (!pattern) {
      return;
    }
    if (pattern.type === "Identifier") {
      scope.bindings.set(pattern.name, false);
    } else if (pattern.type === "RestElement") {
      bind(pattern.argument, scope);
    } else if (pattern.type === "AssignmentPattern") {
      bind(pattern.left, scope);
    } else if (pattern.type === "ArrayPattern") {
      pattern.elements.forEach((item) => bind(item, scope));
    } else if (pattern.type === "ObjectPattern") {
      pattern.properties.forEach((item) =>
        bind(item.type === "RestElement" ? item.argument : item.value, scope),
      );
    }
  };
  const visit = (node, outer) => {
    if (!node || typeof node !== "object" || !node.type) {
      return;
    }
    let scope = outer;
    const isFunction = [
      "FunctionDeclaration",
      "FunctionExpression",
      "ArrowFunctionExpression",
    ].includes(node.type);
    if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
      bind(node.id, outer);
    }
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
        bind(node.id, scope);
        node.params.forEach((parameter) => bind(parameter, scope));
      } else if (node.type === "CatchClause") {
        bind(node.param, scope);
      } else if (node.type === "ClassExpression" || node.type === "ClassDeclaration") {
        bind(node.id, scope);
      }
    }
    if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers) {
        scope.bindings.set(
          specifier.local.name,
          node.source.value === "node:vm" && specifier.imported?.name === "compileFunction",
        );
      }
    }
    if (node.type === "VariableDeclaration") {
      let owner = scope;
      while (node.kind === "var" && !owner.functionScope) {
        owner = owner.parent;
      }
      node.declarations.forEach((declaration) => bind(declaration.id, owner));
    }
    if (node.type === "CallExpression" && node.callee.type === "Identifier") {
      calls.push({ node, scope });
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
  // Resolve after collecting declarations, including bindings that shadow before initialization.
  return calls
    .filter(({ node, scope }) => {
      let owner = scope;
      while (owner && !owner.bindings.has(node.callee.name)) {
        owner = owner.parent;
      }
      return owner?.bindings.get(node.callee.name) === true;
    })
    .map(({ node }) => node);
}

function literalString(node) {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return undefined;
}

function staticProgramContract(node) {
  const [body, parameters] = node.arguments;
  if (
    node.arguments.length > 2 ||
    body?.type !== "TemplateLiteral" ||
    body.expressions.length !== 1 ||
    body.expressions[0].type !== "Identifier" ||
    body.quasis[0].value.cooked !== ""
  ) {
    return undefined;
  }
  const suffix = body.quasis[1].value.cooked;
  if (!suffix?.startsWith("\nreturn ")) {
    return undefined;
  }
  if (parameters && parameters.type !== "ArrayExpression") {
    return undefined;
  }
  const params = parameters ? parameters.elements.map(literalString) : [];
  return params.every((parameter) => parameter !== undefined)
    ? JSON.stringify([suffix, params])
    : undefined;
}

function staticProgramCalls(contents, parse) {
  if (!contents.includes("compileFunction")) {
    return [];
  }
  const ast = parse(contents, { ecmaVersion: "latest", sourceType: "module" });
  const calls = [];
  for (const node of importedCompileCalls(ast)) {
    const argument = node.arguments[0];
    // The return contract identifies a program across duplicated worker bundles.
    const signature =
      argument?.type === "TemplateLiteral" &&
      argument.expressions.every((expression) => expression.type === "Identifier")
        ? argument.quasis.reduce(
            (value, quasi, index) =>
              value + quasi.value.cooked + (argument.expressions[index]?.name ?? ""),
            "",
          )
        : undefined;
    const selection =
      argument?.type === "ConditionalExpression" &&
      argument.consequent.type === "Identifier" &&
      argument.alternate.type === "Identifier" &&
      argument.consequent.name === receiverPrograms[0] &&
      argument.alternate.name === receiverPrograms[1] &&
      node.arguments.length === 2 &&
      node.arguments[1].type === "ArrayExpression" &&
      node.arguments[1].elements.length === 1 &&
      node.arguments[1].elements[0]?.value === "require"
        ? argument
        : undefined;
    calls.push({ node, signature, selection, contract: staticProgramContract(node) });
  }
  return calls;
}

function receiverCaptureSource(contents, parse) {
  const marker = `//#region ${receiverOwner}\n`;
  const start = contents.indexOf(marker);
  const calls = staticProgramCalls(contents, parse).filter(({ selection }) => selection);
  if (start < 0 || calls.length !== 1 || calls[0].node.start < start) {
    throw new Error("Unsupported workspace rsync receiver capture layout");
  }
  const prefix = contents.slice(0, start);
  const declarations = new Set(
    parse(prefix, { ecmaVersion: "latest", sourceType: "module" })
      .body.filter((node) => node.type === "VariableDeclaration")
      .flatMap((node) => node.declarations.map((declaration) => declaration.id.name)),
  );
  if (!receiverPrograms.every((name) => declarations.has(name))) {
    throw new Error("Workspace rsync receiver programs must precede the entrypoint");
  }
  const callee = contents.slice(calls[0].node.callee.start, calls[0].node.callee.end);
  // Import only the bundled library prefix: the final region validates argv and starts rsync.
  return (
    prefix +
    receiverPrograms
      .map(
        (name) =>
          `globalThis.__openclawCaptureStaticFunction(${JSON.stringify(name)}, ${callee}, ${name}, ["require"]);`,
      )
      .join("\n")
  );
}

function protectBuiltinWrites(originalContents, parse) {
  let contents = originalContents;
  if (!/Error\.(?:stackTraceLimit|prepareStackTrace)/.test(contents)) {
    return { contents, count: 0 };
  }
  const ast = parse(contents, { ecmaVersion: "latest", sourceType: "module" });
  const pending = [[ast, undefined]];
  const edits = [];
  const isErrorProperty = (node) =>
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "Identifier" &&
    node.object.name === "Error" &&
    ["stackTraceLimit", "prepareStackTrace"].includes(node.property.name);
  while (pending.length) {
    const [node, parent] = pending.pop();
    if (!node || typeof node !== "object") {
      continue;
    }
    if (
      node.type === "AssignmentExpression" &&
      node.operator === "=" &&
      parent?.type === "ExpressionStatement" &&
      isErrorProperty(node.left)
    ) {
      edits.push({
        start: node.start,
        end: node.end,
        replacement: `Reflect.set(Error, ${JSON.stringify(node.left.property.name)}, ${contents.slice(node.right.start, node.right.end)})`,
      });
    }
    if (
      node.type === "UnaryExpression" &&
      node.operator === "delete" &&
      isErrorProperty(node.argument)
    ) {
      edits.push({
        start: node.start,
        end: node.end,
        replacement: `Reflect.deleteProperty(Error, ${JSON.stringify(node.argument.property.name)})`,
      });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        pending.push(...value.map((child) => [child, node]));
      } else if (value && typeof value === "object") {
        pending.push([value, node]);
      }
    }
  }
  for (const edit of edits.toSorted((left, right) => right.start - left.start)) {
    contents = contents.slice(0, edit.start) + edit.replacement + contents.slice(edit.end);
  }
  return { contents, count: edits.length };
}

/** Capture only fixed source programs, then emit their functions into the compiled graph. */
export async function createStandaloneCodegenAdapter({
  runtimeRoot,
  outputRoot,
  parse,
  aot = false,
  stateRoot = path.join(
    path.dirname(outputRoot),
    "state",
    `${path.basename(outputRoot)}-static-codegen`,
  ),
}) {
  const distRoot = path.join(runtimeRoot, "dist");
  const candidates = fs.readdirSync(distRoot).filter((entry) => entry.endsWith(".mjs"));
  const entries = new Set();
  for (const owner of programOwners) {
    const basename = path.basename(owner, ".ts");
    const prefix =
      basename === "workspace-path-exclusions" ? "workspace-manifest-" : `${basename}-`;
    const matches = candidates.filter(
      (entry) =>
        entry.startsWith(prefix) &&
        fs.readFileSync(path.join(distRoot, entry), "utf8").includes(`//#region ${owner}\n`),
    );
    if (matches.length !== 1) {
      throw new Error(
        `Expected one built static program owner for ${owner}, found ${matches.length}`,
      );
    }
    entries.add(path.join(distRoot, matches[0]));
  }
  const receiverEntry = path.join(distRoot, "worker/workspace-rsync-receiver.mjs");
  entries.add(receiverEntry);
  const captureRoot = path.join(outputRoot, "static-codegen");
  fs.mkdirSync(captureRoot, { recursive: true });
  const resultPath = path.join(captureRoot, "programs.json");
  const entryPath = path.join(captureRoot, "capture-entry.mjs");
  fs.writeFileSync(
    entryPath,
    `import fs from "node:fs";
const records = new Map();
globalThis.__openclawCaptureStaticFunction = (signature, compile, ...args) => {
  const [code, params = [], options] = args;
  if (typeof code !== "string" || options !== undefined) throw new Error("Unsupported static program options");
  const record = { signature, code, params };
  const previous = records.get(signature);
  if (previous && JSON.stringify(previous) !== JSON.stringify(record)) throw new Error("Ambiguous static program");
  records.set(signature, record);
  return compile(...args);
};
${[...entries].map((entry) => `await import(${JSON.stringify(entry)});`).join("\n")}
fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify([...records.values()], null, 2));
`,
  );
  const capture = await Bun.build({
    entrypoints: [entryPath],
    target: "bun",
    format: "esm",
    plugins: [
      {
        name: "openclaw-static-codegen-capture",
        setup(build) {
          build.onLoad({ filter: /\.[cm]?js$/ }, async ({ path: filename }) => {
            if (
              !filename.startsWith(runtimeRoot + path.sep) ||
              filename.includes("/node_modules/")
            ) {
              return undefined;
            }
            let contents = await fs.promises.readFile(filename, "utf8");
            if (filename === receiverEntry) {
              contents = receiverCaptureSource(contents, parse);
            }
            for (const { node, signature } of staticProgramCalls(contents, parse).toSorted(
              (left, right) => right.node.start - left.node.start,
            )) {
              if (!signature) {
                continue;
              }
              const callee = contents.slice(node.callee.start, node.callee.end);
              contents =
                contents.slice(0, node.callee.start) +
                `globalThis.__openclawCaptureStaticFunction.bind(null, ${JSON.stringify(signature)}, ${callee})` +
                contents.slice(node.callee.end);
            }
            return { contents, loader: "js", resolveDir: path.dirname(filename) };
          });
        },
      },
    ],
  });
  if (!capture.success) {
    throw new AggregateError(capture.logs, "Static program capture build failed");
  }
  const bundlePath = path.join(captureRoot, "capture-bundle.mjs");
  await Bun.write(bundlePath, capture.outputs[0]);
  fs.mkdirSync(path.join(stateRoot, "home"), { recursive: true });
  fs.mkdirSync(path.join(stateRoot, "tmp"), { recursive: true });
  const configPath = path.join(stateRoot, "openclaw.json");
  fs.writeFileSync(configPath, "{}\n");
  const run = spawnSync(process.execPath, [bundlePath], {
    cwd: runtimeRoot,
    env: {
      PATH: process.env.PATH,
      HOME: path.join(stateRoot, "home"),
      TMPDIR: path.join(stateRoot, "tmp"),
      OPENCLAW_STATE_DIR: stateRoot,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_NO_RESPAWN: "1",
      NODE_DISABLE_COMPILE_CACHE: "1",
    },
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(captureRoot, "capture.log"), run.stdout + run.stderr);
  if (run.status !== 0) {
    throw new Error(`Static program capture failed: ${run.error ?? run.stderr}`);
  }
  const programs = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  const expectedPrograms = programOwners.length + receiverPrograms.length;
  if (programs.length !== expectedPrograms) {
    throw new Error(`Expected ${expectedPrograms} static programs, captured ${programs.length}`);
  }
  const programModule = path.join(captureRoot, "fixed-programs.mjs");
  const transform = createStandaloneCodegenTransform({ programs, parse, aot, programModule });
  fs.writeFileSync(programModule, transform.moduleSource);
  fs.writeFileSync(programModule.replace(/\.mjs$/, ".d.mts"), transform.declarationSource);
  return { programs, ...transform };
}

/** Emit captured fixed functions; only the experimental AOT runtime needs intrinsic guards. */
export function createStandaloneCodegenTransform({ programs, parse, aot = false, programModule }) {
  const functions = new Map(
    programs.map(({ signature, code, params }) => {
      const expression = `(function(${params.join(", ")}) {\n${code}\n})`;
      // The same parser used by the main build checks the generated lexical function.
      parse(expression, { ecmaVersion: "latest", sourceType: "module" });
      return [signature, expression];
    }),
  );
  const bindings = new Map(programs.map(({ signature }, index) => [signature, `program${index}`]));
  const contracts = new Map();
  for (const { signature, params } of programs) {
    const separator = signature.indexOf("\nreturn ");
    if (separator < 0) {
      continue;
    }
    const contract = JSON.stringify([signature.slice(separator), params]);
    if (contracts.has(contract)) {
      throw new Error("Ambiguous static program return contract");
    }
    contracts.set(contract, signature);
  }
  const residuals = [];
  return {
    residuals,
    // Captured bodies are JavaScript programs, not unannotated TypeScript.
    // Factories retain compileFunction's fresh-function identity on every call.
    moduleSource: [...functions]
      .map(
        ([signature, expression]) =>
          `export function ${bindings.get(signature)}() { return ${expression}; }\n`,
      )
      .join(""),
    declarationSource: [...bindings.values()]
      .map(
        (name) =>
          `export function ${name}(): ReturnType<typeof import("node:vm").compileFunction>;\n`,
      )
      .join(""),
    transform({ contents: originalContents, filename, preserveTypes = false }) {
      let contents = originalContents;
      let typeboxAccelerationDisabled = false;
      const normalized = filename.replaceAll("\\", "/");
      if (
        aot &&
        normalized.includes("/typebox/") &&
        normalized.endsWith("/system/settings/settings.mjs")
      ) {
        contents += "\nSet({ useAcceleration: false });\n";
        typeboxAccelerationDisabled = true;
      }
      if (
        aot &&
        normalized.includes("/typebox/") &&
        normalized.endsWith("/system/environment/evaluate.mjs")
      ) {
        const signature = "export function CanEvaluate() {";
        if (!contents.includes(signature)) {
          throw new Error("Unsupported TypeBox CanEvaluate layout");
        }
        contents = contents.replace(
          signature,
          `${signature}\n    if (!Settings.Get().useAcceleration) return false;`,
        );
        typeboxAccelerationDisabled = true;
      }
      const guarded = aot ? protectBuiltinWrites(contents, parse) : { contents, count: 0 };
      contents = guarded.contents;
      const calls = staticProgramCalls(contents, parse);
      const imports = new Map();
      const fixedFunction = (signature) => {
        if (!functions.has(signature)) {
          return undefined;
        }
        if (!preserveTypes) {
          return functions.get(signature);
        }
        if (!programModule) {
          throw new Error("Typed static programs require their JavaScript module");
        }
        const exported = bindings.get(signature);
        if (!imports.has(exported)) {
          let local = `__openclawStandaloneFixed_${exported}`;
          while (originalContents.includes(local)) {
            local += "_";
          }
          imports.set(exported, local);
        }
        return `${imports.get(exported)}()`;
      };
      let count = 0;
      for (const { node, signature, selection, contract } of calls.toSorted(
        (left, right) => right.node.start - left.node.start,
      )) {
        const expression = selection
          ? `(${contents.slice(selection.test.start, selection.test.end)} ? ${fixedFunction(selection.consequent.name)} : ${fixedFunction(selection.alternate.name)})`
          : fixedFunction(functions.has(signature) ? signature : contracts.get(contract));
        if (!expression) {
          residuals.push({ filename, expression: contents.slice(node.start, node.end) });
          continue;
        }
        contents = contents.slice(0, node.start) + expression + contents.slice(node.end);
        count += 1;
      }
      if (imports.size) {
        const statement = `import { ${[...imports].map(([exported, local]) => `${exported} as ${local}`).join(", ")} } from ${JSON.stringify(programModule)};\n`;
        const start = contents.startsWith("#!") ? contents.indexOf("\n") + 1 : 0;
        contents = contents.slice(0, start) + statement + contents.slice(start);
      }
      return {
        contents,
        count,
        typeboxAccelerationDisabled,
        guardedIntrinsicWrites: guarded.count,
      };
    },
  };
}
