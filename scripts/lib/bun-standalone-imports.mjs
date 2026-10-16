import path from "node:path";

export function rewriteStandaloneImports({
  contents: originalContents,
  filename,
  runtimeRoot,
  embeddedPaths,
  moduleAliases,
  workerThreadsShim,
  parse,
}) {
  let contents = originalContents;
  const relative = path.relative(runtimeRoot, filename).split(path.sep).join("/");
  const generatedTargets = new Set([...Object.values(moduleAliases), workerThreadsShim]);
  // Rewrite syntax nodes only: loaders also contain quoted "import.meta.url" source.
  const ast = /import\.meta|import\s*\(|createRequire/.test(contents)
    ? parse(contents, {
        ecmaVersion: "latest",
        sourceType: "module",
        allowAwaitOutsideFunction: true,
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
  const pending = [ast];
  const edits = [];
  const physicalUrl = `(globalThis.__openclawStandaloneRootUrl + ${JSON.stringify(relative)})`;
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== "object") {
      continue;
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
        pending.push(...value);
      } else if (value && typeof value === "object") {
        pending.push(value);
      }
    }
  }
  for (const [start, end, replacement] of edits.toSorted((a, b) => b[0] - a[0])) {
    contents = contents.slice(0, start) + replacement + contents.slice(end);
  }
  return contents;
}
