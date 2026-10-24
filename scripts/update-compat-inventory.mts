#!/usr/bin/env node
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { extract as extractTar } from "tar";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { resolveNpmJsonEntries, resolveNpmJsonString } from "./lib/npm-json-output.mts";
import { compareReleaseVersions, parseReleaseVersion } from "./lib/release-version.mjs";
import {
  parseUpdateCompatibilityInventory,
  recordUpdateCompatibilityRelease,
  readUpdateCompatibilityInventory,
  type UpdateCompatibilityInventory,
} from "./lib/update-compat-chunks.mts";
import { supportsUpdateSchemas } from "./lib/update-compat-contract.mjs";

const DEFAULT_OUTPUT = "scripts/lib/update-compat-inventory.json";
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;

function npmView(packageName: string, field: string): unknown {
  return JSON.parse(
    childProcess.execFileSync("npm", ["view", packageName, field, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      shell: process.platform === "win32",
    }),
  );
}

function sortedReleases<T extends { version: string }>(releases: T[]): T[] {
  return releases.toSorted((left, right) => {
    const order = compareReleaseVersions(left.version, right.version);
    if (order === null) {
      throw new Error(`Invalid release version: ${left.version} or ${right.version}`);
    }
    return order;
  });
}

async function recordRegistryRelease(version: string) {
  if (parseReleaseVersion(version)?.version !== version) {
    throw new Error(`Invalid --registry-release ${version}; expected an exact release version`);
  }
  const integrity = resolveNpmJsonString(npmView(`openclaw@${version}`, "dist.integrity"));
  if (!INTEGRITY.test(integrity)) {
    throw new Error(`npm returned invalid SHA-512 integrity for openclaw@${version}`);
  }
  const tarball = resolveNpmJsonString(npmView(`openclaw@${version}`, "dist.tarball"));
  const url = new URL(tarball);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`npm returned unsupported tarball URL for openclaw@${version}`);
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(
      `Failed to download openclaw@${version} tarball: HTTP ${response.status} ${response.statusText}`,
    );
  }
  const archive = Buffer.from(await response.arrayBuffer());
  const actualIntegrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  if (actualIntegrity !== integrity) {
    throw new Error(`Registry tarball integrity mismatch for openclaw@${version}`);
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-update-compat-${version}-`));
  try {
    const archivePath = path.join(temp, "package.tgz");
    const packageDir = path.join(temp, "package");
    fs.writeFileSync(archivePath, archive);
    fs.mkdirSync(packageDir);
    await extractTar({ cwd: packageDir, file: archivePath, strip: 1 });
    const release = recordUpdateCompatibilityRelease({ packageDir, integrity });
    if (release.version !== version) {
      throw new Error(
        `Registry tarball identity mismatch for openclaw@${version}: received ${release.version}`,
      );
    }
    return release;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function shellArgument(value: string): string {
  return /^[A-Za-z0-9_./=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function checkRegistryCoverage(inventory: UpdateCompatibilityInventory, output: string): void {
  const entries = resolveNpmJsonEntries(npmView("openclaw", "dist-tags"));
  const tags = entries.length === 1 ? entries[0] : undefined;
  if (typeof tags !== "object" || tags === null || Array.isArray(tags)) {
    throw new Error("npm returned invalid OpenClaw dist-tags; expected latest and beta versions");
  }
  const taggedVersions: string[] = [];
  // Extended-stable installs follow their own selector once a monthly line has published.
  for (const tag of ["latest", "beta", "extended-stable"]) {
    const version: unknown = Reflect.get(tags, tag);
    if (tag === "extended-stable" && version === undefined) {
      continue;
    }
    if (typeof version !== "string" || parseReleaseVersion(version)?.version !== version) {
      throw new Error(`npm OpenClaw dist-tag ${tag} is missing or invalid`);
    }
    taggedVersions.push(version);
  }
  const target = JSON.parse(fs.readFileSync("package.json", "utf8")).openclaw?.schemaVersions;
  const missing = [...new Set(taggedVersions)].filter((version) => {
    if (inventory.releases.some((release) => release.version === version)) {
      return false;
    }
    const [schemas] = resolveNpmJsonEntries(
      npmView(`openclaw@${version}`, "openclaw.schemaVersions"),
    );
    const supported = supportsUpdateSchemas(schemas, target);
    if (!supported) {
      console.log(`Accounted unsupported first-hop source ${version}`);
    }
    return supported;
  });
  if (missing.length === 0) {
    return;
  }
  const releases = [...inventory.releases.map(({ version }) => version), ...missing];
  const command = ["pnpm update:compat:gen"];
  if (output !== DEFAULT_OUTPUT) {
    command.push(`--output ${shellArgument(output)}`);
  }
  for (const release of sortedReleases(releases.map((version) => ({ version })))) {
    command.push(`--registry-release ${shellArgument(release.version)}`);
  }
  throw new Error(
    [
      `Update compatibility inventory is missing current npm release versions: ${missing.join(", ")}.`,
      "Fetch, verify, and record the complete published compatibility window with:",
      command.join(" "),
    ].join("\n"),
  );
}

async function runUpdateCompatibilityInventory(
  args: string[] = process.argv.slice(2),
): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      release: { type: "string", multiple: true },
      "registry-release": { type: "string", multiple: true },
      output: { type: "string", default: DEFAULT_OUTPUT },
      check: { type: "boolean", default: false },
    },
  });
  const output = path.resolve(values.output);
  let inventory: UpdateCompatibilityInventory;
  if (values.release?.length || values["registry-release"]?.length) {
    const localReleases = values.release?.map((release) => {
      const split = release.indexOf("=sha512-");
      if (split <= 0 || !INTEGRITY.test(release.slice(split + 1))) {
        throw new Error(
          `Invalid --release ${release}; expected <unpacked-dir>=<npm-dist.integrity>`,
        );
      }
      return recordUpdateCompatibilityRelease({
        packageDir: release.slice(0, split),
        integrity: release.slice(split + 1),
      });
    });
    const registryReleases = await Promise.all(
      (values["registry-release"] ?? []).map(recordRegistryRelease),
    );
    inventory = parseUpdateCompatibilityInventory({
      schemaVersion: 1,
      releases: sortedReleases([...(localReleases ?? []), ...registryReleases]),
    });
    const contents = `${JSON.stringify(inventory, null, 2)}\n`;
    if (values.check) {
      readUpdateCompatibilityInventory(output);
      if (fs.readFileSync(output, "utf8") !== contents) {
        throw new Error(`Stale update compatibility inventory: ${output}`);
      }
    } else {
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, contents);
    }
  } else if (values.check) {
    inventory = readUpdateCompatibilityInventory(output);
    checkRegistryCoverage(inventory, values.output);
  } else {
    throw new Error(
      "Usage: pnpm update:compat:gen (--release <unpacked-dir>=<npm-dist.integrity> | --registry-release <version>) [...] [--output <file>] or pnpm update:compat:check",
    );
  }
  console.log(
    `${values.check ? "Verified" : "Recorded"} update compatibility inventory: ${inventory.releases.map((release) => `${release.version} (${release.chunks.length} chunks)`).join(", ")}`,
  );
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  await runUpdateCompatibilityInventory();
}
