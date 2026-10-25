import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {{path: string, text: () => Promise<string>}} StandaloneBundleArtifact
 * @typedef {{entryPoint?: string, inputs: Record<string, unknown>, imports: {path: string, external?: boolean}[]}} StandaloneBundleModule
 * @typedef {{inputs: Record<string, unknown>, outputs: Record<string, StandaloneBundleModule>}} StandaloneBundleMetafile
 * @typedef {{success: boolean, outputs: StandaloneBundleArtifact[], metafile: StandaloneBundleMetafile}} StandaloneBundleResult
 */

/**
 * Bundle from the staging root so Bun's chunk identities use relocatable paths.
 * The dedicated builder keeps this cwd for consumers of relative metafile inputs.
 * @template {{root: string, outdir: string, entrypoints: string[]}} Options
 * @template {StandaloneBundleResult} Result
 * @param {Options} options
 * @param {(options: Options) => Promise<Result>} build
 * @param {import("./bun-standalone-parser.mjs").StandaloneParser} parse
 */
export async function bundleStandaloneModules(options, build, parse) {
  process.chdir(options.root);
  const result = await build(options);
  if (!result.success) {
    return result;
  }
  const outputs = new Map(result.outputs.map((output) => [output.path, output]));
  const metadata = new Map(
    Object.entries(result.metafile.outputs).map(([name, output]) => [
      path.resolve(options.outdir, name),
      { name, output },
    ]),
  );
  const declared = new Set(options.entrypoints.map((entry) => path.resolve(entry)));
  const entryOutputs = [...metadata]
    .filter(
      ([, { output }]) =>
        output.entryPoint && declared.has(path.resolve(options.root, output.entryPoint)),
    )
    .map(([filename]) => filename);
  const retained = new Set();
  const edges = new Map();
  const pending = [...entryOutputs];
  const staticString = (node) =>
    node?.type === "Literal"
      ? node.value
      : node?.type === "TemplateLiteral" && node.expressions.length === 0
        ? node.quasis[0].value.cooked
        : undefined;
  while (pending.length) {
    const filename = pending.pop();
    if (retained.has(filename)) {
      continue;
    }
    retained.add(filename);
    const artifact = outputs.get(filename);
    if (!artifact) {
      throw new Error(`Standalone bundle omitted declared output: ${filename}`);
    }
    const references = new Set();
    edges.set(filename, references);
    if (!/\.[cm]?js$/.test(filename)) {
      continue;
    }
    // Bun may retain dynamic-entry metadata after removing the importing code.
    // Only emitted syntax can make that chunk part of the executable graph.
    const ast = parse(await artifact.text(), { ecmaVersion: "latest", sourceType: "module" });
    const nodes = [ast];
    while (nodes.length) {
      const node = nodes.pop();
      if (!node || typeof node !== "object") {
        continue;
      }
      const specifier = [
        "ImportDeclaration",
        "ExportNamedDeclaration",
        "ExportAllDeclaration",
        "ImportExpression",
      ].includes(node.type)
        ? staticString(node.source)
        : node.type === "CallExpression" &&
            (node.callee?.name === "require" ||
              (node.callee?.type === "MemberExpression" &&
                node.callee.property?.name === "require"))
          ? staticString(node.arguments[0])
          : undefined;
      if (typeof specifier === "string" && specifier.startsWith(".")) {
        const target = path.resolve(path.dirname(filename), specifier);
        if (outputs.has(target)) {
          references.add(target);
          pending.push(target);
        }
      }
      // File-loader assets are emitted as URL strings rather than import statements.
      const literal = staticString(node);
      if (typeof literal === "string" && literal.startsWith(".")) {
        const target = path.resolve(path.dirname(filename), literal);
        if (outputs.has(target) && !/\.[cm]?js$/.test(target)) {
          references.add(target);
          pending.push(target);
        }
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          nodes.push(...value);
        } else if (value && typeof value === "object") {
          nodes.push(value);
        }
      }
    }
  }
  const retainedInputs = new Set();
  const retainedMetadata = {};
  for (const filename of retained) {
    const module = metadata.get(filename);
    // File-loader assets have artifacts but no module records in Bun's metafile.
    if (!module) {
      continue;
    }
    const { name, output } = module;
    Object.keys(output.inputs ?? {}).forEach((input) => retainedInputs.add(input));
    retainedMetadata[name] = {
      ...output,
      imports: output.imports.filter((entry) => {
        const target = path.resolve(options.outdir, entry.path);
        return !outputs.has(target) || edges.get(filename).has(target);
      }),
    };
  }
  for (const filename of outputs.keys()) {
    if (!retained.has(filename)) {
      fs.unlinkSync(filename);
    }
  }
  const runtimeMetafile = {
    ...result.metafile,
    inputs: Object.fromEntries(
      Object.entries(result.metafile.inputs).filter(([input]) => retainedInputs.has(input)),
    ),
    outputs: retainedMetadata,
  };
  return {
    ...result,
    outputs: result.outputs.filter((output) => retained.has(output.path)),
    entryOutputs,
    runtimeMetafile,
  };
}
