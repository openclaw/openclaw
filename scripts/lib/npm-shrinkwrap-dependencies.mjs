import { isRecord } from "./record-shared.mjs";

// A shipped shrinkwrap is npm's install tree, not merely dependency evidence.
// Check the packed manifest: pnpm resolves workspace: declarations during pack.
export function assertNpmShrinkwrapDependencies(manifest, shrinkwrap) {
  const packages = shrinkwrap?.packages;
  const rootDependencies = packages?.[""]?.dependencies;
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    // npm lets optionalDependencies override dependencies, including platform skips.
    if (Object.hasOwn(manifest.optionalDependencies ?? {}, name)) {
      continue;
    }
    const installed = packages?.[`node_modules/${name}`];
    if (!Object.hasOwn(rootDependencies ?? {}, name) || !isRecord(installed)) {
      throw new Error(`npm-shrinkwrap.json is missing declared dependency ${name}`);
    }
    if (rootDependencies[name] !== spec) {
      throw new Error(`npm-shrinkwrap.json dependency spec mismatch ${name}`);
    }
    if (
      installed.link === true ||
      installed.dev === true ||
      typeof installed.version !== "string" ||
      !installed.version
    ) {
      throw new Error(`npm-shrinkwrap.json invalid runtime package ${name}`);
    }
  }
}
