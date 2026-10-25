import path from "node:path";
import { createStandaloneLexicalBindings } from "./bun-standalone-bindings.mjs";

const unrenderedModuleUrlMarker = "OPENCLAW_UNRENDERED_MODULE_URL:";

export function createUnrenderedModuleUrlBootstrap() {
  return `globalThis.__openclawStandaloneUnrenderedModuleUrl = (marker) => { throw new Error(marker); };`;
}

export function assertNoUnrenderedModuleUrls(contents, filename) {
  if (contents.includes(unrenderedModuleUrlMarker)) {
    throw new Error(`An unrendered source module URL survived bundling in ${filename}`);
  }
}

/**
 * @param {{
 *   contents: string,
 *   filename: string,
 *   physicalFilename?: string,
 *   resolveModuleUrl?: () => string | null | undefined,
 *   runtimeRoot: string,
 *   embeddedPaths: Record<string, string>,
 *   moduleAliases: Record<string, string>,
 *   workerThreadsShim: string,
 *   parse: import("./bun-standalone-parser.mjs").StandaloneParser,
 *   sourceType?: "module" | "script",
 *   preserveTypes?: boolean
 * }} options
 */
export function rewriteStandaloneImports({
  contents: originalContents,
  filename,
  physicalFilename = filename,
  resolveModuleUrl,
  runtimeRoot,
  embeddedPaths,
  moduleAliases,
  workerThreadsShim,
  parse,
  sourceType = "module",
  preserveTypes = false,
}) {
  let contents = originalContents;
  const relative = path.relative(runtimeRoot, physicalFilename).split(path.sep).join("/");
  const generatedTargets = new Set([...Object.values(moduleAliases), workerThreadsShim]);
  const resolverNames = ["openclaw-plugin-sdk-alias", "openclaw-plugin-source-capture"];
  const pluginResolvers = new Set(resolverNames.filter((name) => contents.includes(name)));
  const staticString = (node) =>
    node?.type === "Literal"
      ? node.value
      : node?.type === "TemplateLiteral" && node.expressions.length === 0
        ? node.quasis[0].value.cooked
        : undefined;
  // Rewrite syntax nodes only: loaders also contain quoted "import.meta.url" source.
  const ast =
    pluginResolvers.size || /import\.meta|import\s*\(|createRequire|_resolveFilename/.test(contents)
      ? parse(contents, {
          ecmaVersion: "latest",
          sourceType,
          allowImportExportEverywhere: true,
          allowAwaitOutsideFunction: true,
          allowReturnOutsideFunction: sourceType === "script",
        })
      : undefined;
  const requireFactories = new Set(
    (ast?.body ?? []).flatMap((node) =>
      node.type === "ImportDeclaration" && node.source.value === "node:module"
        ? node.specifiers
            .filter((specifier) => specifier.imported?.name === "createRequire")
            .map((specifier) => specifier.local.name)
        : [],
    ),
  );
  const nativeResolverKeys = new Set(
    (ast?.body ?? []).flatMap((node) =>
      node.type === "VariableDeclaration"
        ? node.declarations
            .filter((declaration) => staticString(declaration.init) === "_resolveFilename")
            .map((declaration) => declaration.id.name)
        : [],
    ),
  );
  let bindings;
  const pending = [{ node: ast, owner: undefined }];
  const edits = [];
  const physicalUrl = `(globalThis.__openclawStandaloneRootUrl + ${JSON.stringify(relative)})`;
  let moduleUrlExpression;
  // Most modules need no emitted URL metadata. Resolve only actual import.meta syntax.
  const importMetaUrl = () => {
    if (moduleUrlExpression === undefined) {
      const resolved = resolveModuleUrl?.();
      if (resolved === null) {
        // The original URL read was pure. Keep it removable until the bundler
        // proves it is unused; any surviving marker rejects the build.
        moduleUrlExpression = `/* @__PURE__ */ globalThis.__openclawStandaloneUnrenderedModuleUrl(${JSON.stringify(unrenderedModuleUrlMarker + relative)})`;
      } else {
        const moduleUrl = resolved ?? physicalFilename;
        moduleUrlExpression = `(globalThis.__openclawStandaloneRootUrl + ${JSON.stringify(path.relative(runtimeRoot, moduleUrl).split(path.sep).join("/"))})`;
      }
    }
    return moduleUrlExpression;
  };
  const resolverOwnerType = (node) => {
    if (node.type === "Identifier") {
      return `typeof ${node.name}`;
    }
    if (node.type === "MemberExpression" && !node.optional) {
      const key = node.computed ? staticString(node.property) : node.property.name;
      if (typeof key === "string") {
        return `(${resolverOwnerType(node.object)})[${JSON.stringify(key)}]`;
      }
    }
    throw new Error("Unsupported typed standalone resolver owner");
  };
  while (pending.length) {
    const current = pending.pop();
    const node = current.node;
    if (!node || typeof node !== "object") {
      continue;
    }
    let owner = current.owner;
    if (
      node.type === "AssignmentExpression" &&
      node.operator === "=" &&
      node.left.type === "MemberExpression" &&
      (staticString(node.left.property) === "_resolveFilename" ||
        node.left.property.name === "_resolveFilename" ||
        nativeResolverKeys.has(node.left.property.name)) &&
      ["ArrowFunctionExpression", "FunctionExpression"].includes(node.right.type)
    ) {
      // CJS aliases bypass Bun's public hook. Map the loader handoff while
      // admission and SDK discovery continue to use physical filenames.
      const wrapper = preserveTypes
        ? `((resolve: NonNullable<(${resolverOwnerType(node.left.object)})["_resolveFilename"]>) => function (this: ThisParameterType<typeof resolve>, ...args: Parameters<typeof resolve>): ReturnType<typeof resolve> { const target = resolve.apply(this, args); return globalThis.__openclawStandaloneEmbeddedPath(target) ?? target; })(`
        : "((resolve) => function (...args) { const target = resolve.apply(this, args); return globalThis.__openclawStandaloneEmbeddedPath(target) ?? target; })(";
      edits.push([node.right.start, node.right.start, wrapper]);
      edits.push([node.right.end, node.right.end, ")"]);
    }
    if (node.type === "ObjectExpression") {
      const name = staticString(
        node.properties.find((property) => property.key?.name === "name")?.value,
      );
      if (resolverNames.includes(name)) {
        owner = name;
      }
    }
    if (resolverNames.includes(owner) && node.type === "ObjectExpression") {
      const target = node.properties.find((property) => property.key?.name === "path");
      const namespace = node.properties.find((property) => property.key?.name === "namespace");
      if (target?.value?.type === "Identifier" && staticString(namespace?.value) === "file") {
        // Bun does not resolve a hook's returned filename through subsequent hooks.
        edits.push([
          target.value.start,
          target.value.end,
          `(globalThis.__openclawStandaloneEmbeddedPath(${contents.slice(target.value.start, target.value.end)}) ?? ${contents.slice(target.value.start, target.value.end)})`,
        ]);
        pluginResolvers.delete(owner);
      }
    }
    if (
      node.type === "MemberExpression" &&
      !node.computed &&
      node.object?.type === "MetaProperty" &&
      node.object.meta.name === "import"
    ) {
      if (node.property.name === "url") {
        edits.push([node.start, node.end, importMetaUrl()]);
        continue;
      }
      if (node.property.name === "resolve") {
        edits.push([
          node.start,
          node.end,
          `globalThis.__openclawStandaloneResolve.bind(null, ${importMetaUrl()})`,
        ]);
        continue;
      }
    }
    if (
      node.type === "ImportExpression" &&
      (node.source.type !== "Literal" ||
        generatedTargets.has(node.source.value) ||
        String(node.source.value).endsWith(".cjs"))
    ) {
      edits.push([
        node.start,
        node.source.start,
        `globalThis.__openclawStandaloneImport(${physicalUrl}, `,
      ]);
      if (preserveTypes) {
        // The thunk preserves TypeScript's original import result type. The loader
        // never invokes it, so computed specifiers still evaluate exactly once.
        const tail = contents.slice(node.source.end, node.end - 1).trim();
        const hasOptions = tail.replace(/^,|,$/g, "").trim().length > 0;
        const separator = tail.endsWith(",") ? " " : ", ";
        // Native checking follows literal const types; expose the same edge to
        // discovery without replacing the runtime expression or its evaluation.
        const specifier =
          node.source.type === "Identifier"
            ? (bindings ??= createStandaloneLexicalBindings(ast)).constantString(node.source)
            : undefined;
        const witness =
          specifier === undefined
            ? contents.slice(node.start, node.end)
            : contents.slice(node.start, node.source.start) +
              JSON.stringify(specifier) +
              contents.slice(node.source.end, node.end);
        edits.push([
          node.end - 1,
          node.end - 1,
          `${separator}${hasOptions ? "" : "undefined, "}() => ${witness}`,
        ]);
      }
      if (generatedTargets.has(node.source.value)) {
        const entry = path.relative(runtimeRoot, node.source.value).split(path.sep).join("/");
        const embedded = embeddedPaths[entry];
        if (!embedded) {
          throw new Error(`Missing embedded standalone import: ${entry}`);
        }
        edits.push([node.source.start, node.source.end, JSON.stringify(embedded)]);
      }
    }
    if (
      node.type === "CallExpression" &&
      (requireFactories.has(node.callee?.name) ||
        (node.callee?.type === "MemberExpression" &&
          node.callee.property?.name === "createRequire" &&
          node.callee.object?.type === "CallExpression" &&
          node.callee.object.callee?.property?.name === "getBuiltinModule"))
    ) {
      const name = contents.slice(node.callee.start, node.callee.end);
      edits.push([
        node.callee.start,
        node.callee.end,
        `globalThis.__openclawStandaloneCreateRequire.bind(null, ${name})`,
      ]);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        pending.push(...value.map((child) => ({ node: child, owner })));
      } else if (value && typeof value === "object") {
        pending.push({ node: value, owner });
      }
    }
  }
  if (pluginResolvers.size) {
    throw new Error(`Unsupported standalone plugin resolver: ${[...pluginResolvers].join(", ")}`);
  }
  for (const [start, end, replacement] of edits.toSorted((a, b) => b[0] - a[0])) {
    contents = contents.slice(0, start) + replacement + contents.slice(end);
  }
  return contents;
}
