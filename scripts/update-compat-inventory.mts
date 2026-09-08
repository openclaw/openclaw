#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  recordUpdateCompatibilityRelease,
  readUpdateCompatibilityInventory,
  type UpdateCompatibilityInventory,
} from "./lib/update-compat-chunks.mts";

const { values } = parseArgs({
  options: {
    "package-dir": { type: "string" },
    integrity: { type: "string" },
    "beta-package-dir": { type: "string" },
    "beta-integrity": { type: "string" },
    output: { type: "string", default: "scripts/lib/update-compat-inventory.json" },
    check: { type: "boolean", default: false },
  },
});
if (
  !values["package-dir"] ||
  !values.integrity ||
  Boolean(values["beta-package-dir"]) !== Boolean(values["beta-integrity"])
) {
  throw new Error(
    "Usage: node scripts/update-compat-inventory.mts --package-dir <unpacked-release> --integrity <npm-dist.integrity> [--beta-package-dir <unpacked-beta> --beta-integrity <npm-dist.integrity>] [--output <file>] [--check]",
  );
}
const inventory: UpdateCompatibilityInventory = {
  schemaVersion: 1,
  releases: [
    recordUpdateCompatibilityRelease({
      packageDir: values["package-dir"],
      integrity: values.integrity,
    }),
  ],
};
if (values["beta-package-dir"] && values["beta-integrity"]) {
  inventory.releases.push(
    recordUpdateCompatibilityRelease({
      packageDir: values["beta-package-dir"],
      integrity: values["beta-integrity"],
    }),
  );
}
const output = path.resolve(values.output);
const contents = `${JSON.stringify(inventory, null, 2)}\n`;
if (values.check) {
  readUpdateCompatibilityInventory(output);
  if (fs.readFileSync(output, "utf8") !== contents) {
    throw new Error(`Stale update compatibility inventory: ${output}`);
  }
} else {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, contents);
  readUpdateCompatibilityInventory(output);
}
console.log(
  `${values.check ? "Verified" : "Recorded"} update compatibility inventory: ${inventory.releases.map((release) => `${release.version} (${release.chunks.length} chunks)`).join(", ")}`,
);
