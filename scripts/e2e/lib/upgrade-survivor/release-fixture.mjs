import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// This fixture proves release handoff, not a state migration. Runtime code stays unchanged.
export function prepareReleaseFixture(sourceTarball, directory) {
  fs.mkdirSync(directory, { recursive: true });
  execFileSync("tar", ["-xzf", sourceTarball, "-C", directory]);
  const root = path.join(directory, "package");
  const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
  const write = (file, value) =>
    fs.writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
  const manifest = read("package.json");
  const build = read("dist/build-info.json");
  const previous = { version: manifest.version, buildId: build.buildId, commit: build.commit };
  assert(
    previous.buildId && previous.commit,
    "packed current checkout must carry its build identity",
  );
  const version = /^(\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?$/u.exec(manifest.version);
  assert(version, "current package must have a release version");
  manifest.version = `${version[1]}.${version[2]}.${Number(version[3]) + 1}-beta.1`;
  build.version = manifest.version;
  build.buildId = `${previous.buildId}-release-survivor-next`;
  write("package.json", manifest);
  write("dist/build-info.json", build);
  const inventory = read("dist/postinstall-content-inventory.json");
  const entry = inventory.find((item) => item.path === "dist/build-info.json");
  assert(entry, "build identity must be covered by the package content inventory");
  const bytes = fs.readFileSync(path.join(root, entry.path));
  entry.size = bytes.byteLength;
  entry.sha256 = createHash("sha256").update(bytes).digest("hex");
  write("dist/postinstall-content-inventory.json", inventory);
  const tarball = path.join(directory, "next.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", directory, "package"]);
  fs.rmSync(root, { recursive: true });
  return { previous, next: { version: build.version, buildId: build.buildId, tarball } };
}
