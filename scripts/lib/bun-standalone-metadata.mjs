import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function visit(node, callback, owner) {
  if (!node || typeof node !== "object") {
    return;
  }
  const current = /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(
    node.type,
  )
    ? node
    : owner;
  callback(node, current);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      value.forEach((child) => visit(child, callback, current));
    } else if (value && typeof value === "object") {
      visit(value, callback, current);
    }
  }
}

function property(node, name) {
  return node?.type === "ObjectExpression"
    ? node.properties.find((entry) => (entry.key?.name ?? entry.key?.value) === name)?.value
    : undefined;
}

/** Keep metadata reads on their existing owners; only immutable image bytes become build facts. */
export function createStandaloneMetadataAdapter({ runtimeRoot, embeddedPaths, parse }) {
  const doctor = {};
  const sdk = {};
  const exportsByFile = new Map();
  // Split worker bundles shorten import locals while retaining their owners in export metadata.
  const resolvesTo = (callee, expected, ast, filename) => {
    if (callee?.type !== "Identifier") {
      return false;
    }
    if (callee.name === expected) {
      return true;
    }
    for (const statement of ast.body) {
      if (statement.type !== "ImportDeclaration" || !statement.source.value.startsWith(".")) {
        continue;
      }
      const imported = statement.specifiers.find(
        (specifier) => specifier.type === "ImportSpecifier" && specifier.local.name === callee.name,
      );
      if (!imported || !filename) {
        continue;
      }
      const target = path.resolve(path.dirname(filename), statement.source.value);
      let exports = exportsByFile.get(target);
      if (!exports) {
        exports = new Map();
        const targetAst = parse(fs.readFileSync(target, "utf8"), {
          ecmaVersion: "latest",
          sourceType: "module",
        });
        for (const node of targetAst.body) {
          if (node.type === "ExportNamedDeclaration" && !node.source) {
            for (const specifier of node.specifiers) {
              exports.set(
                specifier.exported.name ?? specifier.exported.value,
                specifier.local.name,
              );
            }
          }
        }
        exportsByFile.set(target, exports);
      }
      return exports.get(imported.imported.name ?? imported.imported.value) === expected;
    }
    return false;
  };
  const sdkOwner = fs
    .readdirSync(path.join(runtimeRoot, "dist"))
    .find((name) => /^sdk-alias-.*\.[cm]?js$/.test(name));
  if (!sdkOwner) {
    throw new Error("Missing standalone SDK dependency scanner");
  }
  const scannerSource = fs.readFileSync(path.join(runtimeRoot, "dist", sdkOwner), "utf8");
  let dependencyPattern;
  visit(parse(scannerSource, { ecmaVersion: "latest", sourceType: "module" }), (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id.name === "JS_STATIC_RELATIVE_DEPENDENCY_PATTERN"
    ) {
      dependencyPattern = node.init?.value;
    }
  });
  if (!(dependencyPattern instanceof RegExp)) {
    throw new Error("Unsupported SDK dependency scanner");
  }
  for (const entry of Object.keys(embeddedPaths).toSorted()) {
    if (
      /^dist(?:-runtime)?\/extensions\/[^/]+\/(?:dist\/)?(?:doctor-contract-api|contract-api)\.[cm]?js$/.test(
        entry,
      )
    ) {
      const bytes = fs.readFileSync(path.join(runtimeRoot, entry));
      doctor[entry] = {
        hash: createHash("sha256").update(bytes).digest("hex"),
        // Preserve the generic metadata cache's real contents contract for any subsequent reader.
        bytes: bytes.toString("base64"),
      };
    }
    if (!/^dist(?:-runtime)?\/plugin-sdk\/.+\.[cm]?js$/.test(entry)) {
      continue;
    }
    const contents = fs.readFileSync(path.join(runtimeRoot, entry), "utf8");
    const assets = [];
    let complete = true;
    for (const match of contents.matchAll(dependencyPattern)) {
      const target = path.resolve(runtimeRoot, path.dirname(entry), match[1]);
      if (!fs.existsSync(target)) {
        complete = false;
        continue;
      }
      const relative = path
        .relative(runtimeRoot, fs.realpathSync(target))
        .split(path.sep)
        .join("/");
      if (/\.[cm]?js$/.test(target)) {
        if (!Object.hasOwn(embeddedPaths, relative)) {
          throw new Error(`SDK dependency missing from image: ${entry} -> ${relative}`);
        }
      } else {
        assets.push(relative);
      }
    }
    sdk[entry] = {
      complete,
      assets: [...new Set(assets)].toSorted((left, right) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    };
  }
  if (!Object.keys(doctor).length || !Object.keys(sdk).length) {
    throw new Error("Missing standalone Doctor or SDK metadata facts");
  }
  const bootstrap = `(() => {
  const doctor = ${JSON.stringify(doctor)};
  const sdk = ${JSON.stringify(sdk)};
  const relative = (filename) => typeof filename === "string" && path.isAbsolute(filename)
    ? path.relative(root, filename).split(path.sep).join("/") : undefined;
  const get = (table, filename) => {
    const key = relative(filename);
    return Object.hasOwn(table, key) ? table[key] : undefined;
  };
  globalThis.__openclawStandaloneDoctorHash = (filename) => get(doctor, filename)?.hash;
  globalThis.__openclawStandaloneDoctorBytes = (filename) => {
    const fact = get(doctor, filename);
    return fact ? Buffer.from(fact.bytes, "base64") : undefined;
  };
  globalThis.__openclawStandaloneSdkComplete = (filename, exists) => {
    const fact = get(sdk, filename);
    return fact ? fact.complete && fact.assets.every((asset) => exists(path.join(root, asset))) : undefined;
  };
})();\n`;
  return {
    bootstrap,
    facts: { doctor, sdk },
    transform({ filename, contents }) {
      if (!/capturedPluginFile|checkDistPluginSdkArtifact|fileContentMatches/.test(contents)) {
        return { contents, count: 0 };
      }
      const ast = parse(contents, { ecmaVersion: "latest", sourceType: "module" });
      const edits = [];
      const slice = (node) => contents.slice(node.start, node.end);
      const readSources = new Map();
      visit(ast, (node, owner) => {
        if (
          owner?.id?.name === "readPluginCacheFile" &&
          node.type === "CallExpression" &&
          node.callee.name === "capturedPluginFile" &&
          node.arguments.length === 4 &&
          node.arguments[0].type === "MemberExpression" &&
          node.arguments[2].type === "Identifier"
        ) {
          if (readSources.has(owner)) {
            throw new Error("Ambiguous plugin metadata content capture");
          }
          readSources.set(owner, { binding: node.arguments[2].name, filename: node.arguments[0] });
        }
      });
      const adaptedOwners = new Set();
      const reads = new Set();
      visit(ast, (node, owner) => {
        if (owner?.id?.name === "capturedPluginFile" && node.type === "ObjectExpression") {
          const hash = property(node, "hash");
          if (hash && owner.params[0]?.type === "Identifier") {
            edits.push([
              hash.start,
              hash.end,
              `(globalThis.__openclawStandaloneDoctorHash(${slice(owner.params[0])}) ?? ${slice(hash)})`,
            ]);
            adaptedOwners.add(owner);
          }
        }
        if (
          owner?.id?.name === "readPluginCacheFile" &&
          node.type === "VariableDeclarator" &&
          node.id.name === readSources.get(owner)?.binding
        ) {
          const source = readSources.get(owner);
          let readsDescriptor = false;
          visit(node.init, (expression) => {
            if (
              expression.type === "MemberExpression" &&
              !expression.computed &&
              expression.property.name === "fd" &&
              slice(expression.object) === slice(source.filename.object)
            ) {
              readsDescriptor = true;
            }
          });
          // Minified blocks reuse local names; only the admitted descriptor's read owns these bytes.
          if (!readsDescriptor) {
            return;
          }
          if (reads.has(owner)) {
            throw new Error("Ambiguous plugin metadata descriptor read");
          }
          reads.add(owner);
          // The original safe-open, bounded admission, close and cache lifetime remain intact.
          edits.push([
            node.init.start,
            node.init.end,
            `(globalThis.__openclawStandaloneDoctorBytes(${slice(source.filename)}) ?? (${slice(node.init)}))`,
          ]);
          adaptedOwners.add(owner);
        }
        if (node.type !== "FunctionDeclaration") {
          return;
        }
        if (node.id?.name === "checkDistPluginSdkArtifact") {
          const first = node.body.body[0];
          const exists =
            first.test?.type === "UnaryExpression" && first.test.operator === "!"
              ? first.test.argument
              : undefined;
          if (
            first.type !== "IfStatement" ||
            node.params[0]?.type !== "Identifier" ||
            exists?.type !== "CallExpression" ||
            exists.arguments.length !== 1 ||
            slice(exists.arguments[0]) !== slice(node.params[0]) ||
            !resolvesTo(exists.callee, "pluginCacheExistsSync", ast, filename)
          ) {
            throw new Error("Unsupported SDK artifact existence check");
          }
          edits.push([
            first.end,
            first.end,
            `\nconst __imageComplete = globalThis.__openclawStandaloneSdkComplete(${slice(node.params[0])}, ${slice(exists.callee)});\nif (__imageComplete !== undefined) return __imageComplete;\n`,
          ]);
          adaptedOwners.add(node);
        }
        if (node.id?.name === "fileContentMatches") {
          const declaration = node.body.body.find(
            (statement) =>
              statement.type === "VariableDeclaration" &&
              statement.declarations.some(
                (entry) =>
                  entry.init?.type === "CallExpression" &&
                  entry.init.arguments.length === 1 &&
                  slice(entry.init.arguments[0]) === slice(node.params[0]) &&
                  resolvesTo(entry.init.callee, "safeFileSignature", ast, filename),
              ),
          );
          const current = declaration?.declarations.find(
            (entry) =>
              entry.init?.type === "CallExpression" &&
              entry.init.arguments.length === 1 &&
              slice(entry.init.arguments[0]) === slice(node.params[0]) &&
              resolvesTo(entry.init.callee, "safeFileSignature", ast, filename),
          );
          if (
            !current ||
            current.id.type !== "Identifier" ||
            node.params.slice(0, 2).some((param) => param.type !== "Identifier")
          ) {
            throw new Error("Unsupported plugin metadata freshness check");
          }
          // Test the image hash before the physical-signature shortcut, including image replacement.
          edits.push([
            declaration.end,
            declaration.end,
            `\nconst __imageHash = globalThis.__openclawStandaloneDoctorHash(${slice(node.params[0])});\nif (__imageHash !== undefined) return Boolean(${slice(current.id)}) && __imageHash === ${slice(node.params[1])};\n`,
          ]);
          adaptedOwners.add(node);
        }
      });
      visit(ast, (node) => {
        if (
          node.type === "FunctionDeclaration" &&
          [
            "capturedPluginFile",
            "readPluginCacheFile",
            "fileContentMatches",
            "checkDistPluginSdkArtifact",
          ].includes(node.id?.name) &&
          !adaptedOwners.has(node)
        ) {
          throw new Error(`Unsupported standalone metadata owner: ${node.id.name}`);
        }
      });
      let transformed = contents;
      for (const [start, end, replacement] of edits.toSorted((a, b) => b[0] - a[0])) {
        transformed = transformed.slice(0, start) + replacement + transformed.slice(end);
      }
      return { contents: transformed, count: edits.length };
    },
  };
}
