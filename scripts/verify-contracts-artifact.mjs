import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const expectedDependency = "file:vendor/packages/openclaw-contracts-0.1.0.tgz";
const expectedSHA256 = "5863c0b19a6ecb3c552392bac2074dd72ee67a5a8dc0061760a1b0257c62465a";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJSON = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

if (packageJSON.dependencies?.["@openclaw/contracts"] !== expectedDependency) {
  throw new Error(
    `@openclaw/contracts must use the approved relative artifact ${expectedDependency}`,
  );
}

const artifact = resolve(root, "vendor", "packages", "openclaw-contracts-0.1.0.tgz");
const actualSHA256 = createHash("sha256").update(readFileSync(artifact)).digest("hex");

if (actualSHA256 !== expectedSHA256) {
  throw new Error(
    `@openclaw/contracts artifact SHA-256 mismatch: expected ${expectedSHA256}, received ${actualSHA256}`,
  );
}

console.log(`Verified @openclaw/contracts@0.1.0 SHA-256 ${actualSHA256}.`);
