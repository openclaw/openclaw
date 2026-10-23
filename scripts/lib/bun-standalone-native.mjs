import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { moduleResolve } from "import-meta-resolve";

const TABLE_MARKER = "__OPENCLAW_STANDALONE_NATIVE_TABLE__";
const NATIVE_LIBRARY = /\.(?:dylib|dll|so(?:\.\d+)*)$/;
const NATIVE_ADDON = /\.node$/;
const RESOURCE = /\.wasm$/;
const COPILOT_RUNTIME_PACKAGE = /^@github\/copilot-sdk-(?:darwin|linux|linuxmusl|win32)-/;
const LICENSE = /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i;
const slash = (filename) => filename.split(path.sep).join("/");

function isCommonJsEntry(filename, packageType) {
  return filename.endsWith(".cjs") || (filename.endsWith(".js") && packageType !== "module");
}

function matchesPlatform(values, actual) {
  if (!Array.isArray(values)) {
    return true;
  }
  return (
    !values.includes(`!${actual}`) &&
    (!values.some((value) => !value.startsWith("!")) || values.includes(actual))
  );
}

function nativeResourceTarget(filename) {
  const header = Buffer.allocUnsafe(4096);
  const fd = fs.openSync(filename, "r");
  let bytes;
  try {
    bytes = header.subarray(0, fs.readSync(fd, header, 0, header.length, 0));
  } finally {
    fs.closeSync(fd);
  }
  if (bytes.length < 4) {
    return undefined;
  }
  const magic = bytes.readUInt32BE(0);
  if (magic === 0x0061736d) {
    return { portable: true };
  }
  if (magic === 0x7f454c46) {
    const machine =
      bytes.length >= 20
        ? bytes[5] === 2
          ? bytes.readUInt16BE(18)
          : bytes.readUInt16LE(18)
        : undefined;
    return {
      platform: "linux",
      architectures: [{ 3: "ia32", 40: "arm", 62: "x64", 183: "arm64" }[machine]].filter(Boolean),
    };
  }
  if (bytes.readUInt16BE(0) === 0x4d5a) {
    return { platform: "win32", architectures: [] };
  }
  const thin = [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic);
  const fat = [0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic);
  if ((!thin && !fat) || bytes.length < 8) {
    return undefined;
  }
  const littleEndian = [0xcefaedfe, 0xcffaedfe, 0xbebafeca, 0xbfbafeca].includes(magic);
  const read = (offset) => (littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset));
  const stride = [0xcafebabf, 0xbfbafeca].includes(magic) ? 32 : 20;
  const count = fat ? Math.min(read(4), Math.floor((bytes.length - 8) / stride)) : 1;
  const architectures = Array.from(
    { length: count },
    (_, index) =>
      ({ 7: "ia32", 12: "arm", 0x01000007: "x64", 0x0100000c: "arm64" })[
        read(fat ? 8 + index * stride : 4)
      ],
  ).filter(Boolean);
  return { platform: "darwin", architectures };
}

// Native headers own target selection; directory labels cover opaque prebuilds.
function hostResource(filename, platform, arch, target) {
  if (target?.portable) {
    return true;
  }
  if (target?.platform && target.platform !== platform) {
    return false;
  }
  const architectures = target?.architectures ?? [];
  if (architectures.length && !architectures.includes(arch)) {
    return false;
  }
  const segments = filename.split("/");
  const platforms = new Set(["darwin", "linux", "win32", "freebsd", "android"]);
  for (const segment of segments) {
    if (platforms.has(segment) && segment !== platform) {
      return false;
    }
    const qualified = /^(darwin|linux|win32|freebsd|android)-(arm64|x64|ia32)(?:-|$)/.exec(segment);
    if (
      qualified &&
      (qualified[1] !== platform || (!architectures.length && qualified[2] !== arch))
    ) {
      return false;
    }
    if (!architectures.length && /^(?:arm64|x64|ia32)$/.test(segment) && segment !== arch) {
      return false;
    }
  }
  return true;
}

// Copilot's runtimeArtifacts collector owns this separate process's package layout.
// Its extension/plugin scripts are executed by that runtime, not by the host image.
function copilotRuntimeResource(packageName, filename) {
  if (!COPILOT_RUNTIME_PACKAGE.test(packageName)) {
    return false;
  }
  const parts = filename.split("/");
  const excluded = new Set([
    "app.js",
    "assets",
    "changelog.json",
    "copilot",
    "copilot.exe",
    "foundry-local-sdk",
    "index.js",
    "LICENSE.md",
    "napi-oop-runtime",
    "npm-loader.js",
    "package.json",
    "pvrecorder",
    "queries",
    "README.md",
    "sea-loader.js",
    "webview",
  ]);
  const name = parts.at(-1);
  return (
    !excluded.has(parts[0]) &&
    !/^tree-sitter.*\.wasm$/.test(parts[0]) &&
    !/^voice-.*\.js$/.test(parts[0]) &&
    name !== "cli-native.node" &&
    !parts.includes("mediaremote-adapter") &&
    !name.startsWith("copilot-runtime-bin") &&
    !/\.(?:map|d\.[cm]?ts)$/.test(name)
  );
}

function resourceCategory(filename, executable, packageName) {
  // Playwright loads its registry and Chromium icon from disk, and serves its own
  // browser-side tools as static assets. Its injected server code is already inline.
  if (
    packageName === "playwright-core" &&
    (filename === "browsers.json" ||
      filename.startsWith("bin/") ||
      filename.startsWith("lib/vite/") ||
      /^lib\/(?:server\/chromium|tools\/dashboard)\/appIcon\.png$/.test(filename))
  ) {
    return "dependencyAssets";
  }
  if (COPILOT_RUNTIME_PACKAGE.test(packageName)) {
    return copilotRuntimeResource(packageName, filename) ? "externalRuntime" : undefined;
  }
  if (NATIVE_ADDON.test(filename)) {
    return "nativeAddons";
  }
  if (NATIVE_LIBRARY.test(filename)) {
    return "nativeLibraries";
  }
  if (RESOURCE.test(filename) || executable || /(?:^|\/)spawn-helper$/.test(filename)) {
    return "dependencyAssets";
  }
  return undefined;
}

// Module pseudo-globals are replaceable only when no lexical binding shadows them.
function lexicalBindings(ast) {
  const scopes = new WeakMap();
  const root = { names: new Set(), callable: true };
  const bind = (node, scope) => {
    if (!node) {
      return;
    }
    if (node.type === "Identifier") {
      scope.names.add(node.name);
    } else if (node.type === "RestElement") {
      bind(node.argument, scope);
    } else if (node.type === "AssignmentPattern") {
      bind(node.left, scope);
    } else if (node.type === "ArrayPattern") {
      node.elements.forEach((entry) => bind(entry, scope));
    } else if (node.type === "ObjectPattern") {
      node.properties.forEach((entry) =>
        bind(entry.type === "RestElement" ? entry.argument : entry.value, scope),
      );
    }
  };
  function visit(node, parent, parentScope) {
    let scope = parentScope;
    if (!node || typeof node !== "object") {
      return;
    }
    const callable = /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(
      node.type,
    );
    if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
      bind(node.id, scope);
    }
    if (callable || node.type === "BlockStatement" || node.type === "CatchClause") {
      scope = { parent: scope, names: new Set(), callable };
    }
    scopes.set(node, scope);
    if (callable) {
      bind(node.id, scope);
      node.params.forEach((parameter) => bind(parameter, scope));
    }
    if (node.type === "CatchClause") {
      bind(node.param, scope);
    }
    if (node.type === "VariableDeclarator") {
      let target = scope;
      if (parent.kind === "var") {
        while (target.parent && !target.callable) {
          target = target.parent;
        }
      }
      bind(node.id, target);
    }
    if (/^Import(?:Default|Namespace)?Specifier$/.test(node.type)) {
      bind(node.local, scope);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        value.forEach((child) => visit(child, node, scope));
      } else if (value && typeof value === "object") {
        visit(value, node, scope);
      }
    }
  }
  visit(ast, undefined, root);
  const bindingScope = (node) => {
    for (let scope = scopes.get(node); scope; scope = scope.parent) {
      if (scope.names.has(node.name)) {
        return scope;
      }
    }
    return undefined;
  };
  return {
    isBound: (node) => Boolean(bindingScope(node)),
    isModuleBinding: (node) => bindingScope(node) === root,
  };
}

/** Capture dependency resources and resolution before removing pnpm's installation topology. */
export function createStandaloneNativeAdapter({
  runtimeRoot: inputRuntimeRoot,
  parse,
  platform = process.platform,
  arch = process.arch,
}) {
  const runtimeRoot = fs.realpathSync(inputRuntimeRoot);
  const packages = new Map();
  const ownerCache = new Map();
  const observed = new Set();
  const runtimeReferenced = new Set();
  const declaredPluginDependencies = new Set();
  const requireExports = new Map();
  const additionalModuleEntries = [];
  const commonJsEntries = [];
  const contained = (filename) => {
    const relative = path.relative(runtimeRoot, filename);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const relative = (filename) => slash(path.relative(runtimeRoot, filename));
  // Bun's built-in ws has no search paths; installed package discovery still needs Node's roots.
  const packageSearchPaths = (owner) =>
    owner?.require.resolve.paths("__standalone_package__") ?? [];

  function register(inputDirectory) {
    const directory = fs.realpathSync(inputDirectory);
    if (packages.has(directory)) {
      return packages.get(directory);
    }
    if (!contained(directory)) {
      return undefined;
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
    if (
      (!manifest.name && directory !== runtimeRoot) ||
      !matchesPlatform(manifest.os, platform) ||
      !matchesPlatform(manifest.cpu, arch)
    ) {
      return undefined;
    }
    const original = relative(directory);
    const storeMatch = original.match(/(?:^|\/)\.pnpm\/([^/]+)\/node_modules\//);
    const namespace =
      storeMatch?.[1] ??
      `${(manifest.name ?? "root").replaceAll("/", "+")}@${manifest.version ?? "0"}`;
    const owner = {
      directory,
      manifest,
      original,
      destination: `native/${namespace}/${manifest.name}`,
      relocate: /(?:^|\/)node_modules\//.test(original) || original.startsWith("packages/"),
      dependencies: new Map(),
      resources: [],
      require: createRequire(path.join(directory, "package.json")),
    };
    packages.set(directory, owner);
    function scan(current, prefix = "") {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (
          [
            "node_modules",
            ".git",
            ".vite",
            ".cache",
            "test",
            "tests",
            "__tests__",
            "fixtures",
            "examples",
            "benchmarks",
            "docs",
            "coverage",
          ].includes(entry.name)
        ) {
          continue;
        }
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        const source = path.join(current, entry.name);
        if (entry.isDirectory()) {
          scan(source, name);
          continue;
        }
        if (!entry.isFile() && !entry.isSymbolicLink()) {
          continue;
        }
        const resolved = fs.realpathSync(source);
        if (!contained(resolved)) {
          throw new Error(`Dependency resource escapes runtime: ${source}`);
        }
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) {
          continue;
        }
        // Executable support programs (pty helper, browser driver, etc.) remain disk assets.
        const executable =
          (stat.mode & 0o111) !== 0 &&
          !LICENSE.test(name) &&
          !/\.(?:[cm]?[jt]s|map|json|md|sh|ps1|cmd|bat|d\.ts)$/.test(name);
        const category = resourceCategory(name, executable, manifest.name);
        const target =
          category &&
          category !== "externalRuntime" &&
          (NATIVE_ADDON.test(name) ||
            NATIVE_LIBRARY.test(name) ||
            RESOURCE.test(name) ||
            executable)
            ? nativeResourceTarget(resolved)
            : undefined;
        if (
          category &&
          (category === "externalRuntime" || hostResource(name, platform, arch, target))
        ) {
          owner.resources.push({
            source: relative(source),
            destination: `${owner.destination}/${name}`,
            category,
          });
        }
      }
    }
    if (owner.relocate) {
      scan(directory);
    }
    for (const name of Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    })) {
      let manifestPath;
      try {
        // package.json exports are often deliberately private; walking the Node search path
        // keeps resolution faithful without evaluating package code.
        for (const search of packageSearchPaths(owner)) {
          const candidate = path.join(search, name, "package.json");
          if (fs.existsSync(candidate)) {
            manifestPath = candidate;
            break;
          }
        }
      } catch {
        continue;
      }
      if (!manifestPath || !contained(fs.realpathSync(manifestPath))) {
        continue;
      }
      const dependency = register(path.dirname(manifestPath));
      if (dependency) {
        owner.dependencies.set(name, dependency);
      }
    }
    return owner;
  }

  function ownerOf(filename) {
    if (ownerCache.has(filename)) {
      return ownerCache.get(filename);
    }
    let directory = path.dirname(filename);
    let found;
    while (contained(directory) && directory !== runtimeRoot) {
      if (fs.existsSync(path.join(directory, "package.json"))) {
        found = register(directory);
        break;
      }
      directory = path.dirname(directory);
    }
    if (!found && directory === runtimeRoot) {
      found = packages.get(runtimeRoot);
    }
    ownerCache.set(filename, found);
    return found;
  }

  function requireBindings(ast, filename) {
    const { isBound, isModuleBinding } = lexicalBindings(ast);
    const origins = new Map();
    const factories = new Set();
    const moduleResolvers = new Set();
    const moduleRequire = createRequire(filename);
    const calls = new Set();
    const pending = [ast];
    while (pending.length) {
      const node = pending.pop();
      if (!node || typeof node !== "object") {
        continue;
      }
      if (node.type === "CallExpression") {
        const callee = node.callee.type === "MemberExpression" ? node.callee.object : node.callee;
        if (callee.type === "Identifier") {
          calls.add(callee.name);
        }
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          pending.push(...value);
        } else if (value && typeof value === "object") {
          pending.push(value);
        }
      }
    }
    for (const node of ast.body) {
      if (node.type !== "ImportDeclaration") {
        continue;
      }
      if (["node:module", "module"].includes(node.source.value)) {
        for (const specifier of node.specifiers) {
          if (specifier.imported?.name === "createRequire") {
            factories.add(specifier.local.name);
          }
        }
      } else if (node.source.value === "import-meta-resolve") {
        for (const specifier of node.specifiers) {
          if (specifier.imported?.name === "moduleResolve") {
            moduleResolvers.add(specifier.local.name);
          }
        }
      } else if (node.source.value.startsWith(".")) {
        const used = node.specifiers.filter(
          (specifier) => specifier.type === "ImportSpecifier" && calls.has(specifier.local.name),
        );
        if (!used.length) {
          continue;
        }
        let target;
        try {
          target = moduleRequire.resolve(node.source.value);
        } catch {
          continue;
        }
        if (!contained(target) || !/\.[cm]?js$/.test(target)) {
          continue;
        }
        let exported = requireExports.get(target);
        if (!exported) {
          exported = new Map();
          requireExports.set(target, exported);
          const source = fs.readFileSync(target, "utf8");
          if (!source.includes("createRequire")) {
            continue;
          }
          const targetAst = parse(source, {
            ecmaVersion: "latest",
            sourceType: "module",
          });
          const targetBindings = requireBindings(targetAst, target);
          for (const statement of targetAst.body) {
            if (statement.type !== "ExportNamedDeclaration") {
              continue;
            }
            for (const specifier of statement.specifiers) {
              const origin = targetBindings.origins.get(specifier.local.name);
              if (origin) {
                exported.set(specifier.exported.name ?? specifier.exported.value, origin);
              }
            }
          }
        }
        for (const specifier of used) {
          const origin = exported.get(specifier.imported.name ?? specifier.imported.value);
          if (origin) {
            origins.set(specifier.local.name, origin);
          }
        }
      }
    }
    function originOf(node) {
      if (node?.type === "Identifier" && isModuleBinding(node)) {
        return origins.get(node.name);
      }
      if (node?.type !== "CallExpression") {
        return undefined;
      }
      if (
        node.callee.type === "Identifier" &&
        factories.has(node.callee.name) &&
        isModuleBinding(node.callee)
      ) {
        const argument = node.arguments[0];
        if (
          (argument?.type === "MemberExpression" &&
            !argument.computed &&
            argument.object.type === "MetaProperty" &&
            argument.object.meta.name === "import" &&
            argument.property.name === "url") ||
          (argument?.type === "Identifier" && argument.name === "__filename" && !isBound(argument))
        ) {
          return filename;
        }
      }
      // Rolldown exports its native require through this zero-argument closure.
      if (
        node.arguments.length === 0 &&
        node.callee.type === "ArrowFunctionExpression" &&
        node.callee.params.length === 0
      ) {
        return originOf(node.callee.body);
      }
      return undefined;
    }
    for (const statement of ast.body) {
      const declaration =
        statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
      if (declaration?.type !== "VariableDeclaration") {
        continue;
      }
      for (const entry of declaration.declarations) {
        const origin = originOf(entry.init);
        if (entry.id.type === "Identifier" && origin) {
          origins.set(entry.id.name, origin);
        }
      }
    }
    return { origins, moduleResolvers, isBound, isModuleBinding };
  }

  function staticModuleResolution(node, filename, bindings) {
    if (
      node.type !== "CallExpression" ||
      node.callee.type !== "Identifier" ||
      !bindings.moduleResolvers.has(node.callee.name) ||
      !bindings.isModuleBinding(node.callee) ||
      node.arguments.length !== 3
    ) {
      return undefined;
    }
    const [specifier, parent, conditions] = node.arguments;
    const url = parent?.arguments?.[0];
    const values = conditions?.arguments?.[0];
    if (
      specifier.type !== "Literal" ||
      typeof specifier.value !== "string" ||
      parent?.type !== "NewExpression" ||
      parent.callee.type !== "Identifier" ||
      parent.callee.name !== "URL" ||
      bindings.isBound(parent.callee) ||
      parent.arguments.length !== 1 ||
      url?.type !== "MemberExpression" ||
      url.computed ||
      url.property.name !== "url" ||
      url.object.type !== "MetaProperty" ||
      url.object.meta.name !== "import" ||
      conditions?.type !== "NewExpression" ||
      conditions.callee.type !== "Identifier" ||
      conditions.callee.name !== "Set" ||
      bindings.isBound(conditions.callee) ||
      conditions.arguments.length !== 1 ||
      values?.type !== "ArrayExpression" ||
      values.elements.some((value) => value?.type !== "Literal" || typeof value.value !== "string")
    ) {
      return undefined;
    }
    try {
      const resolved = moduleResolve(
        specifier.value,
        pathToFileURL(filename),
        new Set(values.elements.map((value) => value.value)),
      );
      if (resolved.protocol !== "file:") {
        return undefined;
      }
      const target = fs.realpathSync(fileURLToPath(resolved));
      return contained(target) && /\.[cm]?js$/.test(target) ? target : undefined;
    } catch {
      // Unavailable optional imports keep their existing runtime resolution behavior.
      return undefined;
    }
  }

  function retainRuntimeReference(filename, specifier) {
    if (typeof specifier !== "string" || /(?:^|\/)package\.json$/.test(specifier)) {
      return undefined;
    }
    let target;
    try {
      target = createRequire(filename).resolve(specifier);
    } catch {
      // Absent optional platform packages do not become runtime requirements.
      return undefined;
    }
    if (!path.isAbsolute(target) || !contained(target) || target.endsWith(".json")) {
      return undefined;
    }
    const dependency = ownerOf(fs.realpathSync(target));
    if (
      dependency?.resources.length &&
      (/\.[cm]?[jt]s$/.test(target) ||
        dependency.resources.some((resource) => resource.source === relative(target)))
    ) {
      runtimeReferenced.add(dependency);
    }
    return target;
  }

  function collectRuntimeReferences(ast, filename, admitModules = false) {
    const bindings = requireBindings(ast, filename);
    const moduleResolutions = new Map();
    const admitModule = (target) => {
      const entry = relative(target);
      if (!additionalModuleEntries.includes(entry)) {
        additionalModuleEntries.push(entry);
      }
      const owner = ownerOf(target);
      if (isCommonJsEntry(target, owner?.manifest.type) && !commonJsEntries.includes(entry)) {
        commonJsEntries.push(entry);
      }
    };
    function visit(node) {
      if (!node || typeof node !== "object") {
        return;
      }
      const selected = staticModuleResolution(node, filename, bindings);
      if (selected) {
        moduleResolutions.set(node, selected);
        if (admitModules) {
          admitModule(selected);
        }
      }
      if (
        [
          "ImportDeclaration",
          "ExportNamedDeclaration",
          "ExportAllDeclaration",
          "ImportExpression",
        ].includes(node.type)
      ) {
        retainRuntimeReference(filename, node.source?.value);
      }
      const resolveCall =
        node.callee?.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.property?.name === "resolve";
      const callee = resolveCall ? node.callee.object : node.callee;
      if (node.type === "CallExpression" && callee?.type === "Identifier") {
        const opaqueOrigin = bindings.isModuleBinding(callee) && bindings.origins.get(callee.name);
        const origin =
          !bindings.isBound(callee) && callee.name === "require" ? filename : opaqueOrigin;
        if (origin) {
          const target = retainRuntimeReference(origin, node.arguments[0]?.value);
          if (admitModules && !resolveCall && opaqueOrigin && target && /\.[cm]?js$/.test(target)) {
            admitModule(target);
          }
        }
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          value.forEach(visit);
        } else if (value && typeof value === "object") {
          visit(value);
        }
      }
    }
    visit(ast);
    return { ...bindings, moduleResolutions };
  }

  // Discover native optional wrappers before Bun's graph is fixed. Only production
  // dependency declarations seed this pass; dev-tool prebuilds never become entries.
  const roots = [runtimeRoot];
  for (const rootName of ["extensions", "dist/extensions"]) {
    const directory = path.join(runtimeRoot, rootName);
    if (!fs.existsSync(directory)) {
      continue;
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(directory, entry.name, "package.json"))) {
        roots.push(path.join(directory, entry.name));
      }
    }
  }
  for (const directory of roots) {
    if (!fs.existsSync(path.join(directory, "package.json"))) {
      continue;
    }
    const rootOwner = register(directory);
    if (rootOwner) {
      observed.add(rootOwner);
      if (directory !== runtimeRoot) {
        for (const dependency of rootOwner.dependencies.values()) {
          declaredPluginDependencies.add(dependency);
        }
      }
    }
  }
  for (const owner of packages.values()) {
    for (const name of Object.keys(owner.manifest.optionalDependencies ?? {})) {
      const dependency = owner.dependencies.get(name);
      if (!dependency?.resources.length || COPILOT_RUNTIME_PACKAGE.test(dependency.manifest.name)) {
        continue;
      }
      let entry;
      try {
        entry = owner.require.resolve(name);
      } catch {
        continue;
      }
      if (!/\.[cm]?js$/.test(entry)) {
        continue;
      }
      const value = relative(entry);
      if (!additionalModuleEntries.includes(value)) {
        additionalModuleEntries.push(value);
      }
      if (isCommonJsEntry(entry, dependency.manifest.type)) {
        commonJsEntries.push(value);
      }
    }
  }

  const bootstrap = `import { createRequire as __standaloneNativeCreateRequire } from "node:module";
(() => {
  const table = ${JSON.stringify(TABLE_MARKER)};
  globalThis.__openclawStandaloneNativePath = (relative) => path.join(root, relative);
  const original = (filename) => {
    const absolute = filename.startsWith("file:") ? fileURLToPath(filename) : filename;
    const key = path.relative(root, absolute).split(path.sep).join("/");
    for (const owner of table.owners) {
      if (key === owner.destination || key.startsWith(owner.destination + "/")) {
        return path.join(root, owner.original, key.slice(owner.destination.length));
      }
    }
    return absolute;
  };
  globalThis.__openclawStandaloneOriginalPath = original;
  globalThis.__openclawStandaloneNativeResolve = (parent, specifier) => {
    if (typeof specifier !== "string" || specifier.startsWith("node:") || specifier.startsWith("bun:")) return undefined;
    const from = original(parent);
    const parentKey = path.relative(root, from);
    const internalParent = parentKey !== ".." && !parentKey.startsWith(".." + path.sep) && !path.isAbsolute(parentKey);
    if (!internalParent && !path.isAbsolute(specifier) && !specifier.startsWith("file:")) return undefined;
    let target;
    if (specifier.startsWith("file:")) target = original(specifier);
    else if (path.isAbsolute(specifier)) target = original(specifier);
    else if (specifier.startsWith(".")) target = path.resolve(path.dirname(from), specifier);
    else {
      const key = path.relative(root, from).split(path.sep).join("/");
      const owner = table.owners.find((candidate) => candidate.original === "" || key.startsWith(candidate.original + "/"));
      const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
      const dependency = owner?.dependencies[name];
      if (!dependency) return undefined;
      target = dependency.entries[specifier] ? path.join(root, dependency.entries[specifier])
        : specifier === name ? path.join(root, dependency.original)
        : path.join(root, dependency.original, specifier.slice(name.length + 1));
    }
    const key = path.relative(root, target).split(path.sep).join("/");
    return table.files[key] ? path.join(root, table.files[key])
      : table.embedded[key] ? path.join(root, key) : undefined;
  };
  globalThis.__openclawStandaloneNativeResolvePaths = (parent, specifier) => {
    if (typeof specifier !== "string" || specifier.startsWith(".") || path.isAbsolute(specifier)) return undefined;
    const from = original(parent);
    const key = path.relative(root, from).split(path.sep).join("/");
    if (key === ".." || key.startsWith("../") || path.isAbsolute(key)) return undefined;
    const owner = table.owners.find((candidate) => candidate.original === "" || key.startsWith(candidate.original + "/"));
    const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
    const dependency = owner?.dependencies[name];
    const selected = dependency && table.owners.find((candidate) => candidate.original === dependency.original);
    if (!selected) return undefined;
    let search = path.join(root, selected.destination);
    for (const part of name.split("/")) search = path.dirname(search);
    return [search];
  };
  const requires = new Map();
  const requireFrom = (parent) => {
    let require = requires.get(parent);
    if (!require) {
      require = globalThis.__openclawStandaloneCreateRequire(__standaloneNativeCreateRequire, parent);
      requires.set(parent, require);
    }
    return require;
  };
  globalThis.__openclawStandaloneNativeRequire = (parent, specifier) => requireFrom(parent)(specifier);
  globalThis.__openclawStandaloneNativeRequire.resolve = (parent, ...args) => requireFrom(parent).resolve(...args);
})();\n`;

  return {
    bootstrap,
    discover(moduleEntries) {
      const pending = new Set([...moduleEntries, ...additionalModuleEntries]);
      for (const entry of pending) {
        const filename = path.join(runtimeRoot, entry);
        const contents = fs.readFileSync(filename, "utf8");
        if (!/import|createRequire/.test(contents)) {
          continue;
        }
        const ast = parse(contents, {
          ecmaVersion: "latest",
          sourceType: "module",
          allowReturnOutsideFunction: true,
        });
        collectRuntimeReferences(ast, filename, true);
        // Bun owns ordinary imports/requires; only opaque require targets need entries.
        for (const additional of additionalModuleEntries) {
          pending.add(additional);
        }
      }
    },
    get additionalModuleEntries() {
      return additionalModuleEntries.toSorted((a, b) => a.localeCompare(b));
    },
    get commonJsEntries() {
      return commonJsEntries.toSorted((a, b) => a.localeCompare(b));
    },
    transform({ filename: inputFilename, contents: inputContents }) {
      const filename = path.join(
        fs.realpathSync(path.dirname(inputFilename)),
        path.basename(inputFilename),
      );
      let contents = inputContents;
      const owner = ownerOf(filename);
      if (!owner) {
        return { contents, count: 0 };
      }
      observed.add(owner);
      if (!/import|export|__dirname|__filename|require\s*(?:\(|\.\s*resolve\s*\()/.test(contents)) {
        return { contents, count: 0 };
      }
      const ast = parse(contents, {
        ecmaVersion: "latest",
        sourceType: "module",
        allowReturnOutsideFunction: true,
      });
      const { isBound, moduleResolutions } = collectRuntimeReferences(ast, filename);
      const moduleRequire = createRequire(filename);
      const nativeRequest = (argument) => {
        if (argument?.type !== "Literal") {
          return true;
        }
        if (typeof argument.value !== "string") {
          return false;
        }
        const nativeFilename = (value) =>
          NATIVE_ADDON.test(value) || NATIVE_LIBRARY.test(value) || RESOURCE.test(value);
        if (nativeFilename(argument.value)) {
          return true;
        }
        try {
          return nativeFilename(moduleRequire.resolve(argument.value));
        } catch {
          // Optional packages for other platforms still use their original resolution path.
          return false;
        }
      };
      const destination = `${owner.destination}/${slash(path.relative(owner.directory, filename))}`;
      const physical = `(globalThis.__openclawStandaloneRootUrl + ${JSON.stringify(destination)})`;
      // Preserve lazy factory evaluation while pinning constant conditional-export edges.
      const rootUrl = pathToFileURL(runtimeRoot + path.sep).href;
      const edits = [...moduleResolutions].map(([node, target]) => [
        node.start,
        node.end,
        `new URL(${JSON.stringify(pathToFileURL(target).href.slice(rootUrl.length))}, globalThis.__openclawStandaloneRootUrl)`,
      ]);
      function visit(node, parent, key) {
        if (!node || typeof node !== "object") {
          return;
        }
        if (moduleResolutions.has(node)) {
          return;
        }
        if (
          node.type === "MemberExpression" &&
          !node.computed &&
          node.object?.type === "MetaProperty" &&
          node.object.meta.name === "import"
        ) {
          if (node.property.name === "url") {
            edits.push([node.start, node.end, physical]);
            return;
          }
          if (["dir", "dirname", "path", "filename"].includes(node.property.name)) {
            const suffix = ["dir", "dirname"].includes(node.property.name)
              ? path.posix.dirname(destination)
              : destination;
            edits.push([
              node.start,
              node.end,
              `globalThis.__openclawStandaloneNativePath(${JSON.stringify(suffix)})`,
            ]);
            return;
          }
        }
        if (
          node.type === "Identifier" &&
          ["__dirname", "__filename"].includes(node.name) &&
          !isBound(node) &&
          !(parent?.type === "MemberExpression" && key === "property" && !parent.computed) &&
          !(parent?.type === "Property" && key === "key") &&
          !(parent?.type === "VariableDeclarator" && key === "id")
        ) {
          const suffix = node.name === "__dirname" ? path.posix.dirname(destination) : destination;
          edits.push([
            node.start,
            node.end,
            `${parent?.type === "Property" && parent.shorthand ? `${node.name}: ` : ""}globalThis.__openclawStandaloneNativePath(${JSON.stringify(suffix)})`,
          ]);
          return;
        }
        const requireResolve =
          node.callee?.type === "MemberExpression" &&
          !node.callee.computed &&
          node.callee.property?.name === "resolve";
        const requireCallee = requireResolve ? node.callee.object : node.callee;
        if (
          node.type === "CallExpression" &&
          requireCallee?.type === "Identifier" &&
          requireCallee.name === "require" &&
          !isBound(requireCallee) &&
          nativeRequest(node.arguments[0])
        ) {
          edits.push([
            node.callee.start,
            node.callee.end,
            `globalThis.__openclawStandaloneNativeRequire${requireResolve ? ".resolve" : ""}.bind(null, ${physical})`,
          ]);
        }
        for (const [childKey, value] of Object.entries(node)) {
          if (Array.isArray(value)) {
            value.forEach((child) => visit(child, node, childKey));
          } else if (value && typeof value === "object") {
            visit(value, node, childKey);
          }
        }
      }
      if (owner.relocate) {
        visit(ast);
      }
      for (const [start, end, replacement] of edits.toSorted((a, b) => b[0] - a[0])) {
        contents = contents.slice(0, start) + replacement + contents.slice(end);
      }
      return { contents, count: edits.length };
    },
    finalize({ metafile, embeddedPaths = {} } = {}) {
      const graph = typeof metafile === "string" ? JSON.parse(metafile) : metafile;
      for (const filename of Object.keys(graph?.inputs ?? {})) {
        const absolute = path.isAbsolute(filename) ? filename : path.resolve(filename);
        if (fs.existsSync(absolute)) {
          const canonical = fs.realpathSync(absolute);
          if (!contained(canonical)) {
            continue;
          }
          const owner = ownerOf(canonical);
          if (owner) {
            observed.add(owner);
          }
        }
      }
      const retained = new Set([...observed, ...runtimeReferenced]);
      for (const owner of retained) {
        if (!owner.relocate) {
          continue;
        }
        for (const dependency of owner.dependencies.values()) {
          if (dependency.resources.length) {
            retained.add(dependency);
          }
        }
      }
      // Doctor inspects declared plugin dependencies before their runtime is loaded.
      const metadataOwners = new Set([...retained, ...declaredPluginDependencies]);
      const files = [];
      for (const owner of metadataOwners) {
        if (!owner.relocate) {
          continue;
        }
        files.push({
          source: `${owner.original}/package.json`,
          destination: `${owner.destination}/package.json`,
          category: "dependencyMetadata",
        });
        if (!retained.has(owner)) {
          continue;
        }
        files.push(...owner.resources);
        for (const name of fs.readdirSync(owner.directory)) {
          if (LICENSE.test(name) && fs.statSync(path.join(owner.directory, name)).isFile()) {
            files.push({
              source: relative(fs.realpathSync(path.join(owner.directory, name))),
              destination: `${owner.destination}/${name}`,
              category: "dependencyLicenses",
            });
          }
        }
      }
      for (const file of files) {
        if (/\.[cm]?js$/.test(file.source) && Object.hasOwn(embeddedPaths, file.source)) {
          throw new Error(`Standalone resource is already embedded: ${file.source}`);
        }
      }
      const emittedFiles = new Map();
      const contentHashes = new Map();
      const contentHash = (source) => {
        if (!contentHashes.has(source)) {
          contentHashes.set(
            source,
            createHash("sha256")
              .update(fs.readFileSync(path.join(runtimeRoot, source)))
              .digest("hex"),
          );
        }
        return contentHashes.get(source);
      };
      for (const file of files) {
        const previous = emittedFiles.get(file.destination);
        if (previous) {
          if (
            previous.category !== file.category ||
            contentHash(previous.source) !== contentHash(file.source)
          ) {
            throw new Error(
              `Conflicting standalone resource ${file.destination}: ${previous.source} and ${file.source}`,
            );
          }
          previous.sources ??= [previous.source];
          previous.sources.push(file.source);
        } else {
          emittedFiles.set(file.destination, file);
        }
      }
      const retainedByDirectory = new Map(
        [...metadataOwners].map((owner) => [owner.directory, owner]),
      );
      // Flattened root chunks can use graph-retained hoisted packages without a production
      // declaration. Preserve their installed name/version mapping without retaining more files.
      const rootVisibleNames = new Set();
      const rootOwner = packages.get(runtimeRoot);
      for (const search of packageSearchPaths(rootOwner)) {
        if (!contained(search) || !fs.existsSync(search)) {
          continue;
        }
        for (const entry of fs.readdirSync(search, { withFileTypes: true })) {
          if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) {
            continue;
          }
          if (entry.name.startsWith("@")) {
            for (const scoped of fs.readdirSync(path.join(search, entry.name))) {
              rootVisibleNames.add(`${entry.name}/${scoped}`);
            }
          } else {
            rootVisibleNames.add(entry.name);
          }
        }
      }
      function resolutionDependencies(owner) {
        const dependencies = new Map([[owner.manifest.name, owner], ...owner.dependencies]);
        const additionalNames =
          owner === rootOwner
            ? rootVisibleNames
            : Object.keys(owner.manifest.peerDependencies ?? {});
        for (const name of additionalNames) {
          if (dependencies.has(name)) {
            continue;
          }
          for (const search of packageSearchPaths(owner)) {
            if (!contained(search)) {
              continue;
            }
            const manifest = path.join(search, name, "package.json");
            if (!fs.existsSync(manifest)) {
              continue;
            }
            const dependency = retainedByDirectory.get(fs.realpathSync(path.dirname(manifest)));
            if (dependency) {
              dependencies.set(name, dependency);
            }
            break;
          }
        }
        return dependencies;
      }
      const owners = [...metadataOwners]
        .map((owner) => ({
          original: owner.original,
          destination: owner.destination,
          dependencies: Object.fromEntries(
            [...resolutionDependencies(owner)].map(([name, dependency]) => {
              const entries = {};
              const subpaths = Object.keys(dependency.manifest.exports ?? {}).filter(
                (key) => key.startsWith("./") && !key.includes("*"),
              );
              // Public export names need not match filenames (fs-safe's secure-temp-root
              // exports dist/secure-temp-dir.js). Capture Node's resolution before pruning.
              for (const specifier of [name, ...subpaths.map((key) => name + key.slice(1))]) {
                try {
                  const resolved = owner.require.resolve(specifier);
                  if (path.isAbsolute(resolved) && contained(resolved)) {
                    entries[specifier] = relative(resolved);
                  }
                } catch {
                  /* Optional packages and import-only exports may have no require entry. */
                }
              }
              return [name, { original: dependency.original, entries }];
            }),
          ),
        }))
        .toSorted((a, b) => b.original.length - a.original.length);
      const table = {
        owners,
        // Hoisted copies share emitted bytes but retain every original resolution path.
        files: Object.fromEntries(files.map((file) => [file.source, file.destination])),
        embedded: embeddedPaths,
      };
      return {
        files: [...emittedFiles.values()],
        bootstrapReplacement: {
          search: JSON.stringify(TABLE_MARKER),
          replacement: JSON.stringify(table),
        },
      };
    },
  };
}
