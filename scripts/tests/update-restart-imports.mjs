import { visitJavaScriptStatements } from "../lib/javascript-statements.mjs";

export function collectRestartImports(source) {
  const imports = new Map();
  visitJavaScriptStatements(source, { sourceType: "module" }, (statements) => {
    for (const statement of statements) {
      if (
        !["ImportDeclaration", "ExportNamedDeclaration"].includes(statement.type) ||
        !statement.source
      ) {
        continue;
      }
      const specifier = statement.source.value;
      const names = imports.get(specifier) ?? new Set();
      imports.set(specifier, names);
      for (const binding of statement.specifiers) {
        if (binding.type === "ImportDefaultSpecifier") {
          names.add("default");
        } else if (binding.type === "ImportSpecifier" || binding.type === "ExportSpecifier") {
          const imported = binding.imported ?? binding.local;
          names.add(imported.name ?? imported.value);
        }
      }
    }
  });
  return imports;
}
