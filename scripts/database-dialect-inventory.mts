import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript/unstable/ast";
import { createNativeTypeScriptParser } from "./lib/native-typescript.mts";
import { loadRatchetSources } from "./lib/shrink-ratchet.mts";
import {
  CONFLICT_METHOD,
  matchDialect,
  SQLITE_PRIMITIVE_OWNERS,
  SQLITE_PHYSICAL_LAYOUT_OWNERS,
  type DialectMatch,
} from "./lib/sqlite-dialect-constructs.mts";

// Share test exclusions with database-worker-inventory.mjs.
const excluded =
  /(?:^|\/)(?:__tests__|__fixtures__|test|tests|test-utils|test-helpers|test-support|test-fixtures|test-harness|fixtures|e2e)(?:\/|$)|(?:^|[/.-])(?:test|spec|e2e|test-support|test-helpers|test-fixtures|test-harness|test-runtime)(?:[.-])/;
type DialectSite = DialectMatch & { line: number; column: number };
export type DialectInventoryRow = { file: string; matches: DialectSite[] };
export type DialectInventoryCache = Map<string, { text: string; matches: DialectSite[] }>;
const roots = ["src", "extensions", "packages"];
const SQL_STATEMENT =
  /^[\s(]*(?:SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH|CREATE|DROP|ALTER|PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|VACUUM|ATTACH|DETACH|ANALYZE|REINDEX|EXPLAIN)\b/u;

function productionFile(file: string) {
  return (
    /^(?:src|extensions|packages)\/.*\.(?:ts|mts|sql)$/u.test(file) &&
    !excluded.test(file) &&
    // PostgreSQL shares JSON function/operator names with SQLite; these artifacts contain no SQLite.
    !/^src\/state\/postgres-schema\.generated\/[^/]+\.postgres\.sql$/u.test(file) &&
    // Captured SQLite catalog text is comparison data, never executable SQL. Source DDL stays counted.
    !/^src\/state\/postgres-schema\.generated\/sqlite-(?:state|agent)-catalogs\.ts$/u.test(file)
  );
}

function gitPaths(root: string, args: string[]) {
  const result = spawnSync("git", ["--literal-pathspecs", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(result.stderr || "SQLite dialect Git path scan failed");
  }
  return result.stdout.split("\0").filter(productionFile);
}

export function changedProductionFiles(root: string, base: string, staged: boolean) {
  return [
    ...new Set([
      ...gitPaths(root, [
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        ...(staged ? ["--cached"] : []),
        base,
        "--",
        ...roots,
      ]),
      ...(staged
        ? []
        : gitPaths(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...roots])),
    ]),
  ].toSorted();
}

function findSites(file: string, source: ts.SourceFile): DialectSite[] {
  const sites: DialectSite[] = [];
  const postgresGuards = new Set<string>();
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      path.posix.normalize(
        path.posix.join(path.posix.dirname(file), statement.moduleSpecifier.text),
      ) === "src/infra/sql-connection.js" &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      for (const binding of statement.importClause.namedBindings.elements) {
        if ((binding.propertyName?.text ?? binding.name.text) === "isPostgresSqlConnection") {
          postgresGuards.add(binding.name.text);
        }
      }
    }
  }
  const isPostgresGuard = (node: ts.Expression) =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    postgresGuards.has(node.expression.text);
  const physicalLayoutOwner = SQLITE_PHYSICAL_LAYOUT_OWNERS.includes(file);
  const add = (match: DialectMatch, position: number, postgres = false, text = "") => {
    // Only these shared names have proven PostgreSQL callers; SQLite-only JSON stays debt.
    if (postgres && /^(?:json_each|jsonb_set)\s*\(/iu.test(text.slice(match.index))) {
      return;
    }
    // These engine owners define/call PostgreSQL functions, not SQLite connection UDFs.
    if (
      match.construct === "custom-function" &&
      (file === "src/infra/database-engine/postgres-search-schema.ts" ||
        file === "src/infra/database-engine/postgres-vector.ts")
    ) {
      return;
    }
    // This PostgreSQL-only worker owns a connection-local spool, not SQLite temp-schema debt.
    if (
      match.construct === "temp-schema" &&
      file === "extensions/memory-core/src/memory/manager-publication-postgres.ts"
    ) {
      return;
    }
    // Native migration locks and private archive row order have no PostgreSQL SQL equivalent.
    // Keep other constructs at these owners, and these constructs at callers, in the ratchet.
    const nativeMaintenance =
      (file === "src/infra/update-doctor-migration-attribution.ts" &&
        (match.construct === "transaction-mode" ||
          match.construct === "pragma" ||
          match.construct === "schema-version")) ||
      (file === "src/infra/sqlite-migration-scoped-snapshot.ts" && match.construct === "rowid");
    const { line, character } = source.getLineAndCharacterOfPosition(position);
    sites.push({
      ...match,
      group: nativeMaintenance ? "engine-maintenance" : match.group,
      owner: nativeMaintenance || match.owner || SQLITE_PRIMITIVE_OWNERS.includes(file),
      line: line + 1,
      column: character + 1,
    });
  };
  const literal = (
    node: ts.StringLiteral | ts.TemplateLiteralToken,
    owner: boolean,
    postgres: boolean,
  ) => {
    for (const match of matchDialect(node.text, owner, false, physicalLayoutOwner)) {
      // Locations identify the containing literal, independent of cooked escape widths.
      add(match, node.getStart(source), postgres, node.text);
    }
  };
  const template = (
    node: ts.TemplateLiteral,
    owner: boolean,
    postgres: boolean,
    tagged = false,
  ) => {
    const head = ts.isTemplateExpression(node) ? node.head : node;
    if (!tagged && !SQL_STATEMENT.test(head.text)) {
      return;
    }
    let text = "";
    const spans = (
      ts.isTemplateExpression(node)
        ? [head, ...node.templateSpans.map((span) => span.literal)]
        : [head]
    ).map((part) => {
      const start = text.length;
      // A barrier preserves quotation state without joining tokens across substitutions.
      text += part.text + "\0";
      return { part, start };
    });
    const matches = matchDialect(text, owner, false, physicalLayoutOwner);
    for (const { part, start } of spans) {
      for (const match of matches) {
        if (match.index >= start && match.index < start + part.text.length) {
          add({ ...match, index: match.index - start }, part.getStart(source), postgres, part.text);
        }
      }
    }
  };
  const visit = (node: ts.Node, inheritedOwner = false, inheritedPostgres = false) => {
    let owner = inheritedOwner;
    let postgres = inheritedPostgres;
    if (ts.isFunctionLikeDeclaration(node)) {
      postgres = false;
      owner =
        file === "src/infra/kysely-sync.ts" &&
        ts.isFunctionDeclaration(node) &&
        /^(?:sqliteStringSet|sqliteStringSetEntries)$/u.test(node.name?.text ?? "");
    }
    if (ts.isConditionalExpression(node) && isPostgresGuard(node.condition)) {
      visit(node.condition, owner, postgres);
      visit(node.whenTrue, owner, true);
      visit(node.whenFalse, owner, postgres);
      return;
    }
    if (ts.isIfStatement(node) && isPostgresGuard(node.expression)) {
      visit(node.expression, owner, postgres);
      visit(node.thenStatement, owner, true);
      if (node.elseStatement) {
        visit(node.elseStatement, owner, postgres);
      }
      return;
    }
    if (ts.isTaggedTemplateExpression(node)) {
      const tag = node.tag;
      const name = ts.isIdentifier(tag)
        ? tag.text
        : ts.isPropertyAccessExpression(tag)
          ? tag.name.text
          : "";
      if (/sql$/iu.test(name)) {
        template(node.template, owner, postgres, true);
      }
      visit(tag, owner, postgres);
      return;
    }
    if (ts.isStringLiteral(node) && SQL_STATEMENT.test(node.text)) {
      literal(node, owner, postgres);
    } else if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      template(node, owner, postgres);
      return; // Substitutions are outside the lexical contract, regardless of tag.
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      CONFLICT_METHOD.test(node.expression.name.text)
    ) {
      add(
        { construct: "insert-conflict", group: "mechanical", index: 0, owner: false },
        node.expression.name.getStart(source),
      );
    }
    node.forEachChild((child) => visit(child, owner, postgres));
  };
  visit(source);
  return sites;
}

export function inventory(
  root = process.cwd(),
  ref = "",
  staged = false,
  options: { files?: readonly string[]; cache?: DialectInventoryCache } = {},
): DialectInventoryRow[] {
  const selected = options.files?.filter(productionFile);
  if (selected?.length === 0) {
    return [];
  }
  const snapshot = ref !== "" || staged;
  const paths = selected ?? roots;
  const files = [
    ...new Set(
      snapshot
        ? gitPaths(
            root,
            ref
              ? ["ls-tree", "-r", "--name-only", "-z", ref, "--", ...paths]
              : ["ls-files", "--cached", "-z", "--", ...paths],
          )
        : (
            selected ??
            gitPaths(root, [
              "ls-files",
              "--cached",
              "--others",
              "--exclude-standard",
              "-z",
              "--",
              ...roots,
            ])
          ).filter((file) => fs.existsSync(path.join(root, file))),
    ),
  ].toSorted();
  const texts = snapshot
    ? loadRatchetSources(root, files, ref)
    : new Map(files.map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]));
  const cache = options.cache ?? new Map<string, { text: string; matches: DialectSite[] }>();
  const changed = files.filter((file) => cache.get(file)?.text !== texts.get(file));
  using parser = createNativeTypeScriptParser({ cwd: root });
  const typescript = changed.filter((file) => !file.endsWith(".sql"));
  const sources = parser.parseSourceFiles(
    typescript.map((fileName) => ({ fileName, text: texts.get(fileName)! })),
  );
  for (const [index, file] of typescript.entries()) {
    const source = sources[index];
    if (!source) {
      throw new Error(`Native TypeScript parser returned no source for ${file}`);
    }
    cache.set(file, { text: texts.get(file)!, matches: findSites(file, source) });
  }
  for (const file of changed.filter((name) => name.endsWith(".sql"))) {
    const text = texts.get(file)!;
    const matches = matchDialect(
      text,
      false,
      true,
      SQLITE_PHYSICAL_LAYOUT_OWNERS.includes(file),
    ).map((match) => {
      const prefix = text.slice(0, match.index);
      return Object.assign(match, {
        line: prefix.split("\n").length,
        column: match.index - prefix.lastIndexOf("\n"),
      });
    });
    cache.set(file, { text, matches });
  }
  return files
    .map((file) => ({ file, matches: cache.get(file)!.matches }))
    .filter((row) => row.matches.length > 0);
}
