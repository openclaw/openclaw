// Links a plugin's source-installed dependency packages under its packaged root.
import fs from "node:fs";
import path from "node:path";

/**
 * Link plugin-owned packages under `<pluginDir>/node_modules` into `distNodeModules`
 * so packaged plugins resolve dependencies without linking checkout ancestors.
 */
export function linkSourcePluginDependencies(pluginDir, distNodeModules) {
  const sourceModules = path.join(pluginDir, "node_modules");
  if (!fs.existsSync(sourceModules)) {
    return;
  }
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
    const source = fs.realpathSync(path.join(sourceModules, name));
    const canonical =
      name === "openclaw" && source === checkoutRoot && fs.existsSync(hostAlias)
        ? fs.realpathSync(hostAlias)
        : source;
    const relative = path.relative(canonical, path.resolve(distNodeModules));
    if (relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative)) {
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // POSIX release checkouts relocate as a unit; Windows junctions require absolute targets.
    fs.symlinkSync(
      process.platform === "win32" ? canonical : path.relative(path.dirname(target), canonical),
      target,
      "junction",
    );
  }
}
