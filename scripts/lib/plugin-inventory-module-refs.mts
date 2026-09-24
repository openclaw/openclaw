import path from "node:path";
import type { TsdownPlugin } from "tsdown";

const SDK = "openclaw/plugin-sdk/channel-entry-contract";
const HELPER = "defineBundledChannelSetupEntry";
const REFERENCE_SLOTS = [
  "plugin",
  "secrets",
  "runtime",
  "legacyStateMigrations",
  "legacySessionSurface",
];

/** Give the SDK's lazy companion declarations real edges in the inventory build graph. */
export function createPluginInventoryModuleRefsPlugin(pluginRoot: string): TsdownPlugin {
  const root = path.resolve(pluginRoot);
  return {
    name: "openclaw:inventory-module-refs",
    async transform(code, id) {
      if (!code.includes(SDK)) {
        return undefined;
      }
      const program = this.parse(code, { lang: /\.[cm]?tsx?$/.test(id) ? "ts" : "js" });
      const bindings = new Set<string>();
      const namespaces = new Set<string>();
      for (const statement of program.body) {
        if (
          statement.type !== "ImportDeclaration" ||
          statement.source.value !== SDK ||
          statement.importKind === "type"
        ) {
          continue;
        }
        for (const specifier of statement.specifiers) {
          if (specifier.type === "ImportNamespaceSpecifier") {
            namespaces.add(specifier.local.name);
          } else if (
            specifier.type === "ImportSpecifier" &&
            specifier.importKind !== "type" &&
            (specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : specifier.imported.value) === HELPER
          ) {
            bindings.add(specifier.local.name);
          }
        }
      }
      // These shipped entries export the declaration directly. Restricting this to
      // module scope prevents a shadowing parameter/local function from gaining edges.
      const declaration = program.body.find((node) => node.type === "ExportDefaultDeclaration");
      if (
        declaration?.type !== "ExportDefaultDeclaration" ||
        declaration.declaration.type !== "CallExpression"
      ) {
        return undefined;
      }
      const call = declaration.declaration;
      const callee = call.callee;
      const ownsCall =
        callee.type === "Identifier"
          ? bindings.has(callee.name)
          : callee.type === "MemberExpression" &&
            !callee.computed &&
            callee.object.type === "Identifier" &&
            namespaces.has(callee.object.name) &&
            callee.property.type === "Identifier" &&
            callee.property.name === HELPER;
      const options = call.arguments[0];
      if (!ownsCall || options?.type !== "ObjectExpression") {
        return undefined;
      }
      const property = (object: { properties: typeof options.properties }, name: string) =>
        object.properties.flatMap((entry) =>
          entry.type === "Property" &&
          !entry.computed &&
          entry.kind === "init" &&
          (entry.key.type === "Identifier"
            ? entry.key.name
            : entry.key.type === "Literal"
              ? entry.key.value
              : undefined) === name
            ? [entry.value]
            : [],
        )[0];
      const identifiers = new Set<string>();
      const visit = (node: unknown) => {
        if (Array.isArray(node)) {
          node.forEach(visit);
        } else if (node && typeof node === "object") {
          if (
            "type" in node &&
            node.type === "Identifier" &&
            "name" in node &&
            typeof node.name === "string"
          ) {
            identifiers.add(node.name);
          }
          Object.values(node).forEach(visit);
        }
      };
      visit(program);
      let fileURLToPathBinding = "__openclawFileURLToPath";
      while (identifiers.has(fileURLToPathBinding)) {
        fileURLToPathBinding += "_";
      }
      const edits: Array<{ start: number; end: number; value: string }> = [];
      for (const slot of REFERENCE_SLOTS) {
        const reference = property(options, slot);
        if (!reference) {
          continue;
        }
        const specifier =
          reference.type === "ObjectExpression" ? property(reference, "specifier") : undefined;
        if (specifier?.type !== "Literal" || typeof specifier.value !== "string") {
          this.error(
            `Inventory ${slot} reference in ${id} must declare a literal module specifier`,
          );
        }
        const resolved = await this.resolve(specifier.value, id);
        if (!resolved || resolved.external) {
          this.error(`Cannot resolve inventory ${slot} companion ${specifier.value} from ${id}`);
        }
        const relative = path.relative(root, resolved.id);
        if (
          !relative ||
          relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        ) {
          this.error(`Inventory companion leaves its plugin package: ${resolved.id}`);
        }
        const emitted = this.emitFile({
          type: "chunk",
          id: resolved.id,
          importer: id,
          preserveSignature: "strict",
        });
        // Stable SDKs resolve filesystem specifiers; keep the URL nested for capture.
        edits.push({
          start: specifier.start,
          end: specifier.end,
          value: `${fileURLToPathBinding}(import.meta.ROLLUP_FILE_URL_${emitted})`,
        });
      }
      if (edits.length) {
        const start =
          program.body.find(
            (node) =>
              node.type !== "ExpressionStatement" ||
              node.expression.type !== "Literal" ||
              typeof node.expression.value !== "string",
          )?.start ?? code.length;
        edits.push({
          start,
          end: start,
          value: `import { fileURLToPath as ${fileURLToPathBinding} } from "node:url";\n`,
        });
      }
      let transformed = code;
      for (const edit of edits.toSorted((left, right) => right.start - left.start)) {
        transformed = transformed.slice(0, edit.start) + edit.value + transformed.slice(edit.end);
      }
      return edits.length ? { code: transformed, map: null } : undefined;
    },
  };
}
