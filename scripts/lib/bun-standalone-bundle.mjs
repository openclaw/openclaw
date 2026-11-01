import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {{path: string, text: () => Promise<string>}} StandaloneBundleArtifact
 * @typedef {{entryPoint?: string, inputs: Record<string, unknown>, imports: {path: string, external?: boolean}[]}} StandaloneBundleModule
 * @typedef {{inputs: Record<string, unknown>, outputs: Record<string, StandaloneBundleModule>}} StandaloneBundleMetafile
 * @typedef {{success: boolean, outputs: StandaloneBundleArtifact[], metafile: StandaloneBundleMetafile}} StandaloneBundleResult
 */

/**
 * Keep source discovery and its original metafile separate from final linking.
 * @template {{root: string, outdir: string, entrypoints: string[]}} Options
 * @template {StandaloneBundleResult} Result
 * @param {Options} options
 * @param {(options: Options) => Promise<Result>} build
 */
export async function bundleStandaloneModules(options, build) {
  process.chdir(options.root);
  const result = await build(options);
  const declared = new Set(options.entrypoints.map((entry) => path.resolve(entry)));
  const entryOutputs = Object.entries(result.metafile?.outputs ?? {})
    .filter(
      ([, output]) =>
        output.entryPoint && declared.has(path.resolve(options.root, output.entryPoint)),
    )
    .map(([name]) => path.resolve(options.outdir, name));
  return { ...result, entryOutputs };
}

/**
 * Source AOT needs a final link to remove exports used only by an eliminated
 * dynamic-import facade before validating source-module URLs. Emitted JS keeps
 * its first bundle and resource ownership without expanding that graph again.
 * @template {{root: string, outdir: string, entrypoints: string[]}} Options
 * @template {StandaloneBundleResult & {entryOutputs: string[]}} Result
 * @param {Options} options
 * @param {Result} result
 * @param {(options: Options) => Promise<StandaloneBundleResult>} build
 * @param {import("./bun-standalone-parser.mjs").StandaloneParser} parse
 * @param {{sourceAot: boolean}} mode
 */
export async function finalizeStandaloneModules(options, result, build, parse, { sourceAot }) {
  if (!sourceAot) {
    return { ...result, runtimeMetafile: result.metafile };
  }
  const inputRoot = `${options.outdir}-input`;
  const artifacts = new Map(result.outputs.map((output) => [output.path, output]));
  const roots = new Set(result.entryOutputs);
  const pending = [...roots];
  const visited = new Set();
  const moduleEdits = new Map();
  const requireTargets = new Map();
  const assetPaths = new Set();
  const staticString = (node) =>
    node?.type === "Literal"
      ? node.value
      : node?.type === "TemplateLiteral" && node.expressions.length === 0
        ? node.quasis[0].value.cooked
        : undefined;
  const inputPath = (filename) => path.join(inputRoot, path.relative(options.outdir, filename));
  // Only opaque import.meta.require edges need extra roots. Bun owns all output
  // elimination; this walk never chooses which artifacts or exports to delete.
  while (pending.length) {
    const filename = pending.pop();
    if (visited.has(filename)) {
      continue;
    }
    visited.add(filename);
    const artifact = artifacts.get(filename);
    if (!artifact || !/\.[cm]?js$/.test(filename)) {
      continue;
    }
    const contents = await artifact.text();
    const nodes = [parse(contents, { ecmaVersion: "latest", sourceType: "module" })];
    const edits = [];
    const assetImports = [];
    let assetIndex = 0;
    while (nodes.length) {
      const node = nodes.pop();
      if (!node || typeof node !== "object") {
        continue;
      }
      const opaqueRequire =
        node.type === "CallExpression" &&
        node.callee?.type === "MemberExpression" &&
        node.callee.property?.name === "require" &&
        node.callee.object?.type === "MetaProperty";
      const argument = opaqueRequire ? node.arguments[0] : node.source;
      const specifier = staticString(argument);
      if (typeof specifier === "string" && specifier.startsWith(".")) {
        const target = path.resolve(path.dirname(filename), specifier);
        if (artifacts.has(target)) {
          pending.push(target);
          if (opaqueRequire) {
            roots.add(target);
            const reference = `openclaw:standalone-require/${path.relative(options.outdir, target).split(path.sep).join("/")}`;
            requireTargets.set(reference, inputPath(target));
            edits.push([argument.start, argument.end, JSON.stringify(reference)]);
          }
        }
      }
      // Recover file-loader edges so Bun rebases URLs when shared code moves.
      const literal = staticString(node);
      if (typeof literal === "string" && literal.startsWith(".")) {
        const target = path.resolve(path.dirname(filename), literal);
        if (artifacts.has(target) && !/\.[cm]?js$/.test(target)) {
          let name;
          do {
            name = `__openclawStandaloneAsset${assetIndex++}`;
          } while (contents.includes(name));
          assetPaths.add(inputPath(target));
          assetImports.push(`import ${name} from ${JSON.stringify(literal)};`);
          edits.push([node.start, node.end, name]);
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
    if (assetImports.length) {
      const shebangEnd = contents.startsWith("#!") ? contents.indexOf("\n") + 1 : 0;
      edits.push([shebangEnd, shebangEnd, assetImports.join("\n") + "\n"]);
    }
    if (edits.length) {
      moduleEdits.set(filename, edits);
    }
  }
  fs.renameSync(options.outdir, inputRoot);
  for (const [filename, edits] of moduleEdits) {
    const input = inputPath(filename);
    let contents = fs.readFileSync(input, "utf8");
    for (const [start, end, replacement] of edits.toSorted((a, b) => b[0] - a[0])) {
      contents = contents.slice(0, start) + replacement + contents.slice(end);
    }
    fs.writeFileSync(input, contents);
  }
  process.chdir(inputRoot);
  const linked = await build({
    ...options,
    root: inputRoot,
    entrypoints: [...roots].map(inputPath),
    // Source transforms have already run; applying them to emitted JS changes ownership.
    plugins: [
      {
        name: "standalone-linked-assets",
        setup(linker) {
          linker.onLoad({ filter: /.*/ }, ({ path: filename }) =>
            assetPaths.has(filename)
              ? { contents: fs.readFileSync(filename), loader: "file" }
              : undefined,
          );
        },
      },
    ],
    banner: undefined,
    footer: undefined,
  });
  process.chdir(options.root);
  if (!linked.success) {
    return { ...result, ...linked };
  }
  const linkedEntries = new Map(
    Object.entries(linked.metafile.outputs)
      .filter(([, output]) => output.entryPoint)
      .map(([name, output]) => [
        path.resolve(inputRoot, output.entryPoint),
        path.resolve(options.outdir, name),
      ]),
  );
  const originalOutputs = new Map(
    Object.entries(result.metafile.outputs).map(([name, output]) => [
      inputPath(path.resolve(options.outdir, name)),
      output,
    ]),
  );
  const retainedInputs = new Set();
  const runtimeOutputs = {};
  for (const [name, output] of Object.entries(linked.metafile.outputs)) {
    const inputs = {};
    for (const input of Object.keys(output.inputs)) {
      for (const [source, contribution] of Object.entries(
        originalOutputs.get(path.resolve(inputRoot, input))?.inputs ?? {},
      )) {
        inputs[source] = contribution;
        retainedInputs.add(source);
      }
    }
    runtimeOutputs[name] = { ...output, inputs };
  }
  const outputs = [];
  for (const artifact of linked.outputs) {
    if (/\.[cm]?js$/.test(artifact.path)) {
      let contents = await artifact.text();
      for (const [reference, input] of requireTargets) {
        const output = linkedEntries.get(input);
        if (!output) {
          throw new Error(`Standalone link omitted required output: ${input}`);
        }
        const relative = path
          .relative(path.dirname(artifact.path), output)
          .split(path.sep)
          .join("/");
        contents = contents.replaceAll(JSON.stringify(reference), JSON.stringify(`./${relative}`));
      }
      fs.writeFileSync(artifact.path, contents);
      outputs.push({ path: artifact.path, text: async () => contents });
    } else {
      outputs.push(artifact);
    }
  }
  return {
    ...result,
    outputs,
    entryOutputs: result.entryOutputs.map((entry) => linkedEntries.get(inputPath(entry))),
    runtimeMetafile: {
      ...result.metafile,
      inputs: Object.fromEntries(
        Object.entries(result.metafile.inputs).filter(([input]) => retainedInputs.has(input)),
      ),
      outputs: runtimeOutputs,
    },
  };
}
