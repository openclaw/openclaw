import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const expectedVersion = "0.1.0";
const expectedTreeSHA256 = "ae640f0d6e8b19cc8476e4231d502adfcc6a9c225b57b1b6c428f84d6eb586cc";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = resolve(root, "vendor", "openclaw-contracts");
const runtimeEntry = resolve(artifactRoot, "src", "index.mjs");
const typesEntry = resolve(artifactRoot, "generated", "types", "index.d.ts");

for (const required of [runtimeEntry, typesEntry]) {
  if (!existsSync(required)) {
    throw new Error(`missing required contracts artifact file: ${relative(root, required)}`);
  }
}

if (existsSync(join(artifactRoot, "package.json"))) {
  throw new Error(
    "vendor/openclaw-contracts/package.json must not exist; it trips dependency-guard as a nested manifest",
  );
}

function listFiles(dir) {
  const entries = [];
  for (const name of readdirSync(dir).toSorted((left, right) => left.localeCompare(right))) {
    const absolute = join(dir, name);
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      entries.push(...listFiles(absolute));
      continue;
    }
    if (stat.isFile()) {
      entries.push(absolute);
    }
  }
  return entries;
}

const hash = createHash("sha256");
for (const absolute of listFiles(artifactRoot)) {
  const rel = relative(artifactRoot, absolute).split("\\").join("/");
  hash.update(`${rel}\n`);
  hash.update(readFileSync(absolute));
  hash.update("\n");
}
const actualTreeSHA256 = hash.digest("hex");

if (actualTreeSHA256 !== expectedTreeSHA256) {
  throw new Error(
    `@openclaw/contracts vendor tree SHA-256 mismatch: expected ${expectedTreeSHA256}, received ${actualTreeSHA256}`,
  );
}

if (
  JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).dependencies?.[
    "@openclaw/contracts"
  ]
) {
  throw new Error(
    "@openclaw/contracts must not be declared as an npm dependency; consume the vendored source tree only",
  );
}

console.log(
  `Verified vendored @openclaw/contracts@${expectedVersion} tree SHA-256 ${actualTreeSHA256}.`,
);
