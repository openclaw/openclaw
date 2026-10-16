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
  const vitePath = path.resolve("ui/vite.config.ts");
  const viteSource = fs.readFileSync(vitePath, "utf8");
  const imports = [];
  for (const [, binding, specifier] of viteSource.matchAll(
    /\bconst\s+\{\s*module:\s*(\w+)\s*\}\s*=\s*await\s+runnerImport<typeof import\("([^"\r\n]+)"\)>/gu,
  )) {
    if (!binding || specifier !== "./src/app-route-paths.ts") {
      continue;
    }
    const members = new Set(
      [...viteSource.matchAll(new RegExp(`\\b${binding}\\.(\\w+)`, "gu"))].flatMap(([, member]) =>
        member ? [member] : [],
      ),
    );
    if (members.size === 0) {
      continue;
    }
    const target = path.resolve(path.dirname(vitePath), specifier);
    const relative = path
      .relative(path.dirname(path.resolve(filePath)), target)
      .replaceAll("\\", "/");
    const names = [...members].map((name, index) => `${name} as __vite${imports.length}_${index}`);
    imports.push(`import { ${names.join(", ")} } from ${JSON.stringify(relative)};`);
  }
  return `${source}\n${imports.join("\n")}`;
}
