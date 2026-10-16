import { sql, type RawBuilder } from "kysely";
import {
  admitStoreSearch,
  type EngineConnection,
  type FullTextCapability,
  type TextIndex,
  type TextQuery,
} from "openclaw/plugin-sdk/database-engine-worker-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  DatabaseSearchCapabilityUnavailableError,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  tableExists,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { buildMatchQueryFromTerms, planKeywordSearch } from "./keyword-query.js";
import { memoryTextSearchSchema, memoryVectorSearchSchema } from "./manager-search-schema.js";
import {
  projectMemorySearchRow,
  type MemorySearchRow,
  type SearchRowResult,
} from "./manager-search-shared.js";
import type { MemoryKeywordWorkerQuery, MemoryVectorWorkerQuery } from "./manager-search-types.js";
import type { ExactPathSpecificity } from "./manager-search.js";

type SearchDatabase = {
  memory_index_chunks: MemorySearchRow & { model: string; openclaw_search: unknown };
  memory_index_chunks_vec: { id: string; embedding: unknown };
  memory_index_sources: {
    id: number;
    path: string;
    source: MemorySource;
    openclaw_search: unknown;
  };
};
type VectorRow = MemorySearchRow & { dist: number };
type KeywordRow = MemorySearchRow & { rank: number };
type PathRow = KeywordRow & { specificity: ExactPathSpecificity };
type BodyResult = SearchRowResult & { textScore: number; hasBodyMatch: true };
type PathResult = SearchRowResult & {
  textScore: 0;
  pathScore: number;
  exactPathSpecificity: ExactPathSpecificity;
  hasBodyMatch: false;
};

function textIntent(
  query: string,
  tokenizer: "unicode61" | "trigram" | undefined,
  matchAny = false,
): TextQuery | undefined {
  const plan = planKeywordSearch({ query, ftsTokenizer: tokenizer, matchAny });
  const rank = buildMatchQueryFromTerms(plan.tokens, undefined, matchAny);
  if (!rank) {
    return undefined;
  }
  return tokenizer === "trigram"
    ? {
        kind: matchAny ? "any" : "all",
        clauses: plan.tokens.map((text) => ({ kind: "contains", text })),
      }
    : rank;
}

function textCapability(database: EngineConnection, tokenizer?: "unicode61" | "trigram") {
  const search = admitStoreSearch(database, memoryTextSearchSchema(tokenizer ?? "unicode61"));
  if (!search.fullText) {
    throw new DatabaseSearchCapabilityUnavailableError("fullText", search.diagnostics.join("; "));
  }
  return { fullText: search.fullText, indexes: search.text };
}

// PostgreSQL returns only the retained payloads; it never transfers corpus embeddings to JS.
export async function searchPostgresMemoryVector(
  database: EngineConnection,
  query: MemoryVectorWorkerQuery,
): Promise<SearchRowResult[]> {
  if (query.limit <= 0 || query.candidateIds?.length === 0 || query.queryVec.length === 0) {
    return [];
  }
  if (!tableExists(database, "memory_index_chunks_vec")) {
    throw new DatabaseSearchCapabilityUnavailableError(
      "vector",
      'PostgreSQL memory has no admitted vector index. Have a database administrator run CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public; then configure an embedding provider and run openclaw memory index. For keyword-only memory set memory.search.provider to "none".',
    );
  }
  const search = admitStoreSearch(database, memoryVectorSearchSchema(query.queryVec.length));
  if (!search.vector) {
    throw new DatabaseSearchCapabilityUnavailableError("vector", search.diagnostics.join("; "));
  }
  const k = getNodeSqliteKysely<SearchDatabase>(database);
  const models = [
    ...new Set([query.providerModel, ...(query.providerModelAliases ?? []).filter(Boolean)]),
  ];
  const scoped = () => {
    let selected = k
      .selectFrom("memory_index_chunks_vec as v")
      .innerJoin("memory_index_chunks as c", "c.id", "v.id")
      .where("c.model", "in", models);
    if (query.sourceFilter.params.length) {
      selected = selected.where("c.source", "in", query.sourceFilter.params);
    }
    if (query.candidateIds) {
      selected = selected.where("c.id", "in", query.candidateIds);
    }
    return selected;
  };
  const result = await search.vector.nearest<VectorRow>({
    index: search.vectors.chunks!,
    vector: query.queryVec,
    limit: query.limit,
    textPrefix: { column: "text", maxChars: query.snippetMaxChars },
    scopeCount: scoped().select(k.fn.countAll<number>().as("count")),
    isRow: (value): value is VectorRow =>
      typeof value === "object" &&
      value !== null &&
      "dist" in value &&
      typeof value.dist === "number",
    query: ({ match, distance }) =>
      scoped()
        .select([
          "c.id",
          "c.path",
          "c.start_line",
          "c.end_line",
          "c.source",
          sql<string>`left(c.text, ${query.snippetMaxChars})`.as("text"),
          distance.as("dist"),
        ])
        .where(match)
        .orderBy(distance)
        .orderBy("c.id")
        .limit(query.limit),
  });
  return result.rows.map((row) => projectMemorySearchRow(row, query.snippetMaxChars, 1 - row.dist));
}

function searchBody(
  database: EngineConnection,
  query: MemoryKeywordWorkerQuery["body"],
  matchAny = false,
): BodyResult[] {
  const intent = textIntent(query.query, query.ftsTokenizer, matchAny);
  if (query.limit <= 0 || !intent) {
    return [];
  }
  const { fullText, indexes } = textCapability(database, query.ftsTokenizer);
  const index = indexes.body!;
  const rank = textRank(fullText, index, intent, query.ftsTokenizer);
  let selected = getNodeSqliteKysely<SearchDatabase>(database)
    .selectFrom("memory_index_chunks")
    .select([
      "id",
      "path",
      "start_line",
      "end_line",
      "source",
      sql<string>`left(text, ${query.snippetMaxChars})`.as("text"),
      rank.as("rank"),
    ])
    .where(textMatch(fullText, index, intent));
  if (query.sourceFilter.params.length) {
    selected = selected.where("source", "in", query.sourceFilter.params);
  }
  const rows = executeSqliteQuerySync<KeywordRow>(
    database,
    selected.orderBy(rank, "desc").orderBy("id").limit(query.limit),
  ).rows;
  // Native ranking stays engine-local; the manager keeps its shared hybrid weights.
  return rows.map((row) =>
    Object.assign(projectMemorySearchRow(row, query.snippetMaxChars, row.rank), {
      textScore: row.rank,
      hasBodyMatch: true as const,
    }),
  );
}

function textMatch(
  fullText: FullTextCapability,
  index: TextIndex,
  query: TextQuery,
): RawBuilder<boolean> {
  // Compose contains predicates here; the engine's compound tsquery accepts lexical terms only.
  if (query.kind === "all" || query.kind === "any") {
    const clauses = query.clauses.map((clause) => textMatch(fullText, index, clause));
    return query.kind === "all"
      ? sql<boolean>`(${sql.join(clauses, sql` AND `)})`
      : sql<boolean>`(${sql.join(clauses, sql` OR `)})`;
  }
  return fullText.match(index, query);
}

function textRank(
  fullText: FullTextCapability,
  index: TextIndex,
  query: TextQuery,
  tokenizer?: "unicode61" | "trigram",
): RawBuilder<number> {
  if (tokenizer !== "trigram" || (query.kind !== "all" && query.kind !== "any")) {
    return fullText.rank(index, query).value;
  }
  // Give each query term equal weight while keeping substring relevance inside PostgreSQL.
  const ranks = query.clauses.map((clause) => textRank(fullText, index, clause, tokenizer));
  return sql<number>`(${sql.join(ranks, sql` + `)}) / ${ranks.length}`;
}

function pathSpecificity(query: string): RawBuilder<ExactPathSpecificity> {
  const normalized = query
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .normalize("NFC")
    .toLowerCase();
  if (!normalized || normalized === ".") {
    return sql<ExactPathSpecificity>`0`;
  }
  const path = sql<string>`lower(normalize(regexp_replace(replace(btrim(s.path), E'\\\\', '/'), '^\\./', ''), NFC))`;
  if (normalized.includes("/")) {
    return sql<ExactPathSpecificity>`CASE WHEN ${path} = ${normalized} THEN 3 ELSE 0 END`;
  }
  const basename = sql<string>`regexp_replace(${path}, '^.*/', '')`;
  const stem = sql<string>`regexp_replace(${basename}, '^(.+)\\.[^.]*$', '\\1')`;
  return sql<ExactPathSpecificity>`CASE WHEN ${path} = ${normalized} THEN 3 WHEN ${basename} = ${normalized} THEN 2 WHEN ${stem} = ${normalized} THEN 1 ELSE 0 END`;
}

function searchPaths(
  database: EngineConnection,
  query: MemoryKeywordWorkerQuery["path"],
): PathResult[] {
  const exactLimit = Math.max(0, Math.floor(query.exactPathLimit ?? query.limit));
  if (query.limit <= 0 && exactLimit <= 0) {
    return [];
  }
  const intent = textIntent(query.query, query.ftsTokenizer);
  const { fullText, indexes } = textCapability(database, query.ftsTokenizer);
  const index = { ...indexes.paths!, alias: "s" };
  const rank = intent ? textRank(fullText, index, intent, query.ftsTokenizer) : sql<number>`0`;
  const k = getNodeSqliteKysely<SearchDatabase>(database);
  const specificity = pathSpecificity(query.query);
  const load = (exact: boolean, limit: number): PathRow[] => {
    if (limit <= 0 || (!exact && !intent)) {
      return [];
    }
    let paths = k
      .selectFrom("memory_index_sources as s")
      .select(["s.path", "s.source", rank.as("rank"), specificity.as("specificity")])
      .where(specificity, exact ? ">" : "=", 0)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("memory_index_chunks as live")
            .select("live.id")
            .whereRef("live.path", "=", "s.path")
            .whereRef("live.source", "=", "s.source"),
        ),
      );
    if (!exact && intent) {
      paths = paths.where(textMatch(fullText, index, intent));
    }
    if (query.sourceFilter.params.length) {
      paths = paths.where("s.source", "in", query.sourceFilter.params);
    }
    const retained = paths
      .orderBy(exact ? specificity : rank, "desc")
      .orderBy("s.path")
      .orderBy("s.source")
      .limit(limit);
    const statement = k
      .with(
        (cte) => cte("retained").materialized(),
        () => retained,
      )
      .selectFrom("retained as p")
      .innerJoinLateral(
        (eb) =>
          eb
            .selectFrom("memory_index_chunks as first")
            .select([
              "first.id",
              "first.start_line",
              "first.end_line",
              sql<string>`left(first.text, ${query.snippetMaxChars})`.as("text"),
            ])
            .whereRef("first.path", "=", "p.path")
            .whereRef("first.source", "=", "p.source")
            .orderBy("first.start_line")
            .orderBy("first.end_line")
            .orderBy("first.id")
            .limit(1)
            .as("c"),
        (join) => join.onTrue(),
      )
      .select([
        "c.id",
        "p.path",
        "p.source",
        "c.start_line",
        "c.end_line",
        "c.text",
        "p.rank",
        "p.specificity",
      ])
      .orderBy(exact ? "p.specificity" : "p.rank", "desc")
      .orderBy("p.path")
      .orderBy("p.source");
    return executeSqliteQuerySync<PathRow>(database, statement).rows;
  };
  return [...load(true, exactLimit), ...load(false, query.limit)]
    .map((row): PathResult =>
      Object.assign(projectMemorySearchRow(row, query.snippetMaxChars, row.rank), {
        textScore: 0 as const,
        pathScore: row.rank,
        exactPathSpecificity: row.specificity,
        hasBodyMatch: false as const,
      }),
    )
    .slice(0, query.exactPathLimit === undefined ? query.limit : exactLimit + query.limit);
}

export async function searchPostgresMemoryKeyword(
  database: EngineConnection,
  query: MemoryKeywordWorkerQuery,
) {
  const run = <T>(operation: () => T[]): { rows: T[]; error?: string } => {
    try {
      return { rows: operation() };
    } catch (error) {
      return { rows: [], error: formatErrorMessage(error) };
    }
  };
  let body = run(() => searchBody(database, query.body));
  const path = run(() => searchPaths(database, query.path));
  if (!body.rows.length && !path.rows.length && !body.error && !path.error) {
    body = run(() => searchBody(database, query.body, true));
  }
  return { body, path };
}
