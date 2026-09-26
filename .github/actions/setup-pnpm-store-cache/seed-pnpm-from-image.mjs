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
// The repository already selects 12.5.0. Authenticate both stages of its
// bootstrap without changing that pin or routing downloads through Node fetch.
const currentVersion = "12.5.0";
const currentWrapperHash =
  "9cdbaa34ffacae1768635ac0d23e94db6201c7d59bf3da236b23d67c8f6b794d1dab323bcd5bcc51b55c8cafbf6f19a24e4aa61d6ab7772aa3b5cc85e325dc4d";
const currentNativeHashes = {
  x64: "f27d1f5ed98258cab9e7c003d59796f5d2261bc4f0418eb0b3a8ec61ca1157edae04170b10727995f797bc18fdf749e87f04bb5d98a1a990efcb52c192729605",
  arm64:
    "9f3b25522cbb2c01647b79e22ca752687714745788852288d35d35bb740a5aee90e13ffbe605304d4c5c30f573dacbd452672d5c0740bfa727a64c9fbcad92ae",
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
