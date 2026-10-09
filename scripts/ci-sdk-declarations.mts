import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { ensureKyselyTypes } from "./generate-kysely-types.mts";
import { readArtifactRecord } from "./lib/build-artifact-cache.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { withDistArtifactOwnership } from "./lib/dist-artifact-ownership.mts";
import {
  BOUNDARY_CACHE_ROOT,
  LOCAL_SDK_ROOT,
  BoundaryInputSnapshot,
  boundaryPreparationArgs,
  boundaryRuntimeVersion,
  sdkBoundaryUnit,
} from "./lib/extension-boundary-inputs.mts";
import { createDeclarationInputBoundary } from "./lib/local-check-runtime.mts";
import { nativeTypeScriptToolchainFiles } from "./lib/native-typescript-toolchain.mts";

const recordName = `${BOUNDARY_CACHE_ROOT}/plugin-sdk.json`;
const archiveName = ".artifacts/ci-sdk-declarations/sdk.json.gz";
const maxArchiveBytes = 64 * 1024 * 1024;
const maxExpandedBytes = 512 * 1024 * 1024;
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

function declarationPath(file: string) {
  return (
    !path.isAbsolute(file) &&
    !file.includes("\\") &&
    !Array.from(file).some((character) => character.charCodeAt(0) < 32) &&
    !file.split("/").some((part) => !part || part === "." || part === "..") &&
    (file === recordName ||
      file === `${LOCAL_SDK_ROOT}/.inputs.json` ||
      (file.startsWith(`${LOCAL_SDK_ROOT}/`) && /\.d\.[cm]?ts$/u.test(file)))
  );
}

function assertRegularPath(root: string, file: string) {
  const boundary = createDeclarationInputBoundary(root);
  const target = boundary.assert(file);
  for (let current = target; current !== boundary.root; current = path.dirname(current)) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error("SDK transport does not accept symbolic links");
    }
  }
  return target;
}

function currentSdk(root: string) {
  const unit = sdkBoundaryUnit();
  const inputReceipt = `${unit.outDir}/.inputs.json`;
  const record = readArtifactRecord(path.join(root, recordName));
  if (!record || !fs.existsSync(path.join(root, inputReceipt))) {
    return undefined;
  }
  const snapshot = new BoundaryInputSnapshot(root);
  return snapshot.matchesReceipt(
    record,
    unit.config,
    boundaryPreparationArgs(root, unit),
    [...unit.required, inputReceipt],
    inputReceipt,
    path.join(root, unit.outDir),
  )
    ? record
    : undefined;
}

/** Conservative source key locates candidates; the native receipt remains authoritative. */
function cacheIdentity(root: string) {
  const boundary = createDeclarationInputBoundary(root);
  const require = createRequire(path.join(root, "package.json"));
  const nativePackage = boundary.assert(require.resolve("typescript/package.json"));
  const tools = nativeTypeScriptToolchainFiles(nativePackage, (file) => boundary.assert(file));
  const toolchain = digest(
    JSON.stringify([
      boundaryRuntimeVersion(),
      process.platform,
      process.arch,
      ...tools.map((file) => digest(fs.readFileSync(file))),
    ]),
  );
  const files = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .split("\0")
    .filter(
      (file) =>
        /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|tsconfig[^/]*\.json)$/u.test(
          file,
        ) ||
        /^(?:src|packages|extensions|scripts|test|config)\/.*\.(?:[cm]?[jt]sx?|json|sql|ya?ml)$/u.test(
          file,
        ) ||
        file.startsWith("patches/"),
    )
    .toSorted();
  const sources = createHash("sha256");
  for (const file of files) {
    const absolute = boundary.assert(file);
    const stat = fs.lstatSync(absolute);
    sources.update(file).update("\0");
    if (stat.isSymbolicLink()) {
      sources.update(fs.readlinkSync(absolute)).update("\0");
    }
    sources.update(digest(fs.readFileSync(absolute))).update("\0");
  }
  const prefix = `native-sdk-v1-${process.platform}-${process.arch}-${toolchain}-`;
  return { key: `${prefix}${sources.digest("hex")}`, prefix };
}

function pack(root: string) {
  const record = currentSdk(root);
  if (!record) {
    throw new Error("Only a current full SDK receipt can be published");
  }
  const names = [...Object.keys(record.outputs), recordName].toSorted();
  const files = names.map((file) => {
    if (!declarationPath(file)) {
      throw new Error("SDK receipt contains a non-declaration transport path");
    }
    const target = assertRegularPath(root, file);
    if (!fs.statSync(target).isFile()) {
      throw new Error("SDK transport requires regular declaration files");
    }
    return [file, fs.readFileSync(target, "utf8")];
  });
  const bytes = Buffer.from(JSON.stringify({ version: 1, key: cacheIdentity(root).key, files }));
  if (bytes.length > maxExpandedBytes) {
    throw new Error("Prepared SDK exceeds the transport size limit");
  }
  const packed = gzipSync(bytes);
  if (packed.length > maxArchiveBytes) {
    throw new Error("Prepared SDK archive exceeds the transport size limit");
  }
  const archive = assertRegularPath(root, archiveName);
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(archive, packed);
  console.log(`Prepared SDK archive: ${files.length} files, ${packed.length} bytes`);
}

function restore(root: string, required: boolean) {
  const archive = assertRegularPath(root, archiveName);
  const bytes = fs.readFileSync(archive);
  if (bytes.length > maxArchiveBytes) {
    throw new Error("Prepared SDK archive exceeds the transport size limit");
  }
  const payload: unknown = JSON.parse(
    gunzipSync(bytes, { maxOutputLength: maxExpandedBytes }).toString("utf8"),
  );
  if (
    !payload ||
    typeof payload !== "object" ||
    !("version" in payload) ||
    payload.version !== 1 ||
    !("key" in payload) ||
    typeof payload.key !== "string" ||
    !("files" in payload) ||
    !Array.isArray(payload.files)
  ) {
    throw new Error("Invalid prepared SDK archive");
  }
  if (required && payload.key !== cacheIdentity(root).key) {
    throw new Error("Prepared SDK run artifact belongs to different source or toolchain inputs");
  }
  const seen = new Set<string>();
  const files = payload.files.map((entry: unknown) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string" ||
      !declarationPath(entry[0]) ||
      seen.has(entry[0])
    ) {
      throw new Error("Invalid or repeated prepared SDK file");
    }
    seen.add(entry[0]);
    return { path: assertRegularPath(root, entry[0]), content: entry[1] };
  });
  if (!seen.has(recordName) || !seen.has(`${LOCAL_SDK_ROOT}/.inputs.json`)) {
    throw new Error("Prepared SDK archive is missing its native receipt");
  }
  const sdk = assertRegularPath(root, LOCAL_SDK_ROOT);
  const record = assertRegularPath(root, recordName);
  fs.rmSync(record, { force: true });
  fs.rmSync(sdk, { recursive: true, force: true });
  try {
    for (const file of files) {
      fs.mkdirSync(path.dirname(file.path), { recursive: true });
      fs.writeFileSync(file.path, file.content);
    }
    if (!currentSdk(root)) {
      throw new Error("Prepared SDK receipt does not match current inputs and toolchain");
    }
    console.log(`Prepared SDK restored and validated: ${files.length} files`);
  } catch (error) {
    fs.rmSync(record, { force: true });
    fs.rmSync(sdk, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const root = fs.realpathSync.native(process.cwd());
  const [operation, ...args] = process.argv.slice(2);
  await withDistArtifactOwnership(root, async () => {
    await ensureKyselyTypes(root);
    if (operation === "key") {
      const identity = cacheIdentity(root);
      const values = {
        "cache-key": identity.key,
        "cache-prefix": identity.prefix,
        archive: archiveName,
        fresh: String(Boolean(currentSdk(root))),
      };
      if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(
          process.env.GITHUB_OUTPUT,
          Object.entries(values)
            .map(([key, value]) => `${key}=${value}\n`)
            .join(""),
        );
      }
      console.log(JSON.stringify(values));
    } else if (operation === "pack") {
      pack(root);
    } else if (operation === "restore") {
      const required = args.includes("--required");
      try {
        restore(root, required);
      } catch (error) {
        if (required) {
          throw error;
        }
        console.log(
          `Prepared SDK cache unavailable: ${error instanceof Error ? error.message : "invalid archive"}; native preparation will run`,
        );
      }
    } else if (operation === "validate") {
      if (!currentSdk(root)) {
        throw new Error("Prepared SDK receipt does not match current inputs and toolchain");
      }
      console.log("Prepared SDK receipt is current");
    } else {
      throw new Error(`Unknown SDK declaration operation: ${operation}`);
    }
  });
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  await main();
}
