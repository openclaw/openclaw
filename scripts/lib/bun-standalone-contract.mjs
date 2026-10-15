import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeBuildCommit } from "../write-build-info.ts";

export const STANDALONE_USAGE =
  "Usage: bun scripts/build-bun-standalone.mjs <fresh-output-directory> [--bytecode|--compile-aot]\n" +
  "Default: JIT. --compile-aot is EXPERIMENTAL and requires an AOT-capable Bun.";

export function parseStandaloneArguments(args) {
  const [outputDirectory, ...flags] = args;
  if (args.length === 1 && ["--help", "-h"].includes(outputDirectory)) {
    return { help: true };
  }
  if (!outputDirectory || outputDirectory.startsWith("-")) {
    throw new Error(STANDALONE_USAGE);
  }
  if (flags.length > 1 || flags.some((flag) => !["--bytecode", "--compile-aot"].includes(flag))) {
    throw new Error(`Choose at most one build mode.\n${STANDALONE_USAGE}`);
  }
  const mode =
    flags[0] === "--compile-aot" ? "aot" : flags[0] === "--bytecode" ? "bytecode" : "jit";
  return { outputDirectory, mode, compileFlags: flags };
}

export function assertStandaloneCompiler(mode, help) {
  if (mode === "aot" && !/(?:^|\s)--compile-aot(?:\s|=|$)/m.test(help)) {
    throw new Error(
      "EXPERIMENTAL AOT builds require a Bun compiler that supports --compile-aot. " +
        "This Bun does not support it. Use the default JIT mode or --bytecode with the production-pinned Bun; " +
        "build an AOT-capable Bun explicitly to experiment with AOT.",
    );
  }
}

export function assertStandalonePlatform(platform) {
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error("Build on macOS or Linux; Windows standalone artifacts are not supported yet.");
  }
}

export function relativeStandaloneEntry(root, filename) {
  if (typeof filename !== "string" || !path.isAbsolute(filename)) {
    return undefined;
  }
  const relative = path.relative(root, filename);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  ) {
    return undefined;
  }
  return relative.split(path.sep).join("/");
}

export function resolveStandaloneBuildIdentity(buildInfo, packageVersion) {
  if (
    !buildInfo ||
    typeof buildInfo.version !== "string" ||
    !buildInfo.version.trim() ||
    typeof buildInfo.commit !== "string"
  ) {
    throw new Error("Missing standalone runtime identity in dist/build-info.json. Run pnpm build.");
  }
  const version = buildInfo.version.trim();
  let commit;
  try {
    commit = normalizeBuildCommit(buildInfo.commit, "dist/build-info.json commit");
  } catch (error) {
    throw new Error(`${error.message} Run pnpm build.`, { cause: error });
  }
  if (typeof packageVersion !== "string" || version !== packageVersion.trim()) {
    throw new Error(
      "dist/build-info.json version does not match runtime/package.json. Run pnpm build.",
    );
  }
  return { version, commit };
}

function standaloneMacosEntitlements(mode) {
  return {
    ...(mode === "aot" ? {} : { "com.apple.security.cs.allow-jit": true }),
    "com.apple.security.cs.disable-library-validation": true,
  };
}

export async function sha256File(filename) {
  const digest = createHash("sha256");
  for await (const bytes of fs.createReadStream(filename)) {
    digest.update(bytes);
  }
  return digest.digest("hex");
}

function runtimeEntries(root, relative = "") {
  const entries = [];
  for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${item.name}` : item.name;
    if (item.isDirectory()) {
      entries.push(...runtimeEntries(root, name));
    } else if (item.isFile() || item.isSymbolicLink()) {
      entries.push({ name, symlink: item.isSymbolicLink() });
    }
  }
  return entries;
}

function assertStandaloneRuntimeLinks(root, entries) {
  const canonicalRoot = fs.realpathSync(root);
  for (const { name, symlink } of entries) {
    if (!symlink) {
      continue;
    }
    const filename = path.join(root, name);
    // Publication moves the staging tree, so even contained absolute links would break.
    if (path.isAbsolute(fs.readlinkSync(filename))) {
      throw new Error(
        `Invalid standalone runtime symlink ${name}: absolute target is not relocatable`,
      );
    }
    let target;
    try {
      target = fs.realpathSync(filename);
    } catch (error) {
      throw new Error(`Invalid standalone runtime symlink ${name}: dangling or unreadable target`, {
        cause: error,
      });
    }
    const relative = path.relative(canonicalRoot, target);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      throw new Error(`Invalid standalone runtime symlink ${name}: target is outside runtime/`);
    }
  }
}

/** Tree SHA256 frames sorted POSIX path, kind, and content hash/link target with NULs and LF. */
export async function describeStandaloneRuntime(root) {
  const digest = createHash("sha256");
  let sizeBytes = 0;
  let fileCount = 0;
  let symlinkCount = 0;
  const entries = runtimeEntries(root).toSorted((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  assertStandaloneRuntimeLinks(root, entries);
  for (const { name, symlink } of entries) {
    const filename = path.join(root, name);
    if (symlink) {
      digest.update(`${name}\0symlink\0${fs.readlinkSync(filename)}\n`);
      symlinkCount += 1;
    } else {
      digest.update(`${name}\0file\0${await sha256File(filename)}\n`);
      sizeBytes += fs.statSync(filename).size;
      fileCount += 1;
    }
  }
  return { path: "runtime", sizeBytes, sha256: digest.digest("hex"), fileCount, symlinkCount };
}

export async function createStandaloneManifest({
  outputRoot,
  mode,
  bun,
  openclaw,
  embedded,
  pruning,
  sqlite,
}) {
  const runtime = await describeStandaloneRuntime(path.join(outputRoot, "runtime"));
  const executable = path.join(outputRoot, "openclaw");
  const { categories, sidecarPlugins, ...pruningSummary } = pruning;
  return {
    schemaVersion: 1,
    mode,
    target: { platform: process.platform, arch: process.arch },
    bun,
    openclaw,
    executable: {
      path: "openclaw",
      sizeBytes: fs.statSync(executable).size,
      sha256: await sha256File(executable),
    },
    runtime: {
      ...runtime,
      categories,
      sidecarPlugins,
      sqlite,
    },
    embedded,
    pruning: pruningSummary,
    ...(process.platform === "darwin"
      ? {
          macos: { hardenedRuntime: true, entitlements: standaloneMacosEntitlements(mode) },
        }
      : {}),
  };
}
