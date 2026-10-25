import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";
import { build } from "esbuild";
import { IsLiteralString, Type } from "typebox";
import * as Format from "typebox/format";
import {
  Build,
  BuildContext,
  CreateFunction,
  GetExternal,
  GetFunctions,
  HasUnevaluated,
  Intern,
  IsProperties,
  ResetExternal,
  ResetFunctions,
  ResetUnique,
  Stack,
  type XSchema,
} from "typebox/schema";

export type StandaloneValidatorEntry = {
  name: string;
  schema: XSchema;
  context?: Record<PropertyKey, XSchema>;
};

export type StandaloneValidatorOptions = {
  resolveDir?: string;
  /** Authored source imports used by explicitly bound external values. */
  imports?: readonly string[];
  /** Captures must have an explicit static owner; arbitrary closures are never serialized. */
  externals?: ReadonlyMap<unknown, string>;
  /** Share repeated schema shapes within one authored module's validation scope. */
  shareSchemaFunctions?: boolean;
  /** Keep a shared predicate pool tree-shakeable across its consuming modules. */
  hoistSchemaFunctions?: boolean;
};

const typeboxBuildRoot = path.dirname(fileURLToPath(import.meta.resolve("typebox")));
type SyntaxNode = { type: string; [key: string]: unknown };

function isSyntaxNode(value: unknown): value is SyntaxNode {
  return (
    typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
  );
}

function identifier(value: unknown): string | undefined {
  return isSyntaxNode(value) && value.type === "Identifier" && typeof value.name === "string"
    ? value.name
    : undefined;
}

function visitSyntax(source: string, callback: (node: SyntaxNode) => void): void {
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null) {
      return;
    }
    if (isSyntaxNode(value)) {
      callback(value);
    }
    for (const entry of Object.values(value)) {
      visit(entry);
    }
  };
  visit(parse(source, { ecmaVersion: "latest", sourceType: "module" }));
}

function onlyStringUniqueItems(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return true;
  }
  if (
    "uniqueItems" in value &&
    value.uniqueItems === true &&
    !(Type.IsArray(value) && Type.IsUnion(value.items) && value.items.anyOf.every(IsLiteralString))
  ) {
    return false;
  }
  return Object.values(value).every(onlyStringUniqueItems);
}

function removeStringEnumHashing(source: string): string {
  const ranges: Array<{ start: number; end: number }> = [];
  visitSyntax(source, (node) => {
    if (node.type !== "CallExpression") {
      return;
    }
    const callee = node.callee;
    const argument =
      Array.isArray(node.arguments) && node.arguments.length === 1 ? node.arguments[0] : undefined;
    if (
      isSyntaxNode(callee) &&
      callee.type === "MemberExpression" &&
      callee.computed === false &&
      identifier(callee.property) === "map" &&
      isSyntaxNode(callee.object) &&
      typeof callee.object.end === "number" &&
      typeof node.end === "number" &&
      isSyntaxNode(argument) &&
      argument.type === "MemberExpression" &&
      argument.computed === false &&
      identifier(argument.object) === "Hashing" &&
      identifier(argument.property) === "Hash"
    ) {
      ranges.push({ start: callee.object.end, end: node.end });
    }
  });
  let rewritten = source;
  for (const { start, end } of ranges.toSorted((a, b) => b.start - a.start)) {
    rewritten = rewritten.slice(0, start) + rewritten.slice(end);
  }
  return rewritten;
}

function compilerHelpers(source: string): Array<{ name: string; start: number; end: number }> {
  const references: Array<{ name: string; start: number; end: number }> = [];
  visitSyntax(source, (node) => {
    if (node.type !== "MemberExpression") {
      return;
    }
    const namespace = identifier(node.object);
    if (namespace === "Guard" || namespace === "Hashing") {
      const name = node.computed === false ? identifier(node.property) : undefined;
      if (!name) {
        throw new Error(`Unsupported dynamic standalone TypeBox helper: ${namespace}`);
      }
      if (typeof node.start !== "number" || typeof node.end !== "number") {
        throw new Error("Standalone helper reference has no source range");
      }
      references.push({ name: `${namespace}.${name}`, start: node.start, end: node.end });
    }
  });
  return references;
}

export function assertStandaloneValidatorSource(source: string): void {
  const generators = new Set(["eval", "Function", "require"]);
  visitSyntax(source, (node) => {
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ImportExpression" ||
      ((node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
        node.source)
    ) {
      throw new Error("Generated validators must not import runtime dependencies");
    }
    if (node.type !== "CallExpression" && node.type !== "NewExpression") {
      return;
    }
    let name = identifier(node.callee);
    if (
      isSyntaxNode(node.callee) &&
      node.callee.type === "MemberExpression" &&
      identifier(node.callee.object) === "globalThis"
    ) {
      name = node.callee.computed === false ? identifier(node.callee.property) : undefined;
    }
    if (name && generators.has(name)) {
      throw new Error("Generated validators must be standalone and codegen-free");
    }
  });
}

function builtInFormats(): Map<unknown, { name: string; module: string }> {
  const exports = new Map(Object.entries(Format));
  return new Map(
    Format.Entries().flatMap(([format, check]) =>
      exports.get(check.name) === check
        ? [[check, { name: check.name, module: format.replaceAll("-", "_") }]]
        : [],
    ),
  );
}

/** Bind compiler output to explicit static captures and the compiler's exact helpers. */
export function emitStandaloneValidatorSource(
  binding: string,
  functions: string,
  variables: readonly unknown[],
  entry: string,
  options: StandaloneValidatorOptions & {
    externalIdentifier?: string;
    moduleEntries?: ReadonlyArray<{ name: string; expression: string }>;
  } = {},
): { source: string; imports: string[] } {
  const imports = new Set(options.imports ?? []);
  const formats = builtInFormats();
  const active = new WeakSet<object>();
  const unsupported = (owner: string): never => {
    throw new Error(`${owner}: unsupported standalone external value; bind its static owner`);
  };
  const property = (object: object, key: string, owner: string): string => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return unsupported(owner);
    }
    return external(descriptor.value, owner);
  };
  const external = (value: unknown, owner: string): string => {
    const authored = options.externals?.get(value);
    if (authored !== undefined) {
      return authored;
    }
    if (value instanceof RegExp) {
      return value.toString();
    }
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      const literal = JSON.stringify(value);
      if (literal !== undefined) {
        return literal;
      }
    }
    const format = formats.get(value);
    if (format) {
      const source = path.join(typeboxBuildRoot, "format", `${format.module}.mjs`);
      imports.add(`import { ${format.name} } from ${JSON.stringify(source)};`);
      return format.name;
    }
    if (typeof value === "object" && value !== null) {
      if (active.has(value)) {
        return unsupported(owner);
      }
      active.add(value);
      try {
        if (Array.isArray(value)) {
          if (Reflect.ownKeys(value).length !== value.length + 1) {
            return unsupported(owner);
          }
          return `[${Array.from({ length: value.length }, (_, index) => property(value, String(index), owner)).join(",")}]`;
        }
        const prototype: unknown = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
          return unsupported(owner);
        }
        const entries = Reflect.ownKeys(value).map((key) => {
          if (typeof key !== "string") {
            return unsupported(owner);
          }
          // Computed keys preserve __proto__ as data instead of changing the prototype.
          return `[${JSON.stringify(key)}]: ${property(value, key, owner)}`;
        });
        const literal = `({ ${entries.join(",")} })`;
        return prototype === null ? `Object.assign(Object.create(null), ${literal})` : literal;
      } finally {
        active.delete(value);
      }
    }
    return unsupported(owner);
  };

  const captures = variables.map((value) => external(value, binding));
  const declarations = `const ${options.externalIdentifier ?? "External"} = [${captures.join(",")}];
    ${functions};`;
  const source = options.moduleEntries
    ? `${declarations}\n${options.moduleEntries.map(({ name, expression }) => `export const ${name} = ${expression};`).join("\n")}`
    : `export const ${binding} = /* @__PURE__ */ (() => {
      ${declarations}
      return ${entry};
    })();`;
  const helpers: Record<string, { module: string; name: string }> = {
    "Guard.CodePointCount": { module: "guard/unicode/unicode.mjs", name: "CodePointCount" },
    "Guard.IsConstructor": { module: "guard/guard.mjs", name: "IsConstructor" },
    "Guard.IsDeepEqual": { module: "guard/guard.mjs", name: "IsDeepEqual" },
    "Guard.IsMultipleOf": { module: "guard/guard.mjs", name: "IsMultipleOf" },
    "Hashing.Hash": { module: "system/hashing/hash.mjs", name: "Hash" },
  };
  const references = compilerHelpers(source);
  for (const reference of new Set(references.map(({ name }) => name))) {
    if (!Object.hasOwn(helpers, reference)) {
      throw new Error(`Unsupported standalone TypeBox helper: ${reference}`);
    }
  }
  for (const [reference, helper] of Object.entries(helpers)) {
    if (!references.some(({ name }) => name === reference)) {
      continue;
    }
    imports.add(
      `import { ${helper.name} as __${reference.replace(".", "_")} } from ${JSON.stringify(path.join(typeboxBuildRoot, helper.module))};`,
    );
  }
  let boundSource = source;
  for (const { name, start, end } of references.toSorted(
    (left, right) => right.start - left.start,
  )) {
    boundSource = `${boundSource.slice(0, start)}__${name.replace(".", "_")}${boundSource.slice(end)}`;
  }
  return {
    source: boundSource,
    imports: [...imports],
  };
}

/** Emit standalone checks from canonical schemas without runtime source compilation. */
export async function compileStandaloneValidators(
  entries: readonly StandaloneValidatorEntry[],
  options: StandaloneValidatorOptions = {},
): Promise<string> {
  const names = new Set<string>();
  const imports = new Set(options.imports ?? []);
  for (const { name } of entries) {
    if (!/^[A-Za-z_$][\w$]*$/.test(name) || names.has(name)) {
      throw new Error(`Invalid or duplicate standalone validator binding: ${name}`);
    }
    names.add(name);
  }
  const collect = (emitted: ReturnType<typeof emitStandaloneValidatorSource>): string => {
    for (const statement of emitted.imports) {
      imports.add(statement);
    }
    return emitted.source;
  };
  // Finite string enums have the same equality under Set and TypeBox hashing.
  // Explicit reference contexts can introduce other uniqueness rules.
  const stringEnumsOnly = entries.every(
    ({ schema, context }) => context === undefined && onlyStringUniqueItems(schema),
  );
  const optimizeFunctions = (source: string) =>
    stringEnumsOnly ? removeStringEnumHashing(source) : source;
  let checks: string[];
  if (options.shareSchemaFunctions) {
    if (entries.some(({ context }) => context !== undefined)) {
      throw new Error(
        "Shared standalone checks require one schema scope without per-entry contexts",
      );
    }
    const shared = Intern({
      type: "object",
      properties: Object.fromEntries(entries.map(({ name, schema }) => [name, schema])),
    });
    const root = shared.$defs[shared.$ref.slice("#/$defs/".length)];
    if (!root || !IsProperties(root)) {
      throw new Error("Shared standalone checks require an object schema");
    }
    ResetUnique();
    ResetExternal();
    ResetFunctions();
    const useUnevaluated = HasUnevaluated({}, shared);
    const context = new BuildContext(useUnevaluated);
    const stack = Stack({}, shared);
    if (useUnevaluated) {
      imports.add(`import { CheckContext } from "typebox/schema";`);
    }
    const entryPoints = Object.entries(root.properties).map(([name, schema]) => {
      const expression = CreateFunction(stack, context, schema, "value");
      const check = useUnevaluated
        ? `value => { const context = new CheckContext(); return ${expression}; }`
        : `value => ${expression}`;
      return { name, expression: check };
    });
    checks = [
      collect(
        emitStandaloneValidatorSource(
          `{ ${entries.map(({ name }) => name).join(", ")} }`,
          optimizeFunctions(GetFunctions().join(";\n")),
          GetExternal().variables,
          `{ ${entryPoints.map(({ name, expression }) => `${name}: ${expression}`).join(", ")} }`,
          {
            ...options,
            externalIdentifier: GetExternal().identifier,
            moduleEntries: options.hoistSchemaFunctions ? entryPoints : undefined,
          },
        ),
      ),
    ];
  } else {
    checks = entries.map(({ name, schema, context }) => {
      const compiled = Build(context ?? {}, schema);
      if (compiled.UseUnevaluated()) {
        imports.add(`import { CheckContext } from "typebox/schema";`);
      }
      const check = compiled.UseUnevaluated()
        ? `value => { const context = new CheckContext(); return ${compiled.Entry()}; }`
        : `value => ${compiled.Entry()}`;
      const emitted = emitStandaloneValidatorSource(
        name,
        optimizeFunctions(compiled.Functions().join(";\n")),
        compiled.External().variables,
        check,
        { ...options, externalIdentifier: compiled.External().identifier },
      );
      return collect(emitted);
    });
  }
  const result = await build({
    stdin: {
      contents: [...imports, ...checks].join("\n"),
      resolveDir: options.resolveDir ?? process.cwd(),
      loader: "js",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    write: false,
    minifySyntax: true,
    minifyWhitespace: true,
    legalComments: "none",
  });
  const runtime = result.outputFiles[0]?.text;
  if (runtime === undefined) {
    throw new Error("Standalone validator build emitted no output");
  }
  assertStandaloneValidatorSource(runtime);
  return runtime;
}

/** Retain TypeBox's license alongside bundled generated helper code. */
export function standaloneValidatorLicense(): string {
  const license = readFileSync(path.resolve(typeboxBuildRoot, "../license"), "utf8").trim();
  return `/*!\n${license}\n*/\n`;
}

/** Generated compiler output is checked through schema parity, not source style rules. */
export function standaloneValidatorHeader(
  command: string,
  options: {
    declaration?: boolean;
    lintRules?: readonly string[];
    additionalLintRules?: readonly string[];
  } = {},
): string {
  const marker = `// Generated by ${command}; do not edit.\n`;
  const rules = [
    ...(options.lintRules ?? [
      "eslint/no-unused-vars",
      "eslint/prefer-const",
      "eslint/no-unused-expressions",
      "eslint/no-implicit-coercion",
      "eslint/no-var",
    ]),
    ...(options.additionalLintRules ?? []),
  ];
  return options.declaration
    ? marker
    : `${marker}/* oxlint-disable ${rules.join(", ")} -- Generated TypeBox validators; canonical schema parity is tested. */\n${standaloneValidatorLicense()}`;
}
