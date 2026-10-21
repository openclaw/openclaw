import fs from "node:fs";
import path from "node:path";

/**
 * @param {string} source
 * @param {string} filePath
 * @returns {string}
 */
export function compileViteConfigConsumers(source, filePath) {
  // Vite config is excluded from Knip's production graph. Model its real
  // runnerImport property reads here without disabling Vite's alias discovery.
  const imports = [];
  for (const [sourcePath, moduleSpecifier] of [
    ["ui/vite.config.ts", "./src/app-route-paths.ts"],
    ["ui/config/control-ui-locales.ts", "../../scripts/lib/control-ui-i18n-catalog.ts"],
  ]) {
    const vitePath = path.resolve(sourcePath);
    const viteSource = fs.readFileSync(vitePath, "utf8");
    for (const [, alias, specifier] of viteSource.matchAll(
      /\bconst\s+\{\s*module(?:\s*:\s*(\w+))?(?:\s*,\s*dependencies)?\s*\}\s*=\s*await\s+runnerImport<\s*typeof import\("([^"\r\n]+)"\)\s*>/gu,
    )) {
      if (specifier !== moduleSpecifier) {
        continue;
      }
      const binding = alias ?? "module";
      const members = new Set(
        [...viteSource.matchAll(new RegExp(`\\b${binding}\\.(\\w+)`, "gu"))].flatMap(
          ([, member]) => (member ? [member] : []),
        ),
      );
      if (members.size === 0) {
        continue;
      }
      const target = path.resolve(path.dirname(vitePath), specifier);
      const relative = path
        .relative(path.dirname(path.resolve(filePath)), target)
        .replaceAll("\\", "/");
      const names = [...members].map(
        (name, index) => `${name} as __vite${imports.length}_${index}`,
      );
      imports.push(`import { ${names.join(", ")} } from ${JSON.stringify(relative)};`);
    }
  }
  // Solid's named lazy export is selected by a string rather than a property
  // read. Derive the edge from the live loader so deleting it stays detectable.
  const lazyPath = path.resolve("ui/src/components/settings-sidebar-lazy.tsx");
  const lazySource = fs.readFileSync(lazyPath, "utf8");
  for (const [, specifier, name] of lazySource.matchAll(
    /\blazy\(\(\) => import\("([^"\r\n]+)"\),\s*\{\s*export:\s*"(\w+)"/gu,
  )) {
    const relative = path
      .relative(
        path.dirname(path.resolve(filePath)),
        path.resolve(path.dirname(lazyPath), specifier),
      )
      .replaceAll("\\", "/");
    imports.push(
      `import { ${name} as __solidLazy${imports.length} } from ${JSON.stringify(relative)};`,
    );
  }
  return `${source}\n${imports.join("\n")}`;
}
