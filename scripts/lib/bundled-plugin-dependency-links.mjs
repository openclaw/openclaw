// Links a plugin's source-installed dependency packages under its packaged root.
import fs from "node:fs";
import path from "node:path";

/** Link one installed package identity without copying or replacing its bytes. */
export function linkInstalledPackageDirectory(source, target) {
  const canonical = fs.realpathSync(source);
  const destination = path.resolve(target);
  const relative = path.relative(canonical, destination);
  if (relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative)) {
    return false;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.symlinkSync(
    process.platform === "win32" ? canonical : path.relative(path.dirname(destination), canonical),
    destination,
    "junction",
  );
  return true;
}

/**
 * Link plugin-owned packages under `<pluginDir>/node_modules` into `distNodeModules`
 * so packaged plugins resolve dependencies without linking checkout ancestors.
 */
export function linkSourcePluginDependencies(pluginDir, distNodeModules) {
  const sourceModules = path.join(pluginDir, "node_modules");
  if (!fs.existsSync(sourceModules)) {
    return;
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"));
  const optional = new Set([
    ...Object.keys(packageJson.optionalDependencies ?? {}),
    ...Object.entries(packageJson.peerDependenciesMeta ?? {})
      .filter(([, metadata]) => metadata.optional === true)
      .map(([name]) => name),
  ]);
  const packages = fs.readdirSync(sourceModules).flatMap((name) => {
    if (name.startsWith(".") && name !== ".bin") {
      return [];
    }
    return name.startsWith("@")
      ? fs.readdirSync(path.join(sourceModules, name)).map((child) => path.join(name, child))
      : [name];
  });
  // An outer node_modules junction misresolves pnpm's relative links on Windows.
  // Link canonical package roots individually; keep scopes real and payloads source-owned.
  // Preserve .bin for managed launchers that resolve the plugin's private CLI shim.
  const hostAlias = path.resolve(distNodeModules, "../../node_modules/openclaw");
  const checkoutRoot = fs.realpathSync(path.resolve(pluginDir, "../.."));
  for (const name of packages) {
    const target = path.join(distNodeModules, name);
    let source;
    try {
      source = fs.realpathSync(path.join(sourceModules, name));
    } catch (error) {
      if (optional.has(name) && error?.code === "ENOENT") {
        console.warn(
          `[bundled-plugin-dependency-links] ${path.basename(pluginDir)}: optional dependency ${name} is unavailable; continuing without its link`,
        );
        continue;
      }
      throw error;
    }
    const canonical =
      name === "openclaw" && source === checkoutRoot && fs.existsSync(hostAlias)
        ? fs.realpathSync(hostAlias)
        : source;
    linkInstalledPackageDirectory(canonical, target);
  }
}
