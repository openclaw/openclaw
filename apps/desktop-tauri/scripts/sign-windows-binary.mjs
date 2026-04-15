import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

function runOrThrow(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Command failed (${command} ${args.join(" ")}), exit code ${result.status ?? "null"}`);
  }
}

function resolveSignTool() {
  const whereResult = spawnSync("where.exe", ["signtool.exe"], {
    encoding: "utf8",
  });

  if (whereResult.status === 0) {
    const firstHit = whereResult.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean);
    if (firstHit) {
      return firstHit;
    }
  }

  const kitsRoot = process.env["ProgramFiles(x86)"];
  if (!kitsRoot) {
    throw new Error("ProgramFiles(x86) is not set; cannot locate signtool.exe");
  }

  const binRoot = join(kitsRoot, "Windows Kits", "10", "bin");
  const directCandidate = join(binRoot, "x64", "signtool.exe");
  if (existsSync(directCandidate)) {
    return directCandidate;
  }

  if (existsSync(binRoot)) {
    const versionCandidates = readdirSync(binRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(binRoot, entry.name, "x64", "signtool.exe"))
      .filter((candidate) => existsSync(candidate))
      .toSorted()
      .toReversed();

    if (versionCandidates[0]) {
      return versionCandidates[0];
    }
  }

  throw new Error("Unable to locate signtool.exe");
}

function main() {
  const binaryPath = process.argv[2];
  if (!binaryPath) {
    throw new Error("Usage: node scripts/sign-windows-binary.mjs <binary-path>");
  }

  const pfxPath = process.env.WINDOWS_PFX_PATH;
  if (!pfxPath) {
    console.log(`Skipping signing for ${binaryPath} because WINDOWS_PFX_PATH is not set.`);
    return;
  }

  const password = process.env.WINDOWS_PFX_PASSWORD;
  if (!password) {
    throw new Error("WINDOWS_PFX_PASSWORD is required when WINDOWS_PFX_PATH is set.");
  }

  const timestampUrl = process.env.WINDOWS_TIMESTAMP_URL || "http://timestamp.digicert.com";
  const signTool = resolveSignTool();

  runOrThrow(signTool, [
    "sign",
    "/fd",
    "SHA256",
    "/td",
    "SHA256",
    "/tr",
    timestampUrl,
    "/f",
    pfxPath,
    "/p",
    password,
    binaryPath,
  ]);
}

main();
