import path from "node:path";

const captureMarker =
  "Bundled plugin code changed; restart the Gateway before using state operations";
const fingerprintMarker = "openclaw-plugin-runtime-artifact-v1\0";

function visit(node, callback, owner, parents = []) {
  if (!node || typeof node !== "object") {
    return;
  }
  const current = ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
    node.type,
  )
    ? node
    : owner;
  const lineage = current !== owner ? [...parents, current] : parents;
  callback(node, current, lineage);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      value.forEach((child) => visit(child, callback, current, lineage));
    } else if (value && typeof value === "object") {
      visit(value, callback, current, lineage);
    }
  }
}

function captureCalls(owner) {
  const captures = [];
  visit(owner.body, (node, nestedOwner) => {
    if (
      nestedOwner === undefined &&
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.arguments.length === 2 &&
      node.arguments.every(
        (argument) =>
          argument.type === "MemberExpression" &&
          !argument.computed &&
          argument.object.type === "Identifier" &&
          argument.property.type === "Identifier",
      ) &&
      node.arguments[0].object.name === node.arguments[1].object.name &&
      node.arguments[0].property.name === "rootDir" &&
      node.arguments[1].property.name === "source"
    ) {
      captures.push(node);
    }
  });
  return captures;
}

/** The compiled image already owns bundled bytes; editable plugins retain their capture owner. */
export function createStandaloneArtifactAdapter({ runtimeRoot, embeddedPaths, parse }) {
  if (!Object.keys(embeddedPaths).some((entry) => entry.startsWith("dist/extensions/"))) {
    throw new Error("Standalone artifacts require embedded bundled plugin entries");
  }
  const bundledEntries = Object.keys(embeddedPaths).filter((entry) =>
    /^dist(?:-runtime)?\/extensions\/[^/]+\/.+\.[cm]?js$/.test(entry),
  );
  const bootstrap = `(() => {
  const buildIdentity = globalThis.__openclawStandaloneBuildInfo?.build?.id;
  if (typeof buildIdentity !== "string" || !buildIdentity) {
    throw new Error("Standalone artifacts require an immutable build identity");
  }
  const bundledEntries = new Set(${JSON.stringify(bundledEntries)});
  const pluginRoots = new Set([...bundledEntries].map((entry) => entry.split("/").slice(0, 3).join("/")));
  const physical = (value) => {
    if (typeof value !== "string") return;
    if (value.startsWith("file:")) value = fileURLToPath(value);
    return path.isAbsolute(value) ? path.resolve(value) : undefined;
  };
  const relative = (value) => {
    const filename = physical(value);
    return filename && path.relative(root, filename).split(path.sep).join("/");
  };
  let requireEmbedded;
  globalThis.__openclawStandaloneLoadPluginModule = (target) => {
    const entry = relative(target);
    if (!bundledEntries.has(entry)) return;
    requireEmbedded ??= globalThis.__openclawStandaloneCreateRequire(
      import.meta.require("node:module").createRequire, path.join(root, "openclaw.mjs"));
    return { moduleExport: requireEmbedded(entries(entry)) };
  };
  globalThis.__openclawStandaloneCaptureOperationArtifact = (capture, rootDir, selected, ...rest) => {
    const sources = typeof selected === "string" ? [selected] : selected;
    const paths = Array.isArray(sources) ? sources.map(relative) : [];
    const pluginRoot = paths[0]?.split("/").slice(0, 3).join("/");
    const scope = relative(rootDir);
    const supported = rest.length === 0 && paths.length > 0 && pluginRoots.has(pluginRoot) &&
      (scope === pluginRoot || scope === pluginRoot.split("/")[0]) &&
      paths.every((entry) => bundledEntries.has(entry) &&
        entry.startsWith(pluginRoot + "/") &&
        /^[^/]+-operation-api\\.[cm]?js$/.test(entry.slice(pluginRoot.length + 1)));
    if (!supported) return capture(rootDir, selected, ...rest);
    const admitted = new Set(paths);
    const capturedRoot = physical(rootDir);
    let disposed = false;
    const assertAvailable = () => {
      if (disposed) throw new Error("Plugin state operation source is no longer available");
    };
    const resolve = (source) => {
      assertAvailable();
      const entry = relative(source);
      if (!admitted.has(entry)) throw new Error("Plugin entry is outside its captured source package");
      return path.join(root, entry);
    };
    return {
      rootDir: capturedRoot,
      hasSource: (source) => !disposed && admitted.has(relative(source)),
      resolve,
      prepareModule: (filename) => { resolve(filename); return []; },
      linkHost: () => { assertAvailable(); },
      dispose: () => { disposed = true; },
      disposeAsync: async () => { disposed = true; },
    };
  };
  globalThis.__openclawStandaloneFingerprintArtifact = (record) => {
    if (record?.origin !== "bundled" || record.sourcePreferred === true) return;
    const pluginRoot = relative(record.rootDir);
    if (!pluginRoots.has(pluginRoot)) return;
    const source = record.source
      ? relative(record.source.startsWith("file:") ? record.source : path.resolve(physical(record.rootDir), record.source))
      : undefined;
    if (record.source && (!bundledEntries.has(source) || !source.startsWith(pluginRoot + "/"))) return;
    const key = JSON.stringify([pluginRoot, source ?? null]);
    return buildIdentity + ":" + key;
  };
})();
`;
  return {
    bootstrap,
    transform({ filename, contents }) {
      if (
        !filename.startsWith(runtimeRoot + path.sep) ||
        (!contents.includes(captureMarker) &&
          !contents.includes("openclaw-plugin-runtime-artifact-v1") &&
          !contents.includes("sourceTransformFallbacks"))
      ) {
        return { contents, count: 0 };
      }
      const ast = parse(contents, { ecmaVersion: "latest", sourceType: "module" });
      const owners = new Map();
      const loaderCounters = new Map();
      visit(ast, (node, owner, parents) => {
        if (node.type === "Literal" && [captureMarker, fingerprintMarker].includes(node.value)) {
          if (!owner || owner.body.type !== "BlockStatement") {
            throw new Error(`Unsupported standalone artifact owner in ${filename}`);
          }
          const selected =
            node.value === captureMarker
              ? parents.toReversed().find((candidate) => captureCalls(candidate).length === 1)
              : owner;
          if (!selected) {
            throw new Error(`Unsupported bundled artifact capture owner in ${filename}`);
          }
          owners.set(selected, node.value);
        }
        if (
          owner &&
          node.type === "AssignmentExpression" &&
          node.operator === "+=" &&
          node.right.type === "Literal" &&
          node.right.value === 1 &&
          node.left.type === "MemberExpression" &&
          !node.left.computed &&
          node.left.object.type === "Identifier" &&
          ["calls", "nativeHits", "sourceTransformFallbacks", "sourceTransformForced"].includes(
            node.left.property.name,
          )
        ) {
          const counters = loaderCounters.get(owner) ?? { parents, objects: new Map() };
          const object = counters.objects.get(node.left.object.name) ?? new Map();
          object.set(node.left.property.name, node);
          counters.objects.set(node.left.object.name, object);
          loaderCounters.set(owner, counters);
        }
      });
      const edits = [];
      for (const [owner, { parents, objects }] of loaderCounters) {
        for (const [name, counters] of objects) {
          if (counters.size !== 4) {
            continue;
          }
          const loader = parents.at(-2);
          if (
            owner.params.length !== 0 ||
            loader?.params.length !== 1 ||
            loader.params[0].type !== "Identifier"
          ) {
            throw new Error(`Unsupported standalone plugin loader callback in ${filename}`);
          }
          const target = loader.params[0].name;
          if (owner.body.type !== "BlockStatement") {
            throw new Error(`Unsupported standalone plugin loader body in ${filename}`);
          }
          const offset = owner.body.start + 1;
          edits.push([
            offset,
            offset,
            `\nconst __openclawStandaloneLoadedPlugin = globalThis.__openclawStandaloneLoadPluginModule(${target});\nif (__openclawStandaloneLoadedPlugin !== undefined) { ${name}.calls += 1; ${name}.nativeHits += 1; return __openclawStandaloneLoadedPlugin.moduleExport; }\n`,
          ]);
        }
      }
      for (const [owner, marker] of owners) {
        if (marker === captureMarker) {
          const captures = captureCalls(owner);
          if (captures.length !== 1) {
            throw new Error(`Expected one bundled operation artifact capture in ${filename}`);
          }
          const { callee } = captures[0];
          edits.push([
            callee.start,
            callee.end,
            `globalThis.__openclawStandaloneCaptureOperationArtifact.bind(null, ${contents.slice(callee.start, callee.end)})`,
          ]);
        } else {
          if (owner.params.length !== 1 || owner.params[0].type !== "Identifier") {
            throw new Error(`Unsupported bundled fingerprint parameters in ${filename}`);
          }
          // Keep the original fallback body and every caller's live authority check intact.
          const parameter = owner.params[0].name;
          const binding = "__openclawStandaloneImmutableArtifactIdentity";
          if (contents.slice(owner.start, owner.end).includes(binding)) {
            throw new Error(`Duplicate standalone fingerprint adaptation in ${filename}`);
          }
          edits.push([
            owner.body.start + 1,
            owner.body.start + 1,
            `\nconst ${binding} = globalThis.__openclawStandaloneFingerprintArtifact(${parameter});\nif (${binding} !== undefined) return ${binding};\n`,
          ]);
        }
      }
      let transformed = contents;
      for (const [start, end, replacement] of edits.toSorted((left, right) => right[0] - left[0])) {
        transformed = transformed.slice(0, start) + replacement + transformed.slice(end);
      }
      return { contents: transformed, count: edits.length };
    },
  };
}
