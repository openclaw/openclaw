// Stage release assets for npm packaging. This script is never loaded by the Gateway.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

const source = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(source, "../..");
const manifest = JSON.parse(await fs.readFile(path.join(source, "package.json"), "utf8"));
const pin = manifest.beamNativeRelease;
const { values } = parseArgs({
  options: {
    cache: { type: "string" },
    offline: { type: "boolean" },
    prefetch: { type: "boolean" },
  },
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeAtomic(file, bytes, mode) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode });
    await fs.chmod(temporary, mode);
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function outputChild(parent, name) {
  const child = path.join(parent, name);
  try {
    await fs.mkdir(child);
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
  if (!(await fs.lstat(child)).isDirectory()) {
    throw new Error(`Expected an ordinary Beam asset directory: ${name}`);
  }
  return child;
}

async function assertExpectedChildren(dir, names) {
  for (const child of await fs.readdir(dir)) {
    if (!names.includes(child)) {
      throw new Error(
        `Unexpected Beam build output ${path.basename(dir)}/${child}. Rebuild from a clean dist directory.`,
      );
    }
  }
}

async function readArchive(cache, entry, offline) {
  const file = path.join(cache, entry.archive);
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size !== entry.bytes) {
      throw new Error(`Invalid cached Beam cleaner: ${entry.archive}`);
    }
    return await fs.readFile(file);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  if (offline) {
    throw new Error(
      `Missing offline Beam asset ${entry.archive}. Run node extensions/beam/scripts/package-cleaners.mjs --prefetch on a connected build host and reuse its cache.`,
    );
  }
  const url = new URL(
    `v${pin.version}/${entry.archive}`,
    "https://github.com/openclaw/beam/releases/download/",
  );
  const response = await fetch(url, { signal: AbortSignal.timeout(45_000) });
  if (!response.ok || !response.body) {
    throw new Error(`Downloading ${entry.archive} returned HTTP ${response.status}`);
  }
  const body = Buffer.alloc(entry.bytes);
  let offset = 0;
  for await (const chunk of response.body) {
    if (offset + chunk.length > body.length) {
      throw new Error(`Oversized Beam archive: ${entry.archive}`);
    }
    body.set(chunk, offset);
    offset += chunk.length;
  }
  if (offset !== entry.bytes || sha256(body) !== entry.sha256) {
    throw new Error(`Downloaded Beam archive failed verification: ${entry.archive}`);
  }
  await writeAtomic(file, body, 0o644);
  return body;
}

async function main() {
  if (!pin || pin.protocol !== 1 || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pin.version)) {
    throw new Error("This source tree has no qualified native Beam release pin");
  }
  const cache = path.resolve(
    values.cache ?? path.join(repo, ".artifacts", "beam-cleaners", pin.version),
  );
  await fs.mkdir(cache, { recursive: true });
  const expected = [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-arm64",
    "win32-x64",
  ];
  if (!isDeepStrictEqual(Object.keys(pin.platforms).toSorted(), expected)) {
    throw new Error("Incomplete native Beam cleaner platform pin");
  }
  const plugin = path.join(await fs.realpath(repo), "dist", "extensions", "beam");
  if (!values.prefetch && (await fs.realpath(plugin)) !== plugin) {
    throw new Error("Expected an ordinary built Beam plugin directory");
  }
  const native = values.prefetch ? null : await outputChild(plugin, "native");
  if (native) {
    // Packing a previously staged dist must not publish stale, unpinned native assets.
    await assertExpectedChildren(native, expected);
  }
  const offline = values.offline || process.env.npm_config_offline === "true";
  for (const target of expected) {
    const entry = pin.platforms[target];
    if (
      !/^beam-clean_[a-zA-Z0-9._-]+\.gz$/.test(entry.archive) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 1 ||
      entry.bytes > 8 * 1024 * 1024 ||
      !Number.isSafeInteger(entry.executableBytes) ||
      entry.executableBytes < 1 ||
      entry.executableBytes > 32 * 1024 * 1024
    ) {
      throw new Error(`Invalid native Beam asset pin for ${target}`);
    }
    const archive = await readArchive(cache, entry, offline);
    if (sha256(archive) !== entry.sha256) {
      throw new Error(`Cached Beam archive failed verification: ${entry.archive}`);
    }
    const executable = gunzipSync(archive, { maxOutputLength: entry.executableBytes });
    if (
      executable.length !== entry.executableBytes ||
      sha256(executable) !== entry.executableSha256
    ) {
      throw new Error(`Native Beam executable failed verification for ${target}`);
    }
    if (native) {
      const destination = await outputChild(native, target);
      const filename = target.startsWith("win32-") ? "beam-clean.exe" : "beam-clean";
      await assertExpectedChildren(destination, [filename]);
      await writeAtomic(path.join(destination, filename), executable, 0o755);
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  console.error("[package-beam-cleaners] FAILED (exit 1)");
  process.exitCode = 1;
}
