import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inspectNpmPackageTarball } from "../../../prepublish-plugin-registry-artifact.mjs";
import { readPluginInstallRecords } from "../plugin-index-sqlite.mjs";

const [registryDir, destination] = process.argv.slice(2);
assert(registryDir && destination, "Expected candidate registry and published archive directories");
const manifest = JSON.parse(
  fs.readFileSync(path.join(registryDir, "prepublish-plugin-registry.json"), "utf8"),
);
const integrity = (file) =>
  `sha512-${createHash("sha512").update(fs.readFileSync(file)).digest("base64")}`;

for (const record of Object.values(readPluginInstallRecords())) {
  if (record.source !== "npm") {
    continue;
  }
  const candidate = manifest.packages.find(
    (entry) => entry.name === record.resolvedName && entry.version === record.resolvedVersion,
  );
  // Older versions remain upstream. A baseline fixture may also have already
  // installed candidate bytes; only published/candidate collisions need overrides.
  if (!candidate || record.integrity === integrity(path.join(registryDir, candidate.tarball))) {
    continue;
  }
  fs.mkdirSync(destination, { recursive: true });
  const archive = path.join(destination, candidate.tarball);
  if (!fs.existsSync(archive)) {
    const packed = JSON.parse(
      execFileSync(
        "npm",
        [
          "pack",
          `${candidate.name}@${candidate.version}`,
          "--registry=https://registry.npmjs.org",
          "--pack-destination",
          destination,
          "--ignore-scripts",
          "--json",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
      ),
    );
    assert(packed.length === 1 && path.basename(packed[0].filename) === packed[0].filename);
    fs.renameSync(path.join(destination, packed[0].filename), archive);
  }
  const published = inspectNpmPackageTarball(archive).packageJson;
  assert(
    published.name === candidate.name && published.version === candidate.version,
    `Published plugin archive identity differs for ${candidate.name}@${candidate.version}`,
  );
  assert(
    !record.integrity || record.integrity === integrity(archive),
    `Published plugin archive differs from installed integrity for ${candidate.name}@${candidate.version}`,
  );
  process.stdout.write(`${candidate.name}\t${candidate.version}\t${archive}\n`);
}
