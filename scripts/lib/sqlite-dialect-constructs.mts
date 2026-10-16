export const DIALECT_GROUPS = ["mechanical", "design", "engine-maintenance"] as const;
export type DialectGroup = (typeof DIALECT_GROUPS)[number];
export const SQLITE_PRIMITIVE_OWNERS: readonly string[] = [
  // Canonical owner of SQLite FK/sequence primitives that ports and migrations call instead of raw sites.
  "src/infra/sqlite-strict.ts",
  // Canonical owner of SQLite user_version read/write.
  "src/infra/sqlite-user-version.ts",
  // SQLite archive-format owner: catalog capture and offline restoration of migration table scopes.
  "src/infra/sqlite-migration-scoped-snapshot.ts",
  // SQLite admission catalogs own native schema/PRAGMA facts; PostgreSQL has its own catalog owner.
  "src/infra/sqlite-schema-catalog.ts",
  // SQLite planner-statistics owner: bounded optimization under existing writer admission.
  "src/infra/sqlite-planner-statistics.ts",
  // SQLite-only daemon store owner: empty-store admission and durable schema creation on every engine.
  "src/daemon/runtime-pin-store.ts",
];
export type DialectMatch = {
  construct: string;
  group: DialectGroup;
  index: number;
  owner: boolean;
};

type Construct = readonly [name: string, group: DialectGroup, pattern: RegExp];

// Frozen lexical vocabulary, not a SQL parser. Overlapping constructs count separately.
const constructs: readonly Construct[] = [
  [
    "insert-conflict",
    "mechanical",
    /\b(?:insert\s+or\s+(?:replace|ignore|abort|fail|rollback)|replace\s+into)\b/giu,
  ],
  ["json-string-set", "mechanical", /\bjson_(?:each|tree)\s*\(/giu],
  ["transaction-mode", "mechanical", /\bbegin\s+(?:immediate|deferred|exclusive)\b/giu],
  ["last-insert-rowid", "mechanical", /\blast_insert_rowid\s*\(/giu],
  ["without-rowid", "mechanical", /\bwithout\s+rowid\b/giu],
  ["randomblob", "mechanical", /\brandomblob\s*\(/giu],
  ["fts5", "design", /\b(?:using\s+fts5\b|match\b|(?:bm25|snippet|highlight)\s*\()/giu],
  ["sqlite-vec", "design", /\b(?:using\s+vec0\b|vec_distance_\w+\s*\()/giu],
  [
    "json-projection",
    "design",
    // PostgreSQL-only JSONB constructors and aggregates are not SQLite projection debt.
    /\b(?:json_(?:extract|set|insert|replace|remove|patch|object|array|group_\w+|type|valid)|jsonb_(?!(?:build_object|build_array|agg|object_agg)\b)\w+)\s*\(|->>?/giu,
  ],
  ["temp-schema", "design", /\b(?:create\s+(?:temp|temporary)\b|temp\s*\.)/giu],
  ["rowid", "design", /\b(?:rowid|_rowid_)\b/giu],
  ["custom-function", "design", /\bopenclaw_\w+\s*\(/giu],
  ["glob", "design", /\bglob\b/giu],
  ["indexed-by", "design", /\bindexed\s+by\b/giu],
  ["attach", "design", /\battach\b/giu],
  ["collate-nocase", "design", /\bcollate\s+nocase\b/giu],
  ["typeof", "design", /\btypeof\s*\(/giu],
  ["printf", "design", /\bprintf\s*\(/giu],
  ["pragma", "engine-maintenance", /\b(?:pragma\b|pragma_\w+\s*\()/giu],
  [
    "data-version",
    "engine-maintenance",
    /\b(?:pragma\s+data_version\b|pragma_data_version\s*\()/giu,
  ],
  [
    "user-version",
    "engine-maintenance",
    /\b(?:pragma\s+user_version\b|pragma_user_version\s*\()/giu,
  ],
  [
    "schema-version",
    "engine-maintenance",
    /\b(?:pragma\s+schema_version\b|pragma_schema_version\s*\()/giu,
  ],
  ["wal-checkpoint", "engine-maintenance", /\b(?:wal_checkpoint\b|pragma_wal_checkpoint\s*\()/giu],
  [
    "integrity-check",
    "engine-maintenance",
    /\b(?:(?:integrity_check|quick_check)\b|pragma_(?:integrity_check|quick_check)\s*\()/giu,
  ],
  ["vacuum", "engine-maintenance", /\bvacuum\b/giu],
  ["sqlite-catalog", "engine-maintenance", /\bsqlite_(?:schema|master|sequence|temp_master)\b/giu],
];

export const CONFLICT_METHOD = /^(?:orReplace|orIgnore|orAbort|orFail|orRollback)$/iu;

export function matchDialect(text: string, owner = false, sqlFile = false): DialectMatch[] {
  // Preserve offsets; single-quoted text remains eligible, including prose.
  const masked = text.replace(
    /"(?:""|[^"])*(?:"|$)|'(?:''|[^'])*(?:'|$)|--[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)/gu,
    (part) =>
      part.startsWith('"') || (sqlFile && /^(?:--|\/\*)/u.test(part))
        ? part.replace(/[^\r\n]/gu, " ")
        : part,
  );
  return constructs
    .flatMap(([construct, group, pattern]) =>
      [...masked.matchAll(pattern)]
        .filter(
          (match) =>
            construct !== "custom-function" ||
            !/\b(?:table|exists|into|references|on)\s+$/iu.test(masked.slice(0, match.index)),
        )
        .map((match) => ({
          construct,
          group,
          index: match.index,
          owner: owner && construct === "json-string-set",
        })),
    )
    .toSorted(
      (left, right) =>
        left.index - right.index || left.construct.localeCompare(right.construct, "en"),
    );
}
