import path from "node:path";

export function rewriteStandaloneImports({
  contents: originalContents,
  filename,
  runtimeRoot,
  embeddedPaths,
  moduleAliases,
  workerThreadsShim,
  parse,
  sourceType = "module",
}) {
  let contents = originalContents;
  const relative = path.relative(runtimeRoot, filename).split(path.sep).join("/");
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
  const pending = [{ node: ast, owner: undefined }];
  const edits = [];
  const physicalUrl = `(globalThis.__openclawStandaloneRootUrl + ${JSON.stringify(relative)})`;
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
      edits.push([
        node.right.start,
        node.right.start,
        "((resolve) => function (...args) { const target = resolve.apply(this, args); return globalThis.__openclawStandaloneEmbeddedPath(target) ?? target; })(",
      ]);
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
        edits.push([node.start, node.end, physicalUrl]);
        continue;
      }
      if (node.property.name === "resolve") {
        edits.push([
          node.start,
          node.end,
          `globalThis.__openclawStandaloneResolve.bind(null, ${physicalUrl})`,
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
