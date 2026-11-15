import { existsSync } from "node:fs";
import { join } from "node:path";
import { readBoundedRegularFile } from "./actions-artifact-archive.mjs";
import CORE_PACKAGE_POLICY from "./npm-core-release-packages.json" with { type: "json" };

export { CORE_PACKAGE_POLICY };

function readManifest(directory) {
  const path = join(directory, "package.json");
  return JSON.parse(readBoundedRegularFile(path, { label: path, maxBytes: 1024 * 1024 }));
}

export function collectPublishableCorePackages(rootDir, root = readManifest(rootDir)) {
  return CORE_PACKAGE_POLICY.filter((policy) => {
    const directory = join(rootDir, policy.path);
    if (
      policy.dependency
        ? typeof root.dependencies?.[policy.dependency] !== "string"
        : !existsSync(join(directory, "package.json"))
    ) {
      return false;
    }
    const manifest = readManifest(directory);
    if (!policy.dependency && manifest.openclaw?.release?.publishToNpm !== true) {
      return false;
    }
    if (manifest.name !== policy.name || manifest.version !== root.version) {
      throw new Error(`${policy.path}/package.json must publish ${policy.name}@${root.version}.`);
    }
    return true;
  });
}
