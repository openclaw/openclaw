import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

const packageManager = process.argv[2];
// Authenticate the wrapper and native executable selected by the repository pin.
const version = "12.15.0";
const wrapperHash =
  "b3951d6d6ff4a9f13dc7cf56cd28d2b8eb37dbcc9c68e52e1e1191873ea9f82a017287ab50baadc5ccc494f036c67c0e47eb13608c2fa36f47711b61ea128e61";
const nativeHashes = {
  x64: "c9cf9095947ef7e9ebdbd2787d1ce13286a98314c10e776affea5eca8ab55d4b9f9d01677db5d4305b9d0c82b31e2e78e658a71aa98e9977e7d0da2e7cd81c3a",
  arm64:
    "a8c2fff1a097b2587cb5dff0e14f8724da94719dbe9ba11f4db592708cd9466c8fb1114dfb10782cfd54fe1ca6c5cd6248988ab46e7a1c9c767ef504ad61481b",
};
const current = packageManager === `pnpm@${version}+sha512.${wrapperHash}`;
const nativeHash = nativeHashes[process.arch];
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
let supportedCurrentHost = false;
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
