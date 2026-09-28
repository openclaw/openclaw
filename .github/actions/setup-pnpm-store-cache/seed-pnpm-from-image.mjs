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
// The repository already selects 12.5.1. Authenticate both stages of its
// bootstrap without changing that pin or routing downloads through Node fetch.
const currentVersion = "12.5.1";
const currentWrapperHash =
  "e3f305bc784a2bc89f5ad3b6138889470fae8d2af5f36b61216ec91c2c3d64089775f9de38aac331044ea40f245cb0d5666392dfdf65824e1907ef6a2c62de5f";
const currentNativeHashes = {
  x64: "dcf914058a39cf8760b659d3348163ed01a9703500baa5f3f561958a03c309e71c127846891916980e75d364e66091edc093f72df984f9917d3c6796867f29f5",
  arm64:
    "ea16cc596dbf790a356f9c2f40f7bf9dd2c75531fcf116afe8df9f7c3e3f87a22e14c8d60a06ac15862c16fd06aefa6a444031dd2c26652be58bed0d157a9bc4",
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
        const fetched = spawnSync(
          "curl",
          [
            "--fail",
            "--location",
            "--silent",
            "--show-error",
            "--connect-timeout",
            "10",
            "--max-time",
            "120",
            "--output",
            destination,
            url,
          ],
          { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
        );
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
