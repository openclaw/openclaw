// Versioned copies of the actual candidate keep its executable code and schema contract.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function packNodeUpdateFixture({ tarball, root, repository, env, version, malformed }) {
  const directory = path.join(root, `variant-${version}`);
  fs.mkdirSync(directory);
  execFileSync("tar", ["-xzf", tarball, "-C", directory]);
  const packageRoot = path.join(directory, "package");
  for (const relative of ["package.json", "dist/build-info.json"]) {
    const filename = path.join(packageRoot, relative);
    const value = JSON.parse(fs.readFileSync(filename, "utf8"));
    value.version = version;
    fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
  }
  if (malformed) {
    fs.unlinkSync(path.join(packageRoot, "node-host-launcher.mjs"));
  }
  execFileSync(
    process.execPath,
    [
      "--import",
      "./scripts/tsx.mjs",
      "--input-type=module",
      "-e",
      "import { writePackageDistInventoryForPublish } from './scripts/lib/package-dist-inventory.ts'; await writePackageDistInventoryForPublish(process.argv[1]);",
      packageRoot,
    ],
    { cwd: repository, env, stdio: "pipe" },
  );
  const output = path.join(root, `openclaw-${version}.tgz`);
  execFileSync("tar", ["-czf", output, "-C", directory, "package"]);
  return {
    output,
    version,
    malformed,
    sha256: createHash("sha256").update(fs.readFileSync(output)).digest("hex"),
  };
}
