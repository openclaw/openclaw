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
        if (status >= 300 && status < 400 && response.headers.location && redirects < 5) {
          response.resume();
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

function archiveName(version, target) {
  const [platform, arch] = target.split("-");
  return `node-v${version}-${platform}-${arch}.tar.xz`;
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
  const releaseBaseUrl = `https://nodejs.org/dist/v${options.version}`;
  const extractDir = path.join(options.cacheDir, `node-v${options.version}-${options.target}`);
  const binaryPath = nodeBinaryPath(extractDir, options.target);
  if (await exists(binaryPath)) {
    console.log(binaryPath);
    return;
  }

  await fs.mkdir(options.cacheDir, { recursive: true });
  const shasumsText = (await fetchBuffer(`${releaseBaseUrl}/SHASUMS256.txt`)).toString("utf8");
  const archiveUrl = `${releaseBaseUrl}/${archive}`;
  const archiveBytes = await fetchBuffer(archiveUrl);
  const actualSha256 = createHash("sha256").update(archiveBytes).digest("hex");
  const wantedSha256 = expectedSha256(shasumsText, archive);
  if (actualSha256 !== wantedSha256) {
    throw new Error(
      `SHA256 mismatch for ${archive}: expected ${wantedSha256}, received ${actualSha256}`,
    );
  }

  const tempRoot = await fs.mkdtemp(path.join(options.cacheDir, ".extract-"));
  const archivePath = path.join(tempRoot, archive);
  await fs.writeFile(archivePath, archiveBytes);
  await run("tar", ["-xJf", archivePath, "-C", tempRoot], ROOT_DIR);
  const unpackedDir = path.join(tempRoot, archive.replace(/\.tar\.xz$/u, ""));
  await fs.rm(extractDir, { recursive: true, force: true });
  await fs.rename(unpackedDir, extractDir);
  await fs.rm(tempRoot, { recursive: true, force: true });
  console.log(binaryPath);
}

await main();
