#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_NODE_VERSION = "25.9.0";
const SUPPORTED_TARGETS = new Set(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
const MAX_REDIRECTS = 5;
const PINNED_NODE_ARCHIVE_SHA256 = new Map([
  ["25.9.0:darwin-arm64", "15eeeb03c60691a4764effa6cee920217f72058a70bcffe5f4c1209bbe4ad5a3"],
  ["25.9.0:darwin-x64", "824d667ee88ca3e10e9917c9032937e6d1f5042aeb32affd145702d9ff877704"],
  ["25.9.0:linux-arm64", "bf007bf0dcc2fddd90888fde374a1ad33c1ab2ca2ad324c645dd7aed0f9f1460"],
  ["25.9.0:linux-x64", "1d8db7d6e291d167e8c467ae4094be175e1a0b3969c7ae1f8955b9f7824f7b2e"],
]);

function currentTarget() {
  const platform = process.platform;
  const arch = process.arch;
  if ((platform === "darwin" || platform === "linux") && (arch === "arm64" || arch === "x64")) {
    return `${platform}-${arch}`;
  }
  throw new Error(`unsupported SEA host: ${platform}-${arch}`);
}

function parseArgs(argv) {
  const options = {
    cacheDir: path.join(ROOT_DIR, ".artifacts", "sea-node-cache"),
    target: currentTarget(),
    version: process.env.OPENCLAW_SEA_NODE_VERSION || DEFAULT_NODE_VERSION,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--target") {
      options.target = argv[(index += 1)] ?? "";
    } else if (arg?.startsWith("--target=")) {
      options.target = arg.slice("--target=".length);
    } else if (arg === "--version") {
      options.version = argv[(index += 1)] ?? "";
    } else if (arg?.startsWith("--version=")) {
      options.version = arg.slice("--version=".length);
    } else if (arg === "--cache-dir") {
      options.cacheDir = argv[(index += 1)] ?? "";
    } else if (arg?.startsWith("--cache-dir=")) {
      options.cacheDir = arg.slice("--cache-dir=".length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!SUPPORTED_TARGETS.has(options.target)) {
    throw new Error(`unsupported SEA target '${options.target}'`);
  }
  if (!/^\d+\.\d+\.\d+$/u.test(options.version)) {
    throw new Error(`invalid Node.js version '${options.version}'`);
  }
  options.cacheDir = path.resolve(ROOT_DIR, options.cacheDir);
  return options;
}

function fetchBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirects >= MAX_REDIRECTS) {
            reject(new Error(`GET ${url} exceeded ${MAX_REDIRECTS} redirects`));
            return;
          }
          resolve(fetchBuffer(new URL(response.headers.location, url).href, redirects + 1));
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`GET ${url} failed with HTTP ${status}`));
          return;
        }
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      if (status === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with ${status ?? signal}`));
    });
  });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function nodeBinaryPath(extractDir, target) {
  const [platform] = target.split("-");
  return path.join(extractDir, "bin", platform === "win32" ? "node.exe" : "node");
}

function cacheMarkerPath(extractDir) {
  return path.join(extractDir, ".openclaw-sea-node.sha256");
}

function archiveName(version, target) {
  const [platform, arch] = target.split("-");
  return `node-v${version}-${platform}-${arch}.tar.xz`;
}

function isTruthyEnvValue(value) {
  return value === "1" || value === "true" || value === "yes";
}

function pinnedSha256(version, target) {
  return PINNED_NODE_ARCHIVE_SHA256.get(`${version}:${target}`);
}

function expectedSha256(shasumsText, name) {
  const line = shasumsText
    .split(/\r?\n/u)
    .find((entry) => entry.endsWith(`  ${name}`) || entry.endsWith(` *${name}`));
  const match = line?.match(/^([a-f0-9]{64})\s/u);
  if (!match) {
    throw new Error(`missing SHA256 entry for ${name}`);
  }
  return match[1];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const archive = archiveName(options.version, options.target);
  const pinned = pinnedSha256(options.version, options.target);
  const allowUnpinned = isTruthyEnvValue(process.env.OPENCLAW_SEA_ALLOW_UNPINNED_NODE);
  if (!pinned && !allowUnpinned) {
    throw new Error(
      `no pinned SHA256 for ${archive}; update PINNED_NODE_ARCHIVE_SHA256 or set OPENCLAW_SEA_ALLOW_UNPINNED_NODE=1 for an explicit unpinned build`,
    );
  }
  const releaseBaseUrl = `https://nodejs.org/dist/v${options.version}`;
  const extractDir = path.join(options.cacheDir, `node-v${options.version}-${options.target}`);
  const binaryPath = nodeBinaryPath(extractDir, options.target);
  if (await exists(binaryPath)) {
    if (!pinned) {
      console.log(binaryPath);
      return;
    }
    const cachedSha256 = (await fs.readFile(cacheMarkerPath(extractDir), "utf8").catch(() => ""))
      .trim()
      .toLowerCase();
    if (cachedSha256 === pinned) {
      console.log(binaryPath);
      return;
    }
    await fs.rm(extractDir, { recursive: true, force: true });
  }

  await fs.mkdir(options.cacheDir, { recursive: true });
  const shasumsText = (await fetchBuffer(`${releaseBaseUrl}/SHASUMS256.txt`)).toString("utf8");
  const archiveUrl = `${releaseBaseUrl}/${archive}`;
  const archiveBytes = await fetchBuffer(archiveUrl);
  const actualSha256 = createHash("sha256").update(archiveBytes).digest("hex");
  const wantedSha256 = expectedSha256(shasumsText, archive);
  const trustedSha256 = pinned ?? wantedSha256;
  if (wantedSha256 !== trustedSha256) {
    throw new Error(
      `pinned SHA256 mismatch for ${archive}: release SHASUMS listed ${wantedSha256}, pinned ${trustedSha256}`,
    );
  }
  if (actualSha256 !== trustedSha256) {
    throw new Error(
      `SHA256 mismatch for ${archive}: expected ${trustedSha256}, received ${actualSha256}`,
    );
  }

  const tempRoot = await fs.mkdtemp(path.join(options.cacheDir, ".extract-"));
  const archivePath = path.join(tempRoot, archive);
  await fs.writeFile(archivePath, archiveBytes);
  await run("tar", ["-xJf", archivePath, "-C", tempRoot], ROOT_DIR);
  const unpackedDir = path.join(tempRoot, archive.replace(/\.tar\.xz$/u, ""));
  await fs.rm(extractDir, { recursive: true, force: true });
  await fs.rename(unpackedDir, extractDir);
  await fs.writeFile(cacheMarkerPath(extractDir), `${trustedSha256}\n`, "utf8");
  await fs.rm(tempRoot, { recursive: true, force: true });
  console.log(binaryPath);
}

await main();
