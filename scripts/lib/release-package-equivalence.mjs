import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { t as listTar, x as extractTar } from "tar";
import ts from "typescript";
import { extractCurrentPackageChangelog } from "../package-changelog.mjs";

const ASSET_DIR = "dist/control-ui/assets";
const ASSET_NAME_RE = /^(.*)-([A-Za-z0-9_-]{8})(\.[^.]+)$/u;
const SHA_RE = /^[0-9a-f]{40}$/u;
const BETA_VERSION_RE = /^\d{4}\.\d+\.\d+-beta\.\d+$/u;
const TRUSTED_RELEASE_DOC_PATHS = [
  "docs/ci.md",
  "docs/reference/RELEASING.md",
  "docs/reference/full-release-validation.md",
];

function fail(message) {
  throw new Error(`Release package equivalence failed: ${message}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .toSorted((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseJson(buffer, relativePath) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    return fail(`${relativePath} is not valid JSON: ${error.message}`);
  }
}

function assertIsoTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    new Date(value).toISOString() !== value
  ) {
    fail(`${label} must be a canonical ISO timestamp`);
  }
}

function assertReleaseSha(value, label) {
  if (typeof value !== "string" || !SHA_RE.test(value)) {
    fail(`${label} must be a 40-character lowercase Git SHA`);
  }
}

async function extractTarball(tarball, destination) {
  const seen = new Set();
  let invalidEntry;
  try {
    await listTar({
      file: tarball,
      gzip: true,
      strict: true,
      onentry(entry) {
        if (invalidEntry) {
          return;
        }
        const entryPath = entry.path;
        const normalized = path.posix.normalize(entryPath);
        const collisionKey = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
        if (
          entryPath !== normalized ||
          (normalized !== "package" &&
            normalized !== "package/" &&
            !normalized.startsWith("package/")) ||
          path.posix.isAbsolute(entryPath) ||
          entryPath.includes("\\")
        ) {
          invalidEntry = `unsafe archive path ${JSON.stringify(entryPath)}`;
          return;
        }
        if (seen.has(collisionKey)) {
          invalidEntry = `duplicate archive path ${JSON.stringify(collisionKey)}`;
          return;
        }
        if (entry.type !== "File" && entry.type !== "Directory") {
          invalidEntry = "link or special archive member";
          return;
        }
        if (((entry.mode ?? 0) & 0o7000) !== 0) {
          invalidEntry = "special permission bits";
          return;
        }
        seen.add(collisionKey);
      },
    });
  } catch (error) {
    fail(`cannot list ${tarball}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (invalidEntry) {
    fail(`${tarball} contains ${invalidEntry}`);
  }
  if (seen.size === 0) {
    fail(`${tarball} is empty`);
  }
  try {
    await extractTar({
      file: tarball,
      cwd: destination,
      gzip: true,
      strict: true,
      preserveOwner: false,
    });
  } catch (error) {
    fail(`cannot extract ${tarball}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const packageRoot = path.join(destination, "package");
  const stat = await fs.lstat(packageRoot).catch(() => null);
  if (!stat?.isDirectory()) {
    fail(`${tarball} does not contain a package directory`);
  }
  return packageRoot;
}

async function collectInventory(root) {
  const entries = new Map();

  async function visit(directory) {
    const children = (await fs.readdir(directory, { withFileTypes: true })).toSorted(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const child of children) {
      const absolutePath = path.join(directory, child.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      const stat = await fs.lstat(absolutePath);
      const mode = stat.mode & 0o777;
      if (child.isDirectory()) {
        entries.set(relativePath, { type: "directory", mode });
        await visit(absolutePath);
      } else if (child.isFile()) {
        const content = await fs.readFile(absolutePath);
        entries.set(relativePath, {
          type: "file",
          mode,
          content,
          sha256: sha256(content),
        });
      } else {
        fail(`${relativePath} has unsupported archive entry type`);
      }
    }
  }

  await visit(root);
  return entries;
}

function rawChangedPaths(source, target) {
  const paths = new Set([...source.keys(), ...target.keys()]);
  return [...paths]
    .filter((relativePath) => {
      const left = source.get(relativePath);
      const right = target.get(relativePath);
      return (
        !left ||
        !right ||
        left.type !== right.type ||
        left.mode !== right.mode ||
        left.sha256 !== right.sha256
      );
    })
    .toSorted((left, right) => left.localeCompare(right));
}

function assetKey(fileName) {
  const match = fileName.match(ASSET_NAME_RE);
  if (!match) {
    fail(`Control UI delta file is not a content-hashed asset: ${fileName}`);
  }
  return `${match[1]}${match[3]}`;
}

function buildAssetMaps(source, target) {
  const sourceAssets = new Set(
    [...source.keys()]
      .filter((entry) => entry.startsWith(`${ASSET_DIR}/`) && source.get(entry).type === "file")
      .map((entry) => path.posix.basename(entry)),
  );
  const targetAssets = new Set(
    [...target.keys()]
      .filter((entry) => entry.startsWith(`${ASSET_DIR}/`) && target.get(entry).type === "file")
      .map((entry) => path.posix.basename(entry)),
  );
  const sourceOnly = [...sourceAssets].filter((name) => !targetAssets.has(name));
  const targetOnly = [...targetAssets].filter((name) => !sourceAssets.has(name));
  const sourceByKey = new Map();
  const targetByKey = new Map();

  for (const name of sourceOnly) {
    const key = assetKey(name);
    if (sourceByKey.has(key)) {
      fail(`source Control UI has multiple renamed assets for ${key}`);
    }
    sourceByKey.set(key, name);
  }
  for (const name of targetOnly) {
    const key = assetKey(name);
    if (targetByKey.has(key)) {
      fail(`target Control UI has multiple renamed assets for ${key}`);
    }
    targetByKey.set(key, name);
  }
  const sourceKeys = [...sourceByKey.keys()].toSorted((left, right) => left.localeCompare(right));
  const targetKeys = [...targetByKey.keys()].toSorted((left, right) => left.localeCompare(right));
  if (stableJson(sourceKeys) !== stableJson(targetKeys)) {
    fail("Control UI content-hash asset sets do not match");
  }

  const sourceNames = new Map();
  const targetNames = new Map();
  const sourcePaths = new Map();
  const targetPaths = new Map();
  for (const key of sourceKeys) {
    const sourceName = sourceByKey.get(key);
    const targetName = targetByKey.get(key);
    const canonicalName = `<asset:${key}>`;
    const canonicalPath = `${ASSET_DIR}/${canonicalName}`;
    sourceNames.set(sourceName, canonicalName);
    targetNames.set(targetName, canonicalName);
    sourcePaths.set(`${ASSET_DIR}/${sourceName}`, canonicalPath);
    targetPaths.set(`${ASSET_DIR}/${targetName}`, canonicalPath);
  }
  return {
    renamedCount: sourceByKey.size,
    sourceNames,
    targetNames,
    sourcePaths,
    targetPaths,
  };
}

function normalizeAssetReferences(content, names) {
  let normalized = content.toString("utf8");
  if (!Buffer.from(normalized).equals(content)) {
    fail("changed Control UI text is not valid UTF-8");
  }
  const replacements = [...names.entries()].toSorted(
    ([left], [right]) => right.length - left.length || left.localeCompare(right),
  );
  for (const [fileName, canonicalName] of replacements) {
    normalized = normalized.replaceAll(fileName, canonicalName);
  }
  return normalized;
}

function parseBuildInfo(entry, expectedSha, expectedVersion, side) {
  if (!entry || entry.type !== "file") {
    fail(`${side} package is missing dist/build-info.json`);
  }
  const value = parseJson(entry.content, "dist/build-info.json");
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    stableJson(Object.keys(value).toSorted((left, right) => left.localeCompare(right))) !==
      stableJson(["builtAt", "commit", "version"])
  ) {
    fail(`${side} dist/build-info.json has an unsupported shape`);
  }
  if (value.commit !== expectedSha) {
    fail(`${side} dist/build-info.json commit does not match ${expectedSha}`);
  }
  if (value.version !== expectedVersion) {
    fail(`${side} dist/build-info.json version does not match ${expectedVersion}`);
  }
  assertIsoTimestamp(value.builtAt, `${side} dist/build-info.json builtAt`);
  return value;
}

function assertPackageVersion(entry, expectedVersion, side) {
  if (!entry || entry.type !== "file") {
    fail(`${side} package is missing package.json`);
  }
  const value = parseJson(entry.content, "package.json");
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.name !== "openclaw" ||
    value.version !== expectedVersion
  ) {
    fail(`${side} package.json must identify openclaw@${expectedVersion}`);
  }
}

function normalizeHelpMetadata(content, sha, side) {
  const metadata = parseJson(content, "dist/cli-startup-metadata.json");
  const marker = `(${sha.slice(0, 7)})`;
  let helpCount = 0;

  function visit(value, inHelpText, label) {
    if (typeof value === "string") {
      if (!inHelpText) {
        return value;
      }
      const occurrences = value.split(marker).length - 1;
      if (occurrences !== 1) {
        fail(`${side} ${label} must contain exactly one ${marker} identity`);
      }
      helpCount += 1;
      return value.replace(marker, "(<release-commit>)");
    }
    if (Array.isArray(value)) {
      if (inHelpText) {
        fail(`${side} ${label} has unsupported help metadata`);
      }
      return value.map((item, index) => visit(item, false, `${label}[${index}]`));
    }
    if (value && typeof value === "object") {
      const output = {};
      for (const key of Object.keys(value).toSorted((left, right) => left.localeCompare(right))) {
        output[key] = visit(
          value[key],
          inHelpText || key.endsWith("HelpText"),
          label ? `${label}.${key}` : key,
        );
      }
      return output;
    }
    if (inHelpText) {
      fail(`${side} ${label} has unsupported help metadata`);
    }
    return value;
  }

  const normalized = visit(metadata, false, "");
  if (helpCount === 0) {
    fail(`${side} CLI metadata has no help text identities`);
  }
  return Buffer.from(`${stableJson(normalized)}\n`);
}

function canonicalizeDeclaration(content, relativePath) {
  const sourceFile = ts.createSourceFile(
    relativePath,
    content.toString("utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    fail(`${relativePath} has TypeScript parse errors`);
  }
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const transformer = (context) => {
    const visit = (node) => {
      const visited = ts.visitEachChild(node, visit, context);
      if (ts.isUnionTypeNode(visited)) {
        const types = [...visited.types].toSorted((left, right) =>
          printer
            .printNode(ts.EmitHint.Unspecified, left, sourceFile)
            .localeCompare(printer.printNode(ts.EmitHint.Unspecified, right, sourceFile)),
        );
        return ts.factory.updateUnionTypeNode(visited, types);
      }
      if (
        ts.isTypeLiteralNode(visited) &&
        visited.members.every((member) => ts.isPropertySignature(member))
      ) {
        const members = [...visited.members].toSorted((left, right) =>
          printer
            .printNode(ts.EmitHint.Unspecified, left, sourceFile)
            .localeCompare(printer.printNode(ts.EmitHint.Unspecified, right, sourceFile)),
        );
        return ts.factory.updateTypeLiteralNode(visited, members);
      }
      return visited;
    };
    return (root) => ts.visitNode(root, visit);
  };
  const result = ts.transform(sourceFile, [transformer]);
  try {
    return Buffer.from(printer.printFile(result.transformed[0]));
  } finally {
    result.dispose();
  }
}

function normalizeBoundaryStamp(content, side) {
  const value = content.toString("utf8").trim();
  assertIsoTimestamp(value, `${side} plugin SDK boundary stamp`);
  return Buffer.from("<boundary-generated-at>\n");
}

function normalizeControlUi(content, relativePath, context) {
  let normalized = normalizeAssetReferences(content, context.assetNames);
  const ownCommit = context.sha.slice(0, 12);
  if (relativePath === "dist/control-ui/sw.js") {
    const expected = `${context.version}-${ownCommit}`;
    if (normalized.split(expected).length - 1 !== 1) {
      fail(`${context.side} Control UI service worker must contain exactly one ${expected}`);
    }
    normalized = normalized.replace(expected, `${context.version}-<release-commit>`);
  } else {
    normalized = normalized.replaceAll(ownCommit, "<release-commit>");
  }
  return Buffer.from(normalized);
}

function normalizePostinstallInventory(content, pathMap, side) {
  const inventory = parseJson(content, "dist/postinstall-inventory.json");
  if (!Array.isArray(inventory) || inventory.some((entry) => typeof entry !== "string")) {
    fail(`${side} dist/postinstall-inventory.json must be an array of paths`);
  }
  const normalized = inventory
    .map((entry) => pathMap.get(entry) ?? entry)
    .toSorted((left, right) => left.localeCompare(right));
  if (new Set(normalized).size !== normalized.length) {
    fail(`${side} postinstall inventory has duplicate canonical paths`);
  }
  return Buffer.from(`${stableJson(normalized)}\n`);
}

function canonicalContent(entry, relativePath, context) {
  if (relativePath === "CHANGELOG.md") {
    return Buffer.from("<trusted-changelog>\n");
  }
  if (context.trustedFiles.has(relativePath)) {
    return Buffer.from(`<trusted-git-file:${relativePath}>\n`);
  }
  if (relativePath === "dist/build-info.json") {
    return Buffer.from(
      `${stableJson({
        version: context.version,
        commit: "<release-commit>",
        builtAt: "<built-at>",
      })}\n`,
    );
  }
  if (relativePath === "dist/cli-startup-metadata.json") {
    return normalizeHelpMetadata(entry.content, context.sha, context.side);
  }
  if (relativePath === "dist/plugin-sdk/.boundary-entry-shims.stamp") {
    return normalizeBoundaryStamp(entry.content, context.side);
  }
  if (relativePath === "dist/postinstall-inventory.json") {
    return normalizePostinstallInventory(entry.content, context.assetPaths, context.side);
  }
  if (relativePath.startsWith("dist/control-ui/")) {
    if (!context.rawChanged.has(relativePath)) {
      return entry.content;
    }
    if (!relativePath.endsWith(".js") && !relativePath.endsWith(".html")) {
      fail(`${context.side} package has unsupported changed Control UI path ${relativePath}`);
    }
    return normalizeControlUi(entry.content, relativePath, context);
  }
  if (relativePath.endsWith(".d.ts") && context.rawChanged.has(relativePath)) {
    return canonicalizeDeclaration(entry.content, relativePath);
  }
  return entry.content;
}

function canonicalInventory(inventory, context) {
  const canonical = new Map();
  for (const [relativePath, entry] of inventory) {
    const canonicalPath = context.assetPaths.get(relativePath) ?? relativePath;
    if (canonical.has(canonicalPath)) {
      fail(`${context.side} package has duplicate canonical path ${canonicalPath}`);
    }
    canonical.set(canonicalPath, {
      path: canonicalPath,
      type: entry.type,
      mode: entry.mode,
      ...(entry.type === "file"
        ? { sha256: sha256(canonicalContent(entry, relativePath, context)) }
        : {}),
    });
  }
  return [...canonical.values()].toSorted((left, right) => left.path.localeCompare(right.path));
}

function canonicalMismatchPaths(source, target) {
  const sourceByPath = new Map(source.map((entry) => [entry.path, stableJson(entry)]));
  const targetByPath = new Map(target.map((entry) => [entry.path, stableJson(entry)]));
  return [...new Set([...sourceByPath.keys(), ...targetByPath.keys()])]
    .filter((relativePath) => sourceByPath.get(relativePath) !== targetByPath.get(relativePath))
    .toSorted((left, right) => left.localeCompare(right));
}

function assertTrustedChangelog(entry, rawTrustedContent, expectedVersion, side) {
  if (!entry || entry.type !== "file") {
    fail(`${side} package is missing CHANGELOG.md`);
  }
  if (!Buffer.isBuffer(rawTrustedContent) && typeof rawTrustedContent !== "string") {
    fail(`${side} trusted changelog must be a string or Buffer`);
  }
  const raw = Buffer.isBuffer(rawTrustedContent)
    ? rawTrustedContent.toString("utf8")
    : rawTrustedContent;
  let trusted;
  try {
    trusted = Buffer.from(extractCurrentPackageChangelog(raw, expectedVersion), "utf8");
  } catch (error) {
    fail(`${side} trusted changelog cannot be packaged: ${error.message}`);
  }
  if (!entry.content.equals(trusted)) {
    fail(`${side} package CHANGELOG.md does not match trusted changelog content`);
  }
}

export async function compareReleasePackageArtifacts({
  sourceTarball,
  targetTarball,
  sourceSha,
  targetSha,
  expectedVersion,
  sourceChangelog,
  targetChangelog,
  trustedFiles,
}) {
  assertReleaseSha(sourceSha, "sourceSha");
  assertReleaseSha(targetSha, "targetSha");
  if (typeof expectedVersion !== "string" || !BETA_VERSION_RE.test(expectedVersion)) {
    fail("expectedVersion must be a beta version");
  }
  if (
    !Array.isArray(trustedFiles) ||
    trustedFiles.some(
      (entry) =>
        !entry ||
        typeof entry.path !== "string" ||
        entry.path === "CHANGELOG.md" ||
        path.posix.isAbsolute(entry.path) ||
        entry.path.split("/").includes("..") ||
        (!Buffer.isBuffer(entry.source) && typeof entry.source !== "string") ||
        (!Buffer.isBuffer(entry.target) && typeof entry.target !== "string"),
    )
  ) {
    fail("trustedFiles must contain safe source and target git blobs");
  }
  const trustedFilePaths = trustedFiles.map((entry) => entry.path);
  if (
    new Set(trustedFilePaths).size !== trustedFilePaths.length ||
    JSON.stringify(trustedFilePaths.toSorted()) !==
      JSON.stringify(TRUSTED_RELEASE_DOC_PATHS.toSorted())
  ) {
    fail("trustedFiles must contain the exact audited release documentation set");
  }
  const raw = {
    sourceSha256: await sha256File(sourceTarball),
    targetSha256: await sha256File(targetTarball),
  };
  raw.equal = raw.sourceSha256 === raw.targetSha256;

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-package-equivalence-"));
  try {
    const sourceDir = path.join(tempRoot, "source");
    const targetDir = path.join(tempRoot, "target");
    await fs.mkdir(sourceDir);
    const sourceRoot = await extractTarball(sourceTarball, sourceDir);
    await fs.mkdir(targetDir);
    const targetRoot = await extractTarball(targetTarball, targetDir);
    const [sourceInventory, targetInventory] = await Promise.all([
      collectInventory(sourceRoot),
      collectInventory(targetRoot),
    ]);
    const changedPaths = rawChangedPaths(sourceInventory, targetInventory);
    const rawChanged = new Set(changedPaths);
    const validatedTrustedFiles = trustedFiles.map((trusted) => {
      const source = sourceInventory.get(trusted.path);
      const target = targetInventory.get(trusted.path);
      const sourceContent = Buffer.isBuffer(trusted.source)
        ? trusted.source
        : Buffer.from(trusted.source);
      const targetContent = Buffer.isBuffer(trusted.target)
        ? trusted.target
        : Buffer.from(trusted.target);
      if (
        source?.type !== "file" ||
        target?.type !== "file" ||
        !source.content.equals(sourceContent) ||
        !target.content.equals(targetContent)
      ) {
        fail(`${trusted.path} does not match its trusted source and target git blobs`);
      }
      return {
        path: trusted.path,
        sourceSha256: sha256(sourceContent),
        targetSha256: sha256(targetContent),
      };
    });
    const packagedTrustedFiles = validatedTrustedFiles.filter((trusted) =>
      rawChanged.has(trusted.path),
    );
    const trustedPathSet = new Set(packagedTrustedFiles.map((entry) => entry.path));
    const assetMaps = buildAssetMaps(sourceInventory, targetInventory);
    const canonicalInventories = [
      [
        "source",
        sourceInventory,
        sourceSha,
        sourceChangelog,
        assetMaps.sourceNames,
        assetMaps.sourcePaths,
      ],
      [
        "target",
        targetInventory,
        targetSha,
        targetChangelog,
        assetMaps.targetNames,
        assetMaps.targetPaths,
      ],
    ].map(([side, inventory, sha, changelog, assetNames, assetPaths]) => {
      const build = parseBuildInfo(
        inventory.get("dist/build-info.json"),
        sha,
        expectedVersion,
        side,
      );
      assertPackageVersion(inventory.get("package.json"), expectedVersion, side);
      assertTrustedChangelog(inventory.get("CHANGELOG.md"), changelog, expectedVersion, side);
      return canonicalInventory(inventory, {
        side,
        sha,
        version: build.version,
        assetNames,
        assetPaths,
        rawChanged,
        trustedFiles: trustedPathSet,
      });
    });
    const [sourceCanonical, targetCanonical] = canonicalInventories;
    const mismatches = canonicalMismatchPaths(sourceCanonical, targetCanonical);
    if (mismatches.length > 0) {
      fail(
        `artifacts differ outside supported rules at ${mismatches.slice(0, 12).join(", ")}${
          mismatches.length > 12 ? ` (+${mismatches.length - 12} more)` : ""
        }`,
      );
    }

    const canonical = {
      sourceSha256: sha256(stableJson(sourceCanonical)),
      targetSha256: sha256(stableJson(targetCanonical)),
    };
    canonical.equal = canonical.sourceSha256 === canonical.targetSha256;
    const controlUiChanged = changedPaths.some(
      (relativePath) =>
        relativePath === "dist/control-ui/sw.js" || relativePath.startsWith(`${ASSET_DIR}/`),
    );
    const rules = [
      ["trusted-changelog", rawChanged.has("CHANGELOG.md")],
      ...packagedTrustedFiles.map((entry) => [`trusted-git-file:${entry.path}`, true]),
      ["build-info-identity", rawChanged.has("dist/build-info.json")],
      ["cli-help-commit-identity", rawChanged.has("dist/cli-startup-metadata.json")],
      ["boundary-stamp-timestamp", rawChanged.has("dist/plugin-sdk/.boundary-entry-shims.stamp")],
      ["control-ui-content-hash-map", assetMaps.renamedCount > 0],
      ["control-ui-commit-identity", controlUiChanged],
      ["postinstall-inventory-map", rawChanged.has("dist/postinstall-inventory.json")],
      ["declaration-order", changedPaths.some((relativePath) => relativePath.endsWith(".d.ts"))],
    ]
      .filter(([, used]) => used)
      .map(([rule]) => rule);
    return {
      raw,
      canonical,
      changedPaths,
      trustedFiles: validatedTrustedFiles,
      rules,
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}
