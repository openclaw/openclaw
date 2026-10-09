import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Validate the tooling installation before executing its parser or native compiler. */
export async function createTrustedNativeTypeScriptParser(toolingRoot) {
  const tooling = realpathSync(toolingRoot);
  const modules = join(tooling, "node_modules");
  if (realpathSync(modules) !== modules) {
    throw new Error("borrowed parser installation");
  }
  const manifest = JSON.parse(readFileSync(join(tooling, "package.json"), "utf8"));
  const pin = manifest.devDependencies?.typescript;
  if (
    typeof pin !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(pin)
  ) {
    throw new Error("parser is not pinned");
  }
  const lock = readFileSync(join(tooling, "pnpm-lock.yaml"), "utf8");
  const rootImporters = [...lock.matchAll(/^ {2}\.:\n((?: {4}.*\n|\n)*)/gm)];
  const developmentSections = rootImporters.flatMap((entry) =>
    Array.from(entry[1].matchAll(/^ {4}devDependencies:\n((?: {6}.*\n|\n)*)/gm)),
  );
  const lockedPins = developmentSections.flatMap((entry) =>
    Array.from(
      entry[1].matchAll(/^ {6}typescript:\n {8}specifier: ([^\n]+)\n {8}version: ([^\n]+)\n/gm),
    ),
  );
  if (
    developmentSections.length !== 1 ||
    lockedPins.length !== 1 ||
    lockedPins[0][1] !== pin ||
    lockedPins[0][2] !== pin
  ) {
    throw new Error("parser lock does not match");
  }
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const assertLockedPackage = (name) => {
    const key = name.startsWith("@") ? `'${name}@${pin}'` : `${name}@${pin}`;
    const entry = new RegExp(
      `^  ${escape(key)}:\\n    resolution: \\{integrity: sha512-[A-Za-z0-9+/=]+\\}`,
      "gm",
    );
    if ([...lock.matchAll(entry)].length !== 1) {
      throw new Error(`parser package lock does not match: ${name}`);
    }
  };
  const ownedPackage = (metadataPath, name) => {
    const resolvedMetadata = realpathSync(metadataPath);
    const packageRoot = dirname(resolvedMetadata);
    const ownedRoots = [
      join(modules, name),
      join(modules, ".pnpm", `${name.replaceAll("/", "+")}@${pin}`, "node_modules", name),
    ];
    if (
      !ownedRoots.includes(packageRoot) ||
      resolvedMetadata !== join(packageRoot, "package.json")
    ) {
      throw new Error(`parser package is outside trusted tooling: ${name}`);
    }
    const metadata = JSON.parse(readFileSync(resolvedMetadata, "utf8"));
    if (metadata.name !== name || metadata.version !== pin) {
      throw new Error(`parser package metadata does not match: ${name}`);
    }
    assertLockedPackage(name);
    return { packageRoot, metadata };
  };

  const require = createRequire(join(tooling, "package.json"));
  const { packageRoot, metadata } = ownedPackage(
    require.resolve("typescript/package.json"),
    "typescript",
  );
  const helperPath = join(tooling, "scripts/lib/native-typescript.mts");
  if (realpathSync(helperPath) !== helperPath) {
    throw new Error("native parser helper is outside trusted tooling");
  }
  const helperRequire = createRequire(helperPath);
  if (
    realpathSync(helperRequire.resolve("typescript/package.json")) !==
    join(packageRoot, "package.json")
  ) {
    throw new Error("parser package is outside trusted tooling: typescript");
  }
  const entries = [
    ["typescript/unstable/sync", "dist/api/sync/api.js"],
    ["typescript/unstable/fs", "dist/api/fs.js"],
    ["typescript/unstable/ast", "dist/ast/index.js"],
  ];
  for (const [specifier, relativePath] of entries) {
    if (
      realpathSync(require.resolve(specifier)) !== join(packageRoot, relativePath) ||
      realpathSync(helperRequire.resolve(specifier)) !== join(packageRoot, relativePath)
    ) {
      throw new Error(`parser entry does not match: ${specifier}`);
    }
  }
  const platformName = `@typescript/typescript-${process.platform}-${process.arch}`;
  if (metadata.optionalDependencies?.[platformName] !== pin) {
    throw new Error("native parser dependency does not match");
  }
  const parserRequire = createRequire(join(packageRoot, "package.json"));
  const platform = ownedPackage(
    parserRequire.resolve(`${platformName}/package.json`),
    platformName,
  );
  if (
    platform.metadata.os?.length !== 1 ||
    platform.metadata.os[0] !== process.platform ||
    platform.metadata.cpu?.length !== 1 ||
    platform.metadata.cpu[0] !== process.arch
  ) {
    throw new Error("native parser platform does not match");
  }
  const tsserverPath = join(
    platform.packageRoot,
    "lib",
    process.platform === "win32" ? "tsc.exe" : "tsc",
  );
  if (realpathSync(tsserverPath) !== tsserverPath || !statSync(tsserverPath).isFile()) {
    throw new Error("native parser executable is outside trusted tooling");
  }
  accessSync(tsserverPath, constants.X_OK);

  // All package and executable admission checks precede the first dependency import.
  const { createNativeTypeScriptParser } = await import(pathToFileURL(helperPath));
  const ast = await import(pathToFileURL(join(packageRoot, "dist/ast/index.js")));
  return { parser: createNativeTypeScriptParser({ cwd: tooling, tsserverPath }), ast };
}
