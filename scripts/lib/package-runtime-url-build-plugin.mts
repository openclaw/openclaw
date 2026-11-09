import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** Keep dependency-owned native loaders and assets anchored to their installed package. */
export function createPackageRuntimeUrlBuildPlugin(packageName: string) {
  const require = createRequire(import.meta.url);
  const packageRoot = path.dirname(fs.realpathSync(require.resolve(`${packageName}/package.json`)));
  return {
    name: `openclaw:package-runtime-url:${packageName}`,
    transform(code: string, id: string) {
      const relative = path.relative(packageRoot, id);
      if (
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative) ||
        !relative.endsWith(".js") ||
        !code.includes("import.meta.url")
      ) {
        return null;
      }
      const originalUrl = `new URL(${JSON.stringify(relative.split(path.sep).join("/"))}, import.meta.resolve(${JSON.stringify(`${packageName}/package.json`)})).href`;
      return code
        .replaceAll("import.meta.url", originalUrl)
        .replace(
          /\brequire\(\s*(["'])(\.[^"']*)\1\s*\)/g,
          (call, _quote: string, specifier: string) => {
            if (
              path.resolve(path.dirname(id), specifier) !== path.join(packageRoot, "package.json")
            ) {
              return call;
            }
            // Keep the installed manifest explicit in the emitted package dependency graph.
            return `require(${JSON.stringify(`${packageName}/package.json`)})`;
          },
        );
    },
  };
}
