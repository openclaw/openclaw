import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";

/**
 * @param {string} source
 * @param {string} filePath
 * @returns {string}
 */
export function compileViteConfigConsumers(source, filePath) {
  // Vite config is excluded from Knip's production graph. Model its real
  // runnerImport property reads here without disabling Vite's alias discovery.
  const imports = [];
  const controlUiVitePath = path.resolve("ui/vite.config.ts");
  const controlUiViteSource = fs.readFileSync(controlUiVitePath, "utf8");
  // The script-export pass deliberately excludes the UI workspace. Preserve
  // ordinary UI-to-script imports without pulling the UI source tree into it.
  for (const [, names, specifier] of controlUiViteSource.matchAll(
    /^\s*import\s*\{([^}]+)\}\s*from\s*["'](\.\.\/scripts\/[^"'\r\n]+)["'];?/gmu,
  )) {
    const target = path.resolve(path.dirname(controlUiVitePath), specifier);
    const relative = path
      .relative(path.dirname(path.resolve(filePath)), target)
      .replaceAll("\\", "/");
    imports.push(`import {${names}} from ${JSON.stringify(relative)};`);
  }
  for (const [sourcePath, moduleSpecifier] of [
    ["ui/vite.config.ts", "./src/app-route-paths.ts"],
    ["ui/config/control-ui-locales.ts", "../../scripts/lib/control-ui-i18n-catalog.ts"],
  ]) {
    const vitePath = path.resolve(sourcePath);
    const viteSource =
      vitePath === controlUiVitePath ? controlUiViteSource : fs.readFileSync(vitePath, "utf8");
    for (const [, alias, specifier] of viteSource.matchAll(
      /\bconst\s+\{\s*module(?:\s*:\s*(\w+))?(?:\s*,\s*dependencies(?:\s*:\s*\w+)?)?\s*\}\s*=\s*await\s+runnerImport<\s*typeof import\("([^"\r\n]+)"\)\s*>/gu,
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
  for (const sourcePath of [
    "ui/src/components/settings-sidebar-lazy.tsx",
    "ui/src/app/app-shell-loader.tsx",
  ]) {
    const lazyPath = path.resolve(sourcePath);
    const ast = parse(fs.readFileSync(lazyPath, "utf8"), {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
      createImportExpressions: true,
    });
    traverse(ast, {
      CallExpression(call) {
        const { callee, arguments: args } = call.node;
        const binding =
          callee.type === "Identifier" ? call.scope.getBinding(callee.name) : undefined;
        if (
          !binding?.path.isImportSpecifier() ||
          binding.path.node.imported.name !== "lazy" ||
          binding.path.parentPath.node.source.value !== "solid-js"
        ) {
          return;
        }
        const [loader, options] = args;
        if (loader?.type !== "ArrowFunctionExpression" || options?.type !== "ObjectExpression") {
          return;
        }
        const selected = options.properties.find(
          (property) => property.type === "ObjectProperty" && property.key.name === "export",
        );
        if (selected?.value.type !== "StringLiteral") {
          return;
        }
        let imported = loader.body;
        if (imported.type === "BlockStatement") {
          const result = imported.body.find((statement) => statement.type === "ReturnStatement");
          const moduleBinding =
            result?.argument?.type === "Identifier"
              ? call.get("arguments.0").scope.getBinding(result.argument.name)
              : undefined;
          if (
            !moduleBinding?.path.isVariableDeclarator() ||
            moduleBinding.kind !== "const" ||
            moduleBinding.scope.path.node !== loader
          ) {
            return;
          }
          imported = moduleBinding.path.node.init;
        }
        if (imported?.type === "AwaitExpression") {
          imported = imported.argument;
        }
        if (imported?.type !== "ImportExpression" || imported.source.type !== "StringLiteral") {
          return;
        }
        const relative = path
          .relative(
            path.dirname(path.resolve(filePath)),
            path.resolve(path.dirname(lazyPath), imported.source.value),
          )
          .replaceAll("\\", "/");
        imports.push(
          `import { ${selected.value.value} as __solidLazy${imports.length} } from ${JSON.stringify(relative)};`,
        );
      },
    });
  }
  return `${source}\n${imports.join("\n")}`;
}
