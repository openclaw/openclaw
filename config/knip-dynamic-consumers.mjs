import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";

function relativeSpecifier(fromFile, targetFile) {
  const relative = path
    .relative(path.dirname(path.resolve(fromFile)), path.resolve(targetFile))
    .replaceAll("\\", "/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function importedNames(source, specifier) {
  return [...source.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*["']([^"'\r\n]+)["']/gu)].flatMap(
    ([, bindings, importedFrom]) =>
      importedFrom === specifier
        ? bindings
            .split(",")
            .map(
              (binding) =>
                binding
                  .trim()
                  .replace(/^type\s+/u, "")
                  .split(/\s+as\s+/u)[0],
            )
            .filter(Boolean)
        : [],
  );
}

function generatesRuntimeScriptAsset(entry) {
  // Keep this projection aligned with the generator's manifest-driven ASSETS loop.
  return entry.kind === "data-url" || ("materialize" in entry && entry.materialize);
}

export function collectRuntimeProcessManifestEntries(scriptEntrypoints, toolingEntrypoints) {
  const entries = new Set(Object.values(toolingEntrypoints));
  for (const entry of Object.values(scriptEntrypoints)) {
    if ("buildSource" in entry) {
      entries.add(entry.buildSource);
    }
    if (generatesRuntimeScriptAsset(entry)) {
      entries.add(entry.sourceModule);
    }
  }
  return [...entries];
}

function dynamicImportMemberNames(source, specifier) {
  return [
    ...new Set(
      [
        // Also matches a memoized load: `(await (module ??= import("..."))).name`.
        ...source.matchAll(
          /\(\s*await\s+(?:import\(\s*["']([^"'\r\n]+)["']\s*\)|\(\s*[A-Za-z_$][\w$]*\s*\?\?=\s*import\(\s*["']([^"'\r\n]+)["']\s*\)\s*\))\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/gu,
        ),
      ].flatMap(([, direct, memoized, name]) => ((direct ?? memoized) === specifier ? [name] : [])),
    ),
  ];
}

function lazyModuleNamespaces(source) {
  const assignment = source.match(
    /\bconst\s*\[([\s\S]*?)\]\s*=\s*await\s+Promise\.all\(\s*\[([\s\S]*?)\]\s*\)\s*;/u,
  );
  if (!assignment) {
    return new Map();
  }
  const bindings = assignment[1]
    .split(",")
    .map((binding) => binding.trim())
    .filter(Boolean);
  const specifiers = [...assignment[2].matchAll(/\bimport\(\s*["']([^"'\r\n]+)["']\s*\)/gu)].map(
    (match) => match[1],
  );
  if (bindings.length !== specifiers.length) {
    return new Map();
  }

  const bindingSpecifiers = new Map(bindings.map((binding, index) => [binding, specifiers[index]]));
  const returned = source.match(/\breturn\s*\{([^{}]+)\}\s*;/u)?.[1] ?? "";
  return new Map(
    returned
      .split(",")
      .map((property) =>
        property.trim().match(/^([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?$/u),
      )
      .filter(Boolean)
      .flatMap((match) => {
        const specifier = bindingSpecifiers.get(match[2] ?? match[1]);
        return specifier ? [[match[1], specifier]] : [];
      }),
  );
}

function loadedNamespaceMemberNames(source, loaderName) {
  const members = new Map();
  const escapedLoaderName = loaderName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const destructuring = new RegExp(
    `\\bconst\\s*\\{((?:[^{}]|\\{[^{}]*\\})*)\\}\\s*=\\s*await\\s+${escapedLoaderName}\\(\\s*\\)\\s*;`,
    "gu",
  );
  for (const match of source.matchAll(destructuring)) {
    for (const namespace of match[1].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*\{([^{}]+)\}/gu)) {
      const names = members.get(namespace[1]) ?? new Set();
      for (const binding of namespace[2].split(",")) {
        const name = binding.trim().split(/\s*:\s*/u)[0];
        if (/^[A-Za-z_$][\w$]*$/u.test(name)) {
          names.add(name);
        }
      }
      members.set(namespace[1], names);
    }
  }
  return members;
}

function lazyRuntimeModuleMemberEdges(source, consumerFile, targetSpecifier) {
  const specifiersByLoader = new Map(
    [
      ...source.matchAll(
        /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*createLazyRuntimeModule\(\s*\(\s*\)\s*=>\s*import\(\s*["']([^"'\r\n]+)["']\s*\)\s*,?\s*\)\s*;/gu,
      ),
    ]
      .filter((match) => match[2] === targetSpecifier)
      .map(([, loader, specifier]) => [loader, specifier]),
  );
  const edges = new Map();

  for (const match of source.matchAll(
    /\bconst\s*\{([^{}]+)\}\s*=\s*await\s+([A-Za-z_$][\w$]*)\(\s*\)\s*;/gu,
  )) {
    const specifier = specifiersByLoader.get(match[2]);
    if (!specifier) {
      continue;
    }
    const targetFile = path.resolve(path.dirname(consumerFile), specifier);
    const names = edges.get(targetFile) ?? new Set();
    for (const binding of match[1].split(",")) {
      const name = binding.trim().split(/\s*:\s*/u)[0];
      if (/^[A-Za-z_$][\w$]*$/u.test(name)) {
        names.add(name);
      }
    }
    if (names.size > 0) {
      edges.set(targetFile, names);
    }
  }

  const specifiersByBinder = new Map(
    [
      ...source.matchAll(
        /^[ \t]*const\s+([A-Za-z_$][\w$]*)\s*=\s*createLazyRuntimeMethodBinder\(\s*([A-Za-z_$][\w$]*)\s*\)\s*;/gmu,
      ),
    ].flatMap(([, binder, loader]) => {
      const specifier = specifiersByLoader.get(loader);
      return specifier ? [[binder, specifier]] : [];
    }),
  );
  // The binder forwards only the method selected from its supplying module.
  for (const match of source.matchAll(
    /^[ \t]*[A-Za-z_$][\w$]*:\s*([A-Za-z_$][\w$]*)\(\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>\s*\2\.([A-Za-z_$][\w$]*)\s*\)[ \t]*,?[ \t]*$/gmu,
  )) {
    const specifier = specifiersByBinder.get(match[1]);
    if (!specifier) {
      continue;
    }
    const targetFile = path.resolve(path.dirname(consumerFile), specifier);
    const names = edges.get(targetFile) ?? new Set();
    names.add(match[3]);
    edges.set(targetFile, names);
  }

  return edges;
}

function computedCheckoutNamespaceMemberEdges(source) {
  const sourceDirectories = new Map(
    [
      ...source.matchAll(
        /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*join\(\s*source\s*,\s*["']([^"'\r\n]+)["']\s*\)\s*;/gu,
      ),
    ]
      .filter((match) => !path.isAbsolute(match[2]) && !match[2].split(/[\\/]/u).includes(".."))
      .map(([, binding, directory]) => [binding, directory]),
  );
  const edges = new Map();

  for (const match of source.matchAll(
    /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+import\(\s*pathToFileURL\(\s*join\(\s*([A-Za-z_$][\w$]*)\s*,\s*["']([^"'\r\n]+)["']\s*\)\s*\)\s*\)\s*;/gu,
  )) {
    const [, namespace, directoryBinding, modulePath] = match;
    const directory = sourceDirectories.get(directoryBinding);
    if (!directory || path.isAbsolute(modulePath) || modulePath.split(/[\\/]/u).includes("..")) {
      continue;
    }

    const escapedNamespace = namespace.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const memberCall = new RegExp(
      `^[ \\t]*(?:(?:const|let)\\s+[A-Za-z_$][\\w$]*\\s*=\\s*)?${escapedNamespace}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`,
      "gmu",
    );
    const names = new Set([...source.matchAll(memberCall)].map((member) => member[1]));
    if (names.size > 0) {
      edges.set(path.resolve(directory, modulePath), names);
    }
  }

  return edges;
}

function emittedNamedImportEdges(source) {
  const transforms = new Map(
    [
      ...source.matchAll(/^def\s+([A-Za-z_]\w*)\(s\):\n([\s\S]*?)(?=^def\s+|^edit\(|^for\s+)/gmu),
    ].map((match) => [match[1], match[2]]),
  );
  const edges = new Map();
  for (const match of source.matchAll(
    /^edit\(\s*["']([^"'\r\n]+)["']\s*,\s*([A-Za-z_]\w*)\s*\)/gmu,
  )) {
    const body = transforms.get(match[2]);
    if (!body) {
      continue;
    }
    for (const imported of body.matchAll(
      /\bimport\s*\{([^}]+)\}\s*from\s*["']([^"'\r\n]+)["']/gu,
    )) {
      const targetFile = path.resolve(path.dirname(match[1]), imported[2]);
      const names = edges.get(targetFile) ?? new Set();
      for (const binding of imported[1].split(",")) {
        const name = binding.trim().split(/\s+as\s+/u)[0];
        if (name) {
          names.add(name);
        }
      }
      edges.set(targetFile, names);
    }
  }
  return edges;
}

function emittedFileNamedImportEdges(source) {
  const outputPaths = new Map(
    [
      ...source.matchAll(
        /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*path\.join\(\s*[A-Za-z_$][\w$]*\s*,\s*["']([^"'\r\n]+)["']\s*\)\s*;/gu,
      ),
    ].map(([, binding, outputPath]) => [binding, outputPath]),
  );
  const edges = new Map();
  for (const match of source.matchAll(
    /\b(?:fs\.)?writeFileSync\(\s*([A-Za-z_$][\w$]*)\s*,([\s\S]*?)\n\s*\);/gu,
  )) {
    const outputPath = outputPaths.get(match[1]);
    if (!outputPath) {
      continue;
    }
    for (const imported of match[2].matchAll(
      /\bimport\s*\{([^}]+)\}\s*from\s*["']([^"'\r\n]+)["']/gu,
    )) {
      const targetFile = path.resolve(path.dirname(outputPath), imported[2]);
      const names = edges.get(targetFile) ?? new Set();
      for (const binding of imported[1].split(",")) {
        const name = binding
          .trim()
          .replace(/^type\s+/u, "")
          .split(/\s+as\s+/u)[0];
        if (name) {
          names.add(name);
        }
      }
      edges.set(targetFile, names);
    }
  }
  return edges;
}

function emittedSelfNamedImportNames(source) {
  return [
    ...source.matchAll(
      /\bimport\s*\{([^}]+)\}\s*from\s*\$\{JSON\.stringify\(import\.meta\.url\)\};/gu,
    ),
  ].flatMap(([, bindings]) =>
    bindings
      .split(",")
      .map((binding) => binding.trim().split(/\s+as\s+/u)[0])
      .filter(Boolean),
  );
}

function prToolingNamedImportEdges(source) {
  // The wrapper supplies quoted argv to these stdin modules. Keep each
  // import and its path argument attached to the same live heredoc launch.
  const edges = new Map();
  for (const [, suppliedArgs, , body] of source.matchAll(
    /^[ \t]*node[ \t]+--input-type=module[ \t]+-[ \t]+((?:"[^"\r\n]*"[ \t]+)+)<<'(EOF_(?:TOOLING|CACHE_RECOVERY))'\r?\n([\s\S]*?)^\2$/gmu,
  )) {
    const args = [...suppliedArgs.matchAll(/"([^"\r\n]*)"/gu)].map((match) => match[1]);
    const hasUrlImport =
      /^[ \t]*import\s*\{\s*pathToFileURL\s*\}\s*from\s*["']node:url["']\s*;/mu.test(body);
    for (const match of body.matchAll(
      /^[ \t]*const\s*\{([^{}]+)\}\s*=\s*await\s+import\(\s*(\(\s*await\s+import\(["']node:url["']\)\s*\)\.)?pathToFileURL\(\s*process\.argv\[(\d+)\]\s*\)\s*\)\s*;/gmu,
    )) {
      if (!match[2] && !hasUrlImport) {
        continue;
      }
      const modulePath = args[Number(match[3]) - 2]?.match(
        /^\$(?:pr_bootstrap_root\/scripts|script_parent_dir)\/(pr-lib\/[^"\r\n]+\.mjs)$/u,
      )?.[1];
      if (!modulePath) {
        continue;
      }
      const target = path.resolve("scripts", modulePath);
      const names = edges.get(target) ?? new Set();
      for (const binding of match[1].split(",")) {
        const name = binding.trim().split(/\s*:\s*/u)[0];
        if (/^[A-Za-z_$][\w$]*$/u.test(name)) {
          names.add(name);
        }
      }
      edges.set(target, names);
    }
  }
  return edges;
}

function namedImport(names, targetFile, consumerFile, index) {
  const bindings = names.map(
    (name, bindingIndex) => `${name} as __dynamic${index}_${bindingIndex}`,
  );
  return `import { ${bindings.join(", ")} } from ${JSON.stringify(relativeSpecifier(consumerFile, targetFile))};`;
}

function optionalImportMemberEdges(source, consumerFile) {
  const edges = new Map();
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["typescript"],
    createImportExpressions: true,
  });
  // Link the optional prelaunch import to calls on that same retained binding.
  // Syntax and binding identity exclude types, text and shadowed namespaces.
  traverse(ast, {
    AssignmentExpression(assignment) {
      const { left, right, operator } = assignment.node;
      if (
        operator !== "=" ||
        left.type !== "Identifier" ||
        right.type !== "ConditionalExpression"
      ) {
        return;
      }
      const awaited = right.consequent;
      if (awaited.type !== "AwaitExpression" || awaited.argument.type !== "CallExpression") {
        return;
      }
      const caught = awaited.argument.callee;
      if (
        caught.type !== "MemberExpression" ||
        caught.computed ||
        caught.property.type !== "Identifier" ||
        caught.property.name !== "catch" ||
        caught.object.type !== "ImportExpression" ||
        caught.object.source.type !== "StringLiteral" ||
        !caught.object.source.value.startsWith(".")
      ) {
        return;
      }
      const binding = assignment.scope.getBinding(left.name);
      if (!binding) {
        return;
      }
      const targetFile = path.resolve(path.dirname(consumerFile), caught.object.source.value);
      const names = edges.get(targetFile) ?? new Set();
      for (const reference of binding.referencePaths) {
        const member = reference.parentPath;
        if (
          member.isMemberExpression() &&
          !member.node.computed &&
          member.node.object === reference.node &&
          member.node.property.type === "Identifier" &&
          member.parentPath.isCallExpression() &&
          member.parentPath.node.callee === member.node
        ) {
          names.add(member.node.property.name);
        }
      }
      if (names.size > 0) {
        edges.set(targetFile, names);
      }
    },
  });
  return edges;
}

function typedCheckoutImportEdges(source, consumerFile) {
  const edges = new Map();
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  traverse(ast, {
    VariableDeclarator(declaration) {
      const { id, init } = declaration.node;
      const query = id.typeAnnotation?.typeAnnotation;
      if (
        id.type !== "ObjectPattern" ||
        query?.type !== "TSTypeQuery" ||
        query.exprName.type !== "TSImportType" ||
        !query.exprName.source.value.startsWith(".") ||
        init?.type !== "AwaitExpression" ||
        init.argument.type !== "ImportExpression"
      ) {
        return;
      }
      // The type names the current checkout; the runtime selects the same module in a measured checkout.
      const runtime = init.argument.source;
      const selected = source
        .slice(runtime.start, runtime.end)
        .match(
          /^pathToFileURL\(\s*path\.join\(\s*[A-Za-z_$][\w$]*\s*,\s*(["'])([^"'\r\n]+)\1\s*\)\s*\)\.href$/u,
        )?.[2];
      const targetFile = path.resolve(path.dirname(consumerFile), query.exprName.source.value);
      const withoutExtension = (file) => file.replace(/\.[cm]?[jt]s$/u, "");
      if (!selected || withoutExtension(path.resolve(selected)) !== withoutExtension(targetFile)) {
        return;
      }
      const names = id.properties.flatMap((property) =>
        property.type === "ObjectProperty" &&
        !property.computed &&
        property.key.type === "Identifier" &&
        property.value.type === "Identifier" &&
        declaration.scope.getBinding(property.value.name)?.referenced
          ? [property.key.name]
          : [],
      );
      if (names.length) {
        edges.set(targetFile, names);
      }
    },
  });
  return edges;
}

function sideEffectImport(targetFile, consumerFile) {
  return `import ${JSON.stringify(relativeSpecifier(consumerFile, targetFile))};`;
}

function inlineNodeShellImportEdges(source, consumerFile) {
  const edges = new Map();
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const initializer = (reference) => {
    if (!reference?.isIdentifier()) {
      return undefined;
    }
    const binding = reference.scope.getBinding(reference.node.name);
    return binding?.constant && binding.path.isVariableDeclarator()
      ? binding.path.get("init")
      : undefined;
  };
  const isCallReference = (reference) =>
    reference.parentPath.isCallExpression() && reference.parentPath.node.callee === reference.node;
  traverse(ast, {
    CallExpression(launch) {
      if (!launch.get("callee").referencesImport("node:child_process", "spawnSync")) {
        return;
      }
      const [shell, argv, options] = launch.get("arguments");
      if (
        !shell?.isStringLiteral({ value: "bash" }) ||
        !argv?.isArrayExpression() ||
        !options?.isObjectExpression()
      ) {
        return;
      }
      const [flag, commandReference] = argv.get("elements");
      const cwd = options
        .get("properties")
        .find(
          (property) =>
            property.isObjectProperty() &&
            !property.node.computed &&
            property.get("key").isIdentifier({ name: "cwd" }),
        );
      const root = initializer(cwd?.get("value"));
      // Inline relative imports resolve from the child's tooling cwd, not from
      // this compiler or the release candidate being inspected.
      if (
        !flag?.isStringLiteral({ value: "-lc" }) ||
        argv.node.elements.length !== 2 ||
        !root?.isCallExpression() ||
        !root.get("callee").referencesImport("node:url", "fileURLToPath")
      ) {
        return;
      }
      const [url] = root.get("arguments");
      if (
        !url?.isNewExpression() ||
        !url.get("callee").isIdentifier({ name: "URL" }) ||
        url.scope.getBinding("URL") ||
        !url.get("arguments.0")?.isStringLiteral({ value: "../" }) ||
        !url.get("arguments.1")?.matchesPattern("import.meta.url")
      ) {
        return;
      }
      const command = initializer(commandReference);
      if (
        !command?.isCallExpression() ||
        !command.get("callee").isMemberExpression({ computed: false }) ||
        !command.get("callee.property").isIdentifier({ name: "join" }) ||
        !command.get("arguments.0")?.isStringLiteral({ value: " " }) ||
        !command.get("callee.object").isArrayExpression()
      ) {
        return;
      }
      const parts = command.get("callee.object.elements");
      const quoted = parts.at(-1);
      if (!parts.at(-2)?.isStringLiteral({ value: "exec" }) || !quoted?.isSpreadElement()) {
        return;
      }
      const mapped = quoted.get("argument");
      if (
        !mapped.isCallExpression() ||
        !mapped.get("callee").isMemberExpression({ computed: false }) ||
        !mapped.get("callee.property").isIdentifier({ name: "map" }) ||
        !mapped.get("callee.object").isArrayExpression() ||
        !mapped.get("arguments.0")?.isIdentifier({ name: "shellQuote" }) ||
        !mapped.scope.getBinding("shellQuote")?.path.isFunctionDeclaration()
      ) {
        return;
      }
      const args = mapped.get("callee.object.elements");
      if (
        !args[0]?.matchesPattern("process.execPath") ||
        mapped.scope.getBinding("process") ||
        !args.at(-2)?.isStringLiteral({ value: "-e" }) ||
        !args.some((arg) => arg.isStringLiteral({ value: "--input-type=module" }))
      ) {
        return;
      }
      const script = initializer(args.at(-1));
      const owner = launch.getFunctionParent();
      const ownerBinding = owner?.node.id && owner.parentPath.scope.getBinding(owner.node.id.name);
      if (!script?.isTemplateLiteral() || !ownerBinding?.referencePaths.some(isCallReference)) {
        return;
      }
      // Never evaluate producer expressions. Only literal module paths and
      // calls on their actual imported bindings contribute graph edges.
      const placeholder = "__dynamicInterpolation__";
      const inline = script.node.quasis.map((quasi) => quasi.value.cooked).join(placeholder);
      const child = parse(inline, { sourceType: "module", plugins: ["typescript"] });
      traverse(child, {
        ImportDeclaration(imported) {
          const specifier = imported.node.source.value;
          if (
            imported.node.importKind === "type" ||
            !specifier.startsWith(".") ||
            specifier.includes(placeholder)
          ) {
            return;
          }
          const names = imported.node.specifiers.flatMap((binding) =>
            binding.type === "ImportSpecifier" &&
            binding.importKind !== "type" &&
            binding.imported.type === "Identifier" &&
            imported.scope.getBinding(binding.local.name)?.referencePaths.some(isCallReference)
              ? [binding.imported.name]
              : [],
          );
          if (names.length) {
            const target = path.resolve(path.dirname(consumerFile), "..", specifier);
            edges.set(target, new Set([...(edges.get(target) ?? []), ...names]));
          }
        },
      });
    },
  });
  return edges;
}

/**
 * Project named imports emitted into child modules or selected through module
 * hooks. Each edge is derived from the live producer and consumer sources so
 * removing either side restores the unused-export finding.
 *
 * @param {string} source
 * @param {string} filePath
 * @param {Record<string, {kind: string, sourceModule: string, sourceBinding?: string, materialize?: boolean}>} [scriptEntrypoints]
 * @returns {string}
 */
export function compileDynamicConsumerEdges(source, filePath, scriptEntrypoints = {}) {
  const imports = [];
  // Empty recognizers must not create a module edge or consume an alias index.
  const addNamedImport = (names, targetFile) => {
    if (names.length > 0) {
      imports.push(namedImport(names, targetFile, filePath, imports.length));
    }
  };

  const tsdownPath = "tsdown.config.ts";
  const runtimeManifestSpecifier = "./src/infra/runtime-process-manifest.ts";
  const manifestNames = importedNames(
    fs.readFileSync(tsdownPath, "utf8"),
    runtimeManifestSpecifier,
  );
  addNamedImport(manifestNames, path.resolve(path.dirname(tsdownPath), runtimeManifestSpecifier));

  const benchmarkGeneratorPath = "scripts/lib/gateway-bench-worker-messages.ts";
  const benchmarkGenerator = fs.readFileSync(benchmarkGeneratorPath, "utf8");
  const generatedNames = emittedSelfNamedImportNames(benchmarkGenerator);
  addNamedImport(generatedNames, benchmarkGeneratorPath);

  const transportPath = "extensions/team-reports/src/report-fixture-transport.test-support.ts";
  const redirectedSpecifier = fs
    .readFileSync(transportPath, "utf8")
    .match(/\bspecifier\s*===\s*["']([^"'\r\n]+)["']/u)?.[1];
  const benchmarkPath = "extensions/team-reports/src/report-run.benchmark.test-support.ts";
  const fixtureSpecifier = fs
    .readFileSync(benchmarkPath, "utf8")
    .match(/\binstallReportFixtureTransport\(\s*["']([^"'\r\n]+)["']/u)?.[1];
  if (redirectedSpecifier && fixtureSpecifier) {
    const runtimeConsumer = fs.readFileSync("extensions/team-reports/src/sources/http.ts", "utf8");
    const names = importedNames(runtimeConsumer, redirectedSpecifier);
    addNamedImport(names, path.resolve(path.dirname(benchmarkPath), fixtureSpecifier));
  }

  const doctorConsumerPath = "src/commands/config-preflight-snapshot.ts";
  const doctorLegacySpecifier = "./doctor/shared/legacy-config-issues.js";
  const doctorLegacyNames = dynamicImportMemberNames(
    fs.readFileSync(doctorConsumerPath, "utf8"),
    doctorLegacySpecifier,
  );
  addNamedImport(
    doctorLegacyNames,
    path.resolve(path.dirname(doctorConsumerPath), doctorLegacySpecifier),
  );

  const mcpLoaderPath = "src/agents/agent-bundle-mcp-runtime-modules.ts";
  const mcpRuntimePath = "src/agents/agent-bundle-mcp-runtime.ts";
  const mcpNamespaces = lazyModuleNamespaces(fs.readFileSync(mcpLoaderPath, "utf8"));
  const mcpMembers = loadedNamespaceMemberNames(
    fs.readFileSync(mcpRuntimePath, "utf8"),
    "loadBundleMcpRuntimeModules",
  );
  for (const [namespace, specifier] of mcpNamespaces) {
    if (!specifier.startsWith(".")) {
      continue;
    }
    const names = [...(mcpMembers.get(namespace) ?? [])];
    addNamedImport(names, path.resolve(path.dirname(mcpLoaderPath), specifier));
  }

  const rowChurnInstrumenter = fs.readFileSync(
    "scripts/perf/session-row-churn-instrument.py",
    "utf8",
  );
  for (const [targetFile, names] of emittedNamedImportEdges(rowChurnInstrumenter)) {
    imports.push(namedImport([...names], targetFile, filePath, imports.length));
  }

  const runtimeAssetGeneratorPath = "scripts/generate-runtime-script-assets.mjs";
  const materializerSpecifier = "./src/infra/runtime-process-script-file.ts";
  const materializerNames = importedNames(
    fs.readFileSync(runtimeAssetGeneratorPath, "utf8"),
    materializerSpecifier,
  );
  addNamedImport(materializerNames, path.resolve(materializerSpecifier));

  const prepareHooksPath = "scripts/prepare-git-hooks.mjs";
  const bootstrapSpecifier = "../runtime-process-bootstrap.generated.mjs";
  const bootstrapNames = importedNames(
    fs.readFileSync(prepareHooksPath, "utf8"),
    bootstrapSpecifier,
  );
  addNamedImport(bootstrapNames, path.resolve(path.dirname(prepareHooksPath), bootstrapSpecifier));

  const workerArtifactsPath = "test/scripts/vitest-worker-artifacts.test.ts";
  const emittedWorkerEdges = emittedFileNamedImportEdges(
    fs.readFileSync(workerArtifactsPath, "utf8"),
  );
  const sqliteFacadePath = path.resolve("node-sqlite.mjs");
  const sqliteFacadeNames = [...(emittedWorkerEdges.get(sqliteFacadePath) ?? [])];
  addNamedImport(sqliteFacadeNames, sqliteFacadePath);

  for (const entry of Object.values(scriptEntrypoints)) {
    if (generatesRuntimeScriptAsset(entry) && entry.sourceBinding) {
      imports.push(
        namedImport(
          [entry.sourceBinding],
          path.resolve(entry.sourceModule),
          filePath,
          imports.length,
        ),
      );
    }
  }

  const archiveChurnPath = "scripts/perf/archive-worker-churn-measure.ts";
  const archiveChurnSource = fs.readFileSync(archiveChurnPath, "utf8");
  const archiveChurnLaunch =
    archiveChurnSource.match(
      /^if \(values\.allocations(?: \|\| values\.entry)?\) \{([\s\S]*?)^\}\nconst inspector = new Session\(\);/mu,
    )?.[1] ?? "";
  if (
    /^\s*const\s+preload\s*=\s*pathToFileURL\(\s*path\.join\(\s*path\.dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)\s*,\s*["']archive-worker-churn-preload\.mjs["']\s*\)\s*,\s*\)\.href\s*;/mu.test(
      archiveChurnLaunch,
    ) &&
    /^\s*workerThreads\.Worker\s*=\s*class\s+extends\s+NativeWorker\s*\{[\s\S]*?\bsuper\(\s*filename\s*,\s*target\s*\?\s*\{[\s\S]*?^\s*execArgv:\s*\[\s*\.\.\.\(\s*options\.execArgv\s*\?\?\s*process\.execArgv\s*\)\s*,\s*["']--import["']\s*,\s*preload\s*\]\s*,[\s\S]*?\}\s*:\s*options\s*,?\s*\)\s*;/mu.test(
      archiveChurnLaunch,
    )
  ) {
    imports.push(
      sideEffectImport(
        path.resolve(path.dirname(archiveChurnPath), "archive-worker-churn-preload.mjs"),
        filePath,
      ),
    );
  }

  const sessionCreatePath = "scripts/perf/session-create-measure.ts";
  const sessionCreateSource = fs.readFileSync(sessionCreatePath, "utf8");
  const sessionCreateChildArgs =
    sessionCreateSource.match(
      /\bgateway\s*=\s*spawn\(\s*process\.execPath\s*,\s*buildGatewayBenchChildArgs\(\s*entry\s*,\s*port\s*,\s*\[([\s\S]*?)^\s*\]\s*,?\s*\)\s*,\s*\{/mu,
    )?.[1] ?? "";
  if (
    /^\s*["']--import["']\s*,\s*\n\s*new URL\(\s*["']\.\/session-create-measure-loader\.mjs["']\s*,\s*import\.meta\.url\s*\)\.pathname\s*,/mu.test(
      sessionCreateChildArgs,
    )
  ) {
    imports.push(
      sideEffectImport(
        path.resolve(path.dirname(sessionCreatePath), "session-create-measure-loader.mjs"),
        filePath,
      ),
    );
  }

  const trajectoryFlushPreloadPath = "scripts/perf/trajectory-flush-preload.mts";
  const trajectoryFlushNames = emittedSelfNamedImportNames(
    fs.readFileSync(trajectoryFlushPreloadPath, "utf8"),
  );
  addNamedImport(trajectoryFlushNames, trajectoryFlushPreloadPath);

  const poolLifecyclePath = "scripts/perf/pg-pool-lifecycle.mts";
  const poolFixtureSpecifier = fs
    .readFileSync(poolLifecyclePath, "utf8")
    .match(
      /\bbroker\.open(?:<[^>]+>)?\(\s*\{\s*moduleUrl:\s*new URL\(\s*["']([^"'\r\n]+)["']\s*,\s*self\s*\)/u,
    )?.[1];
  const creationFactory = fs
    .readFileSync("src/infra/sqlite-store.worker.ts", "utf8")
    .match(
      /\bconst factoryName\s*=\s*request\.existingIdentity\s*\?\s*["'][^"'\r\n]+["']\s*:\s*["']([^"'\r\n]+)["']/u,
    )?.[1];
  if (poolFixtureSpecifier && creationFactory) {
    imports.push(
      namedImport(
        [creationFactory],
        path.resolve(path.dirname(poolLifecyclePath), poolFixtureSpecifier),
        filePath,
        "PgPool",
      ),
    );
  }

  const publishedUpgradeScenarioPath =
    ".agents/skills/telegram-e2e-userbot/scripts/published-upgrade-scenario.mjs";
  const publishedUpgradeScenario = fs.readFileSync(publishedUpgradeScenarioPath, "utf8");
  for (const [targetFile, names] of computedCheckoutNamespaceMemberEdges(
    publishedUpgradeScenario,
  )) {
    imports.push(namedImport([...names], targetFile, filePath, imports.length));
  }

  const lazyRuntimeConsumers = [
    ["extensions/codex/src/native-plugin-tool.ts", "./app-server/binding-connection.js"],
    ["extensions/codex/src/native-thread-tool.ts", "./app-server/binding-connection.js"],
    [
      "extensions/codex/src/session-catalog-list-operation.ts",
      "./session-catalog-node-adoption.js",
    ],
    ["extensions/codex/src/session-catalog-control.ts", "./app-server/shared-client.js"],
    ["src/plugins/runtime/index.ts", "../../tts/tts.js"],
    ["src/plugins/runtime/index.ts", "../../tts/tts-request.js"],
  ];
  const lazyRuntimeEdges = new Map();
  for (const [consumerPath, targetSpecifier] of lazyRuntimeConsumers) {
    const consumerSource = fs.readFileSync(consumerPath, "utf8");
    for (const [targetFile, memberNames] of lazyRuntimeModuleMemberEdges(
      consumerSource,
      consumerPath,
      targetSpecifier,
    )) {
      const names = lazyRuntimeEdges.get(targetFile) ?? new Set();
      for (const name of memberNames) {
        names.add(name);
      }
      lazyRuntimeEdges.set(targetFile, names);
    }
  }
  for (const [targetFile, names] of lazyRuntimeEdges) {
    imports.push(namedImport([...names], targetFile, filePath, imports.length));
  }

  const broadcastPath = "scripts/perf/transcript-broadcast-measure.ts";
  const broadcastSource = fs.readFileSync(broadcastPath, "utf8");
  for (const [, bindings, specifier] of broadcastSource.matchAll(
    /(?:\\n|\b)import\s*\{([^}]+)\}\s*from\s*\$\{JSON\.stringify\(new URL\("([^"\r\n]+)", import\.meta\.url\)\.href\)\}/gu,
  )) {
    addNamedImport(
      importedNames(`import {${bindings}} from "${specifier}"`, specifier),
      path.resolve(path.dirname(broadcastPath), specifier),
    );
  }

  const telemetryTestPath = "test/scripts/team-shape-stress.test.ts";
  const telemetryTestSource = fs.readFileSync(telemetryTestPath, "utf8");
  const telemetryUrls = new Map(
    [
      ...telemetryTestSource.matchAll(
        /^[ \t]*const\s+([A-Za-z_$][\w$]*)\s*=\s*new URL\(\s*["']([^"'\r\n]+)["']\s*,\s*import\.meta\.url\s*,?\s*\)/gmu,
      ),
    ].map(([, binding, specifier]) => [binding, specifier]),
  );
  // The native child consumes the helper through an interpolated file URL.
  for (const [, bindings, binding] of telemetryTestSource.matchAll(
    /^[ \t]*const\s*\{([^}]+)\}\s*=\s*await\s+import\(\s*\$\{JSON\.stringify\(([A-Za-z_$][\w$]*)\.href\)\}\s*\)/gmu,
  )) {
    const specifier = telemetryUrls.get(binding);
    if (specifier) {
      addNamedImport(
        importedNames(`import {${bindings}} from "${specifier}"`, specifier),
        path.resolve(path.dirname(telemetryTestPath), specifier),
      );
    }
  }

  for (const [targetFile, names] of prToolingNamedImportEdges(
    fs.readFileSync("scripts/pr", "utf8"),
  )) {
    addNamedImport([...names], targetFile);
  }

  const anchorPath = "src/process/supervisor/service-child-group-anchor.ts";
  for (const [targetFile, names] of optionalImportMemberEdges(
    fs.readFileSync(anchorPath, "utf8"),
    anchorPath,
  )) {
    addNamedImport([...names], targetFile);
  }

  const generationBenchmarkPath = "scripts/perf/update-doctor-generation-measure.ts";
  for (const [targetFile, names] of typedCheckoutImportEdges(
    fs.readFileSync(generationBenchmarkPath, "utf8"),
    generationBenchmarkPath,
  )) {
    addNamedImport(names, targetFile);
  }

  const releaseChecklist = "scripts/release-candidate-checklist.mts";
  for (const [target, names] of inlineNodeShellImportEdges(
    fs.readFileSync(releaseChecklist, "utf8"),
    releaseChecklist,
  )) {
    addNamedImport([...names], target);
  }

  return `${source}\n${imports.join("\n")}`;
}
