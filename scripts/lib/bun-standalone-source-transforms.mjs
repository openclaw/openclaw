import fs from "node:fs";
import path from "node:path";

const deferredOutputPlugins = new Set([
  "openclaw:gateway-run-chunk-metadata",
  "openclaw:runtime-dependency-ownership",
  "openclaw:worker-deploy",
  "openclaw:standalone-source-module-urls",
]);
const sourceHooks = new Set(["resolveId", "load", "transform"]);
const pluginFields = new Set(["name", "configureVitest"]);
const startupAssetPlugins = new Set(["openclaw:fs-safe-windows-helper", "openclaw:worker-deploy"]);

async function flattenPlugins(value) {
  const resolved = await value;
  if (!resolved) {
    return [];
  }
  if (Array.isArray(resolved)) {
    return (await Promise.all(resolved.map(flattenPlugins))).flat();
  }
  if (typeof resolved !== "object" || typeof resolved.name !== "string") {
    throw new Error("Standalone source transforms require named plugin objects");
  }
  return [resolved];
}

function handler(plugin, name) {
  const hook = plugin[name];
  if (!hook) {
    return undefined;
  }
  if (typeof hook === "function") {
    return hook;
  }
  if (typeof hook.handler === "function" && !hook.filter) {
    return hook.handler;
  }
  throw new Error(`Unsupported standalone source hook ${plugin.name}.${name}`);
}

function ordered(plugins, name) {
  const rank = (plugin) => ({ pre: -1, post: 1 })[plugin[name]?.order] ?? 0;
  return plugins.filter((plugin) => plugin[name]).toSorted((a, b) => rank(a) - rank(b));
}

function programOf(parse, contents, filename) {
  const ast = parse(contents, { sourceType: "module", ecmaVersion: "latest", filename });
  return ast.program ?? ast;
}

function children(node) {
  const result = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "range" || key === "tokens" || key === "comments") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === "string") {
          result.push([key, child]);
        }
      }
    } else if (value && typeof value.type === "string") {
      result.push([key, value]);
    }
  }
  return result;
}

function bindingNames(pattern, into) {
  if (!pattern) {
    return;
  }
  if (pattern.type === "Identifier") {
    into.add(pattern.name);
  } else if (pattern.type === "RestElement") {
    bindingNames(pattern.argument, into);
  } else if (pattern.type === "AssignmentPattern") {
    bindingNames(pattern.left, into);
  } else if (pattern.type === "ArrayPattern") {
    pattern.elements.forEach((entry) => bindingNames(entry, into));
  } else if (pattern.type === "ObjectPattern") {
    pattern.properties.forEach((entry) =>
      bindingNames(entry.type === "RestElement" ? entry.argument : entry.value, into),
    );
  } else if (pattern.type === "TSParameterProperty") {
    bindingNames(pattern.parameter, into);
  }
}

function staticPath(node) {
  if (node.type === "Identifier") {
    return [node.name];
  }
  if (node.type !== "MemberExpression" || node.optional) {
    return undefined;
  }
  const owner = staticPath(node.object);
  const name = node.computed
    ? node.property.type === "Literal" && typeof node.property.value === "string"
      ? node.property.value
      : undefined
    : node.property.type === "Identifier"
      ? node.property.name
      : undefined;
  return owner && name ? [...owner, name] : undefined;
}

function applyEdits(initialContents, edits) {
  let contents = initialContents;
  let end = contents.length;
  for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
    if (edit.end > end) {
      throw new Error("Overlapping standalone source edits");
    }
    contents = contents.slice(0, edit.start) + edit.value + contents.slice(edit.end);
    end = edit.start;
  }
  return contents;
}

// Only value references are replaced. Type annotations, strings, property names,
// and references shadowed by a runtime binding retain their original bytes.
function defineEdits(program, definitions) {
  const primitiveDefinitions = new Map();
  for (const [name, replacement] of definitions) {
    try {
      const value = JSON.parse(replacement);
      if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
        primitiveDefinitions.set(name, value);
      }
    } catch {
      // An arbitrary define expression still substitutes, but cannot be folded here.
    }
  }
  const scopes = new WeakMap();
  const root = { parent: null, names: new Set(), function: true };
  const functions = new Set([
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunctionExpression",
  ]);
  function collect(node, current) {
    if (!node) {
      return;
    }
    if (
      [
        "FunctionDeclaration",
        "ClassDeclaration",
        "TSEnumDeclaration",
        "TSModuleDeclaration",
        "TSImportEqualsDeclaration",
      ].includes(node.type) &&
      !node.declare &&
      node.id?.type === "Identifier"
    ) {
      current.names.add(node.id.name);
    }
    let scope = current;
    if (
      functions.has(node.type) ||
      [
        "BlockStatement",
        "CatchClause",
        "ForStatement",
        "ForInStatement",
        "ForOfStatement",
        "SwitchStatement",
        "ClassExpression",
        "ClassDeclaration",
        "TSEnumDeclaration",
        "TSModuleDeclaration",
      ].includes(node.type)
    ) {
      scope = {
        parent: current,
        names: new Set(),
        function: functions.has(node.type) || node.type === "TSModuleDeclaration",
      };
      if (functions.has(node.type)) {
        node.params.forEach((param) => bindingNames(param, scope.names));
      }
      if (node.id) {
        scope.names.add(node.id.name);
      }
      if (node.type === "CatchClause") {
        bindingNames(node.param, scope.names);
      }
      if (node.type === "TSEnumDeclaration") {
        for (const member of node.body.members) {
          if (member.id.type === "Identifier") {
            scope.names.add(member.id.name);
          }
        }
      }
    }
    scopes.set(node, scope);
    if (node.type === "VariableDeclaration" && !node.declare) {
      let target = scope;
      if (node.kind === "var") {
        while (!target.function) {
          target = target.parent;
        }
      }
      node.declarations.forEach((declaration) => bindingNames(declaration.id, target.names));
    }
    if (node.type === "ImportDeclaration" && node.importKind !== "type") {
      node.specifiers
        .filter((item) => item.importKind !== "type")
        .forEach((item) => scope.names.add(item.local.name));
    }
    for (const [, child] of children(node)) {
      collect(child, scope);
    }
  }
  collect(program, root);
  const isBound = (scope, name) => {
    for (let at = scope; at; at = at.parent) {
      if (at.names.has(name)) {
        return true;
      }
    }
    return false;
  };
  const edits = [];
  const primitive = (node, scope) => {
    if (node.type === "Literal" && !node.regex && typeof node.value !== "bigint") {
      return { value: node.value, defined: false };
    }
    const parts = staticPath(node);
    const name = parts?.join(".");
    return name && !isBound(scope, parts[0]) && primitiveDefinitions.has(name)
      ? { value: primitiveDefinitions.get(name), defined: true }
      : undefined;
  };
  function visit(node, parent, key, inPattern = false) {
    const scope = scopes.get(node);
    if (node.type.startsWith("TS")) {
      // These TypeScript nodes contain runtime expressions; declarations and
      // type-only children must keep their source bytes.
      if (
        [
          "TSAsExpression",
          "TSSatisfiesExpression",
          "TSNonNullExpression",
          "TSInstantiationExpression",
          "TSTypeAssertion",
        ].includes(node.type)
      ) {
        visit(node.expression, node, "expression");
      } else if (node.type === "TSParameterProperty") {
        visit(node.parameter, node, "parameter", true);
      } else if (node.type === "TSEnumDeclaration" && !node.declare) {
        for (const member of node.body.members) {
          if (member.initializer) {
            visit(member.initializer, member, "initializer");
          }
        }
      } else if (node.type === "TSModuleDeclaration" && !node.declare && node.body) {
        visit(node.body, node, "body");
      } else if (node.type === "TSModuleBlock") {
        for (const statement of node.body) {
          visit(statement, node, "body");
        }
      } else if (node.type === "TSExportAssignment") {
        visit(node.expression, node, "expression");
      }
      return;
    }
    if (node.type === "BinaryExpression" && ["===", "!=="].includes(node.operator)) {
      const left = primitive(node.left, scope);
      const right = primitive(node.right, scope);
      if (left && right && (left.defined || right.defined)) {
        const equal = left.value === right.value;
        // Fold only comparisons made constant by this config. Otherwise the
        // checker sees e.g. "production" === "test" as a source type error.
        edits.push({
          start: node.start,
          end: node.end,
          value: String(node.operator === "===" ? equal : !equal),
        });
        return;
      }
    }
    const isName = node.type === "Identifier";
    const isPropertyName =
      (key === "key" && !parent.computed) || (key === "property" && !parent.computed);
    const isDeclaration =
      inPattern ||
      key === "id" ||
      key === "params" ||
      key === "local" ||
      key === "imported" ||
      key === "exported" ||
      key === "label";
    const parts = !isPropertyName && !isDeclaration ? staticPath(node) : undefined;
    const replacement =
      parts && !isBound(scope, parts[0]) ? definitions.get(parts.join(".")) : undefined;
    if (replacement !== undefined) {
      if (
        (parent?.type === "AssignmentExpression" && key === "left") ||
        parent?.type === "UpdateExpression"
      ) {
        throw new Error(`Cannot assign to standalone build constant ${parts.join(".")}`);
      }
      edits.push({
        start: node.start,
        end: node.end,
        value:
          parent?.shorthand && key === "value" && isName
            ? `${node.name}: (${replacement})`
            : `(${replacement})`,
      });
      return;
    }
    for (const [childKey, child] of children(node)) {
      if (node.type === "ImportDeclaration" || node.type === "ExportSpecifier") {
        continue;
      }
      const pattern =
        node.type === "AssignmentPattern" && childKey === "right"
          ? false
          : inPattern ||
            node.type.endsWith("Pattern") ||
            (node.type === "VariableDeclarator" && childKey === "id");
      visit(child, node, childKey, pattern);
    }
  }
  visit(program, null, "");
  return edits;
}

function configDefinitions(config) {
  const values = new Map();
  if (config.env && (typeof config.env !== "object" || Array.isArray(config.env))) {
    throw new Error("Unsupported standalone env configuration");
  }
  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (!["string", "number", "boolean", "undefined"].includes(typeof value) && value !== null) {
      throw new Error(`Unsupported standalone environment value ${key}`);
    }
    values.set(`process.env.${key}`, JSON.stringify(value) ?? "undefined");
  }
  for (const [key, value] of Object.entries(config.define ?? {})) {
    if (typeof value !== "string" || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(key)) {
      throw new Error(`Unsupported standalone define ${key}`);
    }
    values.set(key, value);
  }
  return values;
}

function safeRuntimePath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    value.split("/").some((part) => part === ".." || part === "." || !part)
  ) {
    throw new Error(`Invalid standalone runtime path ${String(value)}`);
  }
  return value;
}

/** Runs source-level tsdown hooks without invoking its TypeScript transpiler.
 * Output hooks need their existing standalone owners; unknown hooks fail closed.
 * emitChunk must register its source in the final graph and return {runtimePath}.
 * @param {{
 *   sourceRoot: string,
 *   runtimeRoot: string,
 *   parse: import("./bun-standalone-parser.mjs").StandaloneParser,
 *   resolveModule?: (specifier: string, importer: string | undefined, config: import("./bun-standalone-source-entries.mjs").StandaloneSourceConfig) => string | { id: string, external?: boolean } | null | undefined | Promise<string | { id: string, external?: boolean } | null | undefined>,
 *   emitChunk?: (chunk: import("tsdown").Rolldown.EmittedChunk & { config: import("./bun-standalone-source-entries.mjs").StandaloneSourceConfig }) => { runtimePath: string } | Promise<{ runtimePath: string }>,
 *   emitAsset?: (asset: import("tsdown").Rolldown.EmittedAsset & { runtimePath: string, config: import("./bun-standalone-source-entries.mjs").StandaloneSourceConfig }) => void | { runtimePath: string } | Promise<void | { runtimePath: string }>
 * }} options
 */
export function createStandaloneSourceTransforms({
  sourceRoot: requestedSourceRoot,
  runtimeRoot: requestedRuntimeRoot,
  parse,
  resolveModule,
  emitChunk,
  emitAsset,
}) {
  if (typeof parse !== "function") {
    throw new Error("Standalone source transforms require a TypeScript parser");
  }
  const sourceRoot = path.resolve(requestedSourceRoot);
  const runtimeRoot = path.resolve(requestedRuntimeRoot);
  const plans = new WeakMap();
  const startupEmissions = new WeakMap();
  const assets = new Map();
  const deferredHooks = [];
  const watchFiles = new Set();
  let serial = 0;

  async function plan(config) {
    if (!config || typeof config !== "object") {
      throw new Error("Standalone source transforms require their owning config");
    }
    if (!plans.has(config)) {
      plans.set(
        config,
        (async () => {
          const plugins = await flattenPlugins(config.plugins);
          for (const plugin of plugins) {
            for (const key of Object.keys(plugin)) {
              if (pluginFields.has(key) || sourceHooks.has(key)) {
                continue;
              }
              if (key === "buildStart" && startupAssetPlugins.has(plugin.name)) {
                continue;
              }
              if (key === "moduleParsed" && plugin.name === "openclaw:runtime-build-inputs") {
                continue;
              }
              if (
                ["outputOptions", "renderStart", "generateBundle"].includes(key) &&
                deferredOutputPlugins.has(plugin.name)
              ) {
                deferredHooks.push({ plugin: plugin.name, hook: key, config });
                continue;
              }
              throw new Error(`Unsupported standalone plugin hook ${plugin.name}.${key}`);
            }
          }
          const emissions = new Map();
          startupEmissions.set(config, emissions);
          for (const plugin of ordered(plugins, "buildStart")) {
            await handler(plugin, "buildStart").call(context(plugin, config, emissions), {});
          }
          await Promise.all(emissions.values());
          return plugins;
        })(),
      );
    }
    return plans.get(config);
  }

  function context(plugin, config, emissions) {
    const api = {
      meta: { openclawStandaloneSource: true },
      parse(code, options = {}) {
        return programOf(parse, code, options.filename);
      },
      error(error) {
        throw new Error(`${plugin.name}: ${typeof error === "string" ? error : error.message}`);
      },
      addWatchFile(file) {
        watchFiles.add(path.resolve(sourceRoot, file));
      },
      async resolve(specifier, importer) {
        return resolve({ specifier, importer, config, skipPlugin: plugin });
      },
      emitFile(file) {
        if (!emissions) {
          throw new Error(`${plugin.name}: file emission from resolveId is unsupported`);
        }
        const reference = `standalone_${serial++}`;
        const promised = (async () => {
          if (file.type === "chunk") {
            if (!emitChunk) {
              throw new Error(`${plugin.name}: chunk emission requires an emitChunk owner`);
            }
            const result = await emitChunk({ ...file, config });
            return { ...file, ...result, runtimePath: safeRuntimePath(result?.runtimePath) };
          }
          if (
            file.type !== "asset" ||
            typeof file.fileName !== "string" ||
            file.source === undefined
          ) {
            throw new Error(`${plugin.name}: only named asset emissions are supported`);
          }
          const fileName = safeRuntimePath(file.fileName);
          const runtimePath = `dist/${fileName}`;
          const bytes = Buffer.from(file.source);
          const previous = assets.get(runtimePath);
          if (previous && !previous.equals(bytes)) {
            throw new Error(`Conflicting standalone asset ${runtimePath}`);
          }
          assets.set(runtimePath, bytes);
          const result = emitAsset
            ? await emitAsset({ ...file, source: bytes, runtimePath, config })
            : undefined;
          if (!emitAsset && !previous) {
            const target = path.join(runtimeRoot, runtimePath);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, bytes);
          }
          return {
            ...file,
            ...result,
            runtimePath: safeRuntimePath(result?.runtimePath ?? runtimePath),
          };
        })();
        // Hooks receive a synchronous reference; the adapter joins every emission before returning.
        emissions.set(reference, promised);
        promised.catch(() => {});
        return reference;
      },
    };
    return new Proxy(api, {
      get(target, key) {
        if (key in target) {
          return target[key];
        }
        throw new Error(`Unsupported standalone plugin context ${plugin.name}.${String(key)}`);
      },
    });
  }

  /**
   * @param {{
   *   specifier: string,
   *   importer?: string,
   *   config: import("./bun-standalone-source-entries.mjs").StandaloneSourceConfig,
   *   skipPlugin?: import("tsdown").TsdownPlugin
   * }} options
   */
  async function resolve({ specifier, importer, config, skipPlugin }) {
    for (const plugin of ordered(await plan(config), "resolveId")) {
      if (plugin === skipPlugin) {
        continue;
      }
      const result = await handler(plugin, "resolveId").call(
        context(plugin, config, null),
        specifier,
        importer,
        { isEntry: !importer },
      );
      if (result != null) {
        return typeof result === "string" ? { id: result } : result;
      }
    }
    const resolved = resolveModule ? await resolveModule(specifier, importer, config) : null;
    return typeof resolved === "string" ? { id: resolved } : resolved;
  }

  async function transform({ filename, contents: initialContents, config, skipLoad = false }) {
    let contents = initialContents;
    const plugins = await plan(config);
    const emissions = new Map(startupEmissions.get(config));
    let moduleType;
    if (!skipLoad) {
      for (const plugin of ordered(plugins, "load")) {
        const loaded = await handler(plugin, "load").call(
          context(plugin, config, emissions),
          filename,
        );
        if (loaded == null) {
          continue;
        }
        contents = typeof loaded === "string" ? loaded : loaded.code;
        moduleType = loaded.moduleType;
        break;
      }
    }
    for (const plugin of ordered(plugins, "transform")) {
      const transformed = await handler(plugin, "transform").call(
        context(plugin, config, emissions),
        contents,
        filename,
      );
      if (transformed == null) {
        continue;
      }
      contents = typeof transformed === "string" ? transformed : transformed.code;
      if (typeof contents !== "string") {
        throw new Error(`${plugin.name}: transform did not return source text`);
      }
      moduleType = transformed.moduleType ?? moduleType;
    }
    const emitted = new Map(
      await Promise.all([...emissions].map(async ([id, pending]) => [id, await pending])),
    );
    const definitions = configDefinitions(config);
    // import.meta is not an identifier chain; rewrite its emitted references independently.
    const ast = programOf(parse, contents, filename);
    const edits = defineEdits(ast, definitions);
    function visit(node) {
      if (
        node.type === "MemberExpression" &&
        !node.computed &&
        node.object.type === "MetaProperty" &&
        node.object.meta.name === "import" &&
        node.object.property.name === "meta" &&
        node.property.type === "Identifier" &&
        node.property.name.startsWith("ROLLUP_FILE_URL_")
      ) {
        const reference = node.property.name.slice("ROLLUP_FILE_URL_".length);
        const record = emitted.get(reference);
        if (!record) {
          throw new Error(`Unknown standalone emitted reference ${reference}`);
        }
        edits.push({
          start: node.start,
          end: node.end,
          value: `new URL(${JSON.stringify(record.runtimePath)}, globalThis.__openclawStandaloneRootUrl).href`,
        });
        return;
      }
      for (const [, child] of children(node)) {
        visit(child);
      }
    }
    visit(ast);
    contents = applyEdits(contents, edits);
    for (const plugin of ordered(plugins, "moduleParsed")) {
      await handler(plugin, "moduleParsed").call(context(plugin, config, null), { id: filename });
    }
    return {
      contents,
      moduleType,
      emitted: [...emitted.values()],
      deferredHooks: deferredHooks.filter((entry) => entry.config === config),
      watchFiles: [...watchFiles],
    };
  }

  async function load({ filename, config }) {
    for (const plugin of ordered(await plan(config), "load")) {
      const emissions = new Map();
      const loaded = await handler(plugin, "load").call(
        context(plugin, config, emissions),
        filename,
      );
      if (loaded != null) {
        if (emissions.size) {
          throw new Error(`${plugin.name}: emitting files from a virtual load is unsupported`);
        }
        const transformed = await transform({
          filename,
          contents: typeof loaded === "string" ? loaded : loaded.code,
          config,
          skipLoad: true,
        });
        return { ...transformed, moduleType: transformed.moduleType ?? loaded.moduleType };
      }
    }
    return null;
  }

  return { transform, resolve, load, deferredHooks, watchFiles };
}
