export const DIALECT_GROUPS = ["mechanical", "design", "engine-maintenance"] as const;
export type DialectGroup = (typeof DIALECT_GROUPS)[number];
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
  ["transaction-mode", "mechanical", /\b(?:begin\s+(?:immediate|deferred)|savepoint)\b/giu],
  ["last-insert-rowid", "mechanical", /\blast_insert_rowid\s*\(/giu],
  ["without-rowid", "mechanical", /\bwithout\s+rowid\b/giu],
  ["randomblob", "mechanical", /\brandomblob\s*\(/giu],
  ["fts5", "design", /\b(?:using\s+fts5\b|match\b|(?:bm25|snippet|highlight)\s*\()/giu],
  ["sqlite-vec", "design", /\b(?:using\s+vec0\b|vec_distance_\w+\s*\()/giu],
  [
    "json-projection",
    "design",
    /\b(?:json_(?:extract|set|insert|replace|remove|patch|object|array|group_\w+|type|valid)|jsonb_\w+)\s*\(|->>?/giu,
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
      [...masked.matchAll(pattern)].map((match) => ({
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
