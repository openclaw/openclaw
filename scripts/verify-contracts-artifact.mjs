import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const expectedVersion = "0.1.0";
const expectedTreeSHA256 = "9d603e69d28eb76faabb3cfce7d756103ce0163929c53ae1256278711a616e7e";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = resolve(root, "vendor", "openclaw-contracts");
const packageJSON = JSON.parse(readFileSync(resolve(artifactRoot, "package.json"), "utf8"));

if (packageJSON.name !== "@openclaw/contracts" || packageJSON.version !== expectedVersion) {
  throw new Error(
    `@openclaw/contracts vendor package must be ${expectedVersion}, received ${packageJSON.name}@${packageJSON.version}`,
  );
}

if (packageJSON.dependencies || packageJSON.devDependencies || packageJSON.peerDependencies) {
  throw new Error("@openclaw/contracts vendor package must remain dependency-free");
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
