import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

const packageManager = process.argv[2];
const imageVersion = "12.3.4";
const imageWrapperHash =
  "961aa41fb077da3a04a441d9f8e15ebc0c96da8ef710b2eb67bf9ee7cb0610eabd48f1fd85f51cffe73846785fa0f87c56a3a872a1d893f8446741b5cce45457";
const imageNativeHashes = {
  x64: "d99a8e9523e47f05f5879711f853e259ff3e17eda1653ff74ef8542b9b22807ab06900888aaf11ec21b186774ab3adc9b5c2e2d9ad50a68fb05ff128c9f8f225",
  arm64:
    "b7bd40540ecb46a88a4f2679c4c61a65cda7e437dda4c6dfa2466e8883971c138cd371029c5d2de226306810ea26056394a6143b0685fdb4506a318d038709e3",
};
// The repository already selects 12.10.1. Authenticate both stages of its
// bootstrap without changing that pin or routing downloads through Node fetch.
const currentVersion = "12.10.1";
const currentWrapperHash =
  "ba40a37eb1a370d60fea8c4cf1d364c13bcccef518e98ad2bcee954f539d38da37458e58261a3fa55e06523450ea0ffff9f497b135be41f2c15c1642bacace6c";
const currentNativeHashes = {
  x64: "641c95d034605b319a0d28d3e5d75104049dc33fabfea3cc621ee8e911a63d08ed4463456d297de316360dc00cf26a82399254503b405d0fb0a415dc7692a592",
  arm64:
    "a0174ca7af52702f549e7886e2a640415af67c10d25e39b8ca4ffbdaf904572ae5c12db7c8cc5c45097b41da37b205cf032818e935a73d12a6e2b5f38e8c96ef",
};
const current = packageManager === `pnpm@${currentVersion}+sha512.${currentWrapperHash}`;
const version = current ? currentVersion : imageVersion;
const wrapperHash = current ? currentWrapperHash : imageWrapperHash;
const nativeHash = (current ? currentNativeHashes : imageNativeHashes)[process.arch];
const archiveRoot = "/opt/crabbox/toolchain-archives";
const cachedArchives = process.env.PNPM_CONFIG_STORE_DIR
  ? join(process.env.PNPM_CONFIG_STORE_DIR, "toolchain")
  : undefined;
const registry = "https://registry.npmjs.org";
const registryConfigured = (process.env.COREPACK_NPM_REGISTRY || registry).replace(/\/$/u, "");
// Curl's built-in retry policy already distinguishes transient HTTP responses.
// Retry only transport exits here so permanent HTTP failures still fail once.
const retryableCurlStatuses = new Set([5, 6, 7, 18, 35, 52, 55, 56, 92]);
// These native archives are glibc builds. Windows seeds only the authenticated
// wrapper; pnpm owns its native binary selection and signature verification.
let supportedCurrentHost = !current;
if (current && process.platform === "linux") {
  try {
    supportedCurrentHost = Boolean(process.report?.getReport().header.glibcVersionRuntime);
  } catch {
    // Leave unprobeable native selection with pnpm's normal platform owner.
  }
}
const canDownload =
  current &&
  registryConfigured === registry &&
  process.env.COREPACK_ENABLE_NETWORK !== "0" &&
  process.env.COREPACK_INTEGRITY_KEYS === undefined;

const seedNative = process.platform === "linux" && supportedCurrentHost && nativeHash;
if (
  (seedNative || (current && process.platform === "win32")) &&
  packageManager === `pnpm@${version}+sha512.${wrapperHash}`
) {
  const staging = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), "pnpm-image-"));
  let corepackHome;
  try {
    const archives = [[`pnpm-${version}.tgz`, wrapperHash]];
    if (seedNative) {
      archives.push([`exe.linux-${process.arch}-${version}.tgz`, nativeHash]);
    }
    let valid = true;
    for (const [name, hash] of archives) {
      const destination = join(staging, name);
      const authentic = () =>
        readFile(destination).then(
          (bytes) => createHash("sha512").update(bytes).digest("hex") === hash,
        );
      let restored = false;
      for (const root of [cachedArchives, archiveRoot].filter(Boolean)) {
        try {
          // Authenticate the private bytes we will extract, never a cache marker.
          await copyFile(join(root, name), destination);
        } catch (error) {
          if (["ENOENT", "EACCES", "EISDIR", "ENOTDIR"].includes(error.code)) {
            continue;
          }
          throw error;
        }
        if (await authentic()) {
          console.error(`Restored pinned pnpm archive ${name} from ${root}`);
          restored = true;
          break;
        }
      }
      if (!restored) {
        if (!canDownload) {
          valid = false;
          break;
        }
        const url = name.startsWith("pnpm-")
          ? `${registry}/pnpm/-/${name}`
          : `${registry}/@pnpm/exe.linux-${process.arch}/-/${name}`;
        console.error(`Downloading pinned pnpm archive ${name}`);
        const curlArgs = [
          "--fail",
          "--location",
          "--silent",
          "--show-error",
          "--connect-timeout",
          "10",
          "--max-time",
          "120",
          "--retry",
          "2",
          "--retry-delay",
          "2",
          "--output",
          destination,
          url,
        ];
        let fetched;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          fetched = spawnSync("curl", curlArgs, {
            stdio: ["ignore", "ignore", "pipe"],
            encoding: "utf8",
          });
          if (fetched.error || !retryableCurlStatuses.has(fetched.status)) {
            break;
          }
        }
        if (fetched.error || fetched.status !== 0) {
          throw new Error(`Cannot download pinned pnpm archive ${name}: ${fetched.stderr}`, {
            cause: fetched.error,
          });
        }
        if (!(await authentic())) {
          throw new Error(`Pinned pnpm archive checksum mismatch: ${name}`);
        }
      }
    }
    if (valid) {
      corepackHome = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), "openclaw-corepack-"));
      const pnpmRoot = join(corepackHome, "v1", "pnpm", version);
      const roots = [
        pnpmRoot,
        join(pnpmRoot, "node_modules", "@pnpm", `exe.linux-${process.arch}`),
      ];
      for (const [index, [name]] of archives.entries()) {
        await mkdir(roots[index], { recursive: true });
        const result = spawnSync(
          "tar",
          [
            "-xzf",
            relative(roots[index], join(staging, name)).split(sep).join("/"),
            "--strip-components=1",
          ],
          { cwd: roots[index], stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
        );
        if (result.error || result.status !== 0) {
          throw new Error(`Cannot extract authenticated pnpm image archive: ${result.stderr}`, {
            cause: result.error,
          });
        }
      }
      // Corepack 0.35's v1 cache format; image-provided .corepack files are never read.
      await writeFile(
        join(pnpmRoot, ".corepack"),
        JSON.stringify({
          locator: { name: "pnpm", reference: packageManager.slice("pnpm@".length) },
          bin: { pnpm: "./bin/pnpm.mjs", pnpx: "./bin/pnpx.mjs" },
          hash: `sha512.${wrapperHash}`,
        }),
      );
      if (cachedArchives) {
        try {
          await mkdir(cachedArchives, { recursive: true });
          for (const [name] of archives) {
            await copyFile(join(staging, name), join(cachedArchives, name));
          }
        } catch (error) {
          console.error(`::warning::Cannot cache authenticated pnpm archives: ${error.code}`);
        }
      }
      process.stdout.write(`${corepackHome}\n`);
      corepackHome = undefined;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (corepackHome) {
      await rm(corepackHome, { recursive: true, force: true });
    }
  }
}
