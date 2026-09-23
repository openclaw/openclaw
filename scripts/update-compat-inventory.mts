#!/usr/bin/env node
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { resolveNpmJsonEntries, resolveNpmJsonString } from "./lib/npm-json-output.mts";
import { compareReleaseVersions, parseReleaseVersion } from "./lib/release-version.mjs";
import {
  parseUpdateCompatibilityInventory,
  recordUpdateCompatibilityRelease,
  readUpdateCompatibilityInventory,
  type UpdateCompatibilityInventory,
} from "./lib/update-compat-chunks.mts";

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
  for (const tag of ["latest", "beta"]) {
    const version: unknown = Reflect.get(tags, tag);
    if (typeof version !== "string" || parseReleaseVersion(version)?.version !== version) {
      throw new Error(`npm OpenClaw dist-tag ${tag} is missing or invalid`);
    }
    taggedVersions.push(version);
  }
  const missing = [...new Set(taggedVersions)].filter(
    (version) => !inventory.releases.some((release) => release.version === version),
  );
  if (missing.length === 0) {
    return;
  }
  const releases = inventory.releases.map(({ version, integrity }) => ({ version, integrity }));
  for (const version of missing) {
    const integrity = resolveNpmJsonString(npmView(`openclaw@${version}`, "dist.integrity"));
    if (!INTEGRITY.test(integrity)) {
      throw new Error(`npm returned invalid SHA-512 integrity for openclaw@${version}`);
    }
    releases.push({ version, integrity });
  }
  const command = ["pnpm update:compat:gen"];
  if (output !== DEFAULT_OUTPUT) {
    command.push(`--output ${shellArgument(output)}`);
  }
  for (const release of sortedReleases(releases)) {
    command.push(
      `--release ${shellArgument(`.artifacts/update-compat/${release.version}/package=${release.integrity}`)}`,
    );
  }
  throw new Error(
    [
      `Update compatibility inventory is missing current npm release versions: ${missing.join(", ")}.`,
      "Download and verify each npm tarball against its SHA-512 integrity before unpacking it to .artifacts/update-compat/<version>/package, then run:",
      command.join(" "),
    ].join("\n"),
  );
}

function runUpdateCompatibilityInventory(args: string[] = process.argv.slice(2)): void {
  const { values } = parseArgs({
    args,
    options: {
      release: { type: "string", multiple: true },
      output: { type: "string", default: DEFAULT_OUTPUT },
      check: { type: "boolean", default: false },
    },
  });
  const output = path.resolve(values.output);
  let inventory: UpdateCompatibilityInventory;
  if (values.release?.length) {
    inventory = parseUpdateCompatibilityInventory({
      schemaVersion: 1,
      releases: sortedReleases(
        values.release.map((release) => {
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
        }),
      ),
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
      "Usage: pnpm update:compat:gen --release <unpacked-dir>=<npm-dist.integrity> [--release ...] [--output <file>] or pnpm update:compat:check",
    );
  }
  console.log(
    `${values.check ? "Verified" : "Recorded"} update compatibility inventory: ${inventory.releases.map((release) => `${release.version} (${release.chunks.length} chunks)`).join(", ")}`,
  );
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  runUpdateCompatibilityInventory();
}
