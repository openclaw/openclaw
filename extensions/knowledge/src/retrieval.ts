import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
  tableExists,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { Check } from "typebox/value";
import { observeLifecycleGuards } from "./lifecycle.js";
import { SEARCH_HIGHLIGHT_MAX_BYTES } from "./limits.js";
import { effectiveRecord, mergeRedirects, referenceIds } from "./merge.js";
import type { LoadedRecord } from "./model.js";
import { expandTypes } from "./ontology.js";
import { queryFreshness } from "./query-freshness.js";
import {
  SearchInput,
  LookupInput,
  type SearchOutput,
  type LookupOutput,
} from "./retrieval-contract.js";
import { digest } from "./scan-primitives.js";
import type { ScanResult } from "./scan-result.js";
import type { StorageTables } from "./storage-tables.js";
import { temporalPredicate } from "./temporal-query.js";
import { activeNow } from "./temporal.js";

type Snapshot = ScanResult;
type Hit = SearchOutput["hits"][number];
const normalize = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();

/** Operational safeguards, NOT a rebuildable projection. Observing withdrawal is irreversible here. */
export function observeWithdrawals(db: DatabaseSync, records: LoadedRecord[], binding: string) {
  observeLifecycleGuards(db, records, binding);
  const insert = prepareSqliteQuerySync<{ id: string }>(db, (param) =>
    getNodeSqliteKysely<StorageTables>(db)
      .insertInto("keyword_withdrawals_v1")
      .values({ binding, id: param((r) => r.id) })
      .onConflict((oc) => oc.doNothing()),
  );
  // A duplicate/invalid record cannot safely clear an existing withdrawal either.
  for (const r of records) {
    if (r.lifecycle === "withdrawn") {
      insert(r);
    }
  }
}
export function withdrawnIds(db: DatabaseSync, binding: string): Set<string> {
  return new Set(
    db
      .prepare("SELECT id FROM keyword_withdrawals_v1 WHERE binding=?")
      .all(binding)
      .map((r) => String(r.id)),
  );
}

/** Remove unavailable dependencies transitively; do not leak a hidden endpoint through its edge/prose.
 * A reference to a merged page counts as a reference to its survivor, and returned records carry
 * those references already resolved (see effectiveRecord). */
export function eligible(data: Snapshot, withdrawn = new Set<string>(), historical = true) {
  const counts = new Map<string, number>();
  for (const r of data.records) {
    counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
  }
  const allowed = new Map(
    data.records
      .filter(
        (r) =>
          r.metadata.record_class !== "fixture" &&
          r.valid &&
          counts.get(r.id) === 1 &&
          r.lifecycle !== "withdrawn" &&
          !withdrawn.has(r.id) &&
          (historical || activeNow(r.metadata)),
      )
      .map((r) => [r.id, r]),
  );
  // A withdrawal tombstone on a merged page stops its redirect too.
  const redirects = mergeRedirects(data.records),
    target = (id: string) => (withdrawn.has(id) ? id : (redirects.get(id) ?? id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, r] of allowed) {
      if (referenceIds(r.metadata).some((ref) => !allowed.has(target(ref)))) {
        allowed.delete(id);
        changed = true;
      }
    }
  }
  const live = new Map([...redirects].filter(([from]) => !withdrawn.has(from)));
  return [...allowed.values()].map((r) => effectiveRecord(r, live));
}
function filtered(data: Snapshot, records: LoadedRecord[], input: LookupInput | SearchInput) {
  const types = input.type ? expandTypes(data.ontology, input.type) : null;
  // SAFETY: temporalPredicate reads only optional TimeFilter fields; a lookup without them matches all.
  const timeMatches = temporalPredicate(input as SearchInput);
  return records.filter(
    (r) =>
      timeMatches(r) &&
      (!input.kind || r.kind === input.kind) &&
      (!types || (r.kind === "page" ? types.has(r.type) : r.type === input.type)) &&
      (!input.tag || r.metadata.tags?.includes(input.tag)) &&
      (input.lifecycle === "all" || r.lifecycle === (input.lifecycle ?? "active")),
  );
}
const coverage = (data: Snapshot) => ({
  complete: data.issues.length === 0,
  message: data.issues.length
    ? "Some authorized source material has validation issues. Invalid, ambiguous, withdrawn and dependent records are excluded; inspect Activity & issues. Results do not establish a complete vault inventory."
    : "Current eligible scoped records only. Ranked search is not exhaustive vault listing.",
});
const fieldText = (r: LoadedRecord, field: Hit["snippet"]["field"]) =>
  field === "body" ? r.body : field === "title" ? r.title : (r.metadata.aliases ?? []).join("\n");
function hit(
  r: LoadedRecord,
  field: Hit["snippet"]["field"],
  at: number,
  matches: string[],
  score: number | null,
): Hit {
  const value = fieldText(r, field);
  let start = Math.max(0, at - 100),
    end = Math.min(value.length, start + 480);
  // Do not split UTF-16 surrogate pairs at the snippet boundaries.
  if (start && /[\uDC00-\uDFFF]/.test(value[start] ?? "")) {
    start--;
  }
  if (end < value.length && /[\uDC00-\uDFFF]/.test(value[end] ?? "")) {
    end--;
  }
  if (end - start > 480) {
    end--;
  }
  const bodyStart = r.raw.length - r.body.length;
  const line = (offset: number) => r.raw.slice(0, bodyStart + offset).split("\n").length;
  const { metadata, body: _body, raw: _raw, hash, ...record } = r;
  return {
    record,
    citation: { id: r.id, path: r.path, revision: r.revision, hash },
    snippet: {
      field,
      text: value.slice(start, end),
      start,
      end,
      startLine: field === "body" ? line(start) : null,
      endLine: field === "body" ? line(Math.max(start, end - 1)) : null,
      truncated: start > 0 || end < value.length,
    },
    matches,
    score,
    attribution: metadata.attribution ?? "",
    assertionOrigin: metadata.assertion_origin ?? "",
    evidence: (metadata.evidence ?? [])
      .slice(0, 3)
      .map(({ path, sha256, start_line, end_line }) =>
        Object.assign(
          { path, sha256 },
          start_line !== undefined ? { start_line } : {},
          end_line !== undefined ? { end_line } : {},
        ),
      ),
    evidenceTruncated: (metadata.evidence?.length ?? 0) > 3,
  };
}
export function exactLookup(
  data: Snapshot,
  input: LookupInput,
  withdrawn = new Set<string>(),
): LookupOutput {
  if (!Check(LookupInput, input) || !input.query.trim()) {
    throw new Error("Lookup requires a nonempty exact ID, name or alias and valid filters.");
  }
  const query = normalize(input.query),
    historical = input.lifecycle !== undefined && input.lifecycle !== "active";
  // A current lookup of a merged page's ID resolves to the page it was merged into.
  const redirects = mergeRedirects(data.records),
    asked = input.query.trim();
  const redirectedFrom =
    !historical && redirects.has(asked) && !withdrawn.has(asked) ? asked : undefined;
  const exactId = redirectedFrom ? redirects.get(asked)! : asked;
  const matches = filtered(data, eligible(data, withdrawn, historical), input)
    .flatMap((r) => {
      const fields = [
        ...(r.id === exactId ? ["id"] : []),
        ...(normalize(r.title) === query ? ["title"] : []),
        ...((r.metadata.aliases ?? []).some((alias) => normalize(alias) === query)
          ? ["aliases"]
          : []),
      ];
      const field = fields.includes("title")
        ? "title"
        : fields.includes("aliases")
          ? "aliases"
          : "body";
      const at =
        field === "aliases"
          ? (r.metadata.aliases ?? [])
              .join("\n")
              .indexOf((r.metadata.aliases ?? []).find((alias) => normalize(alias) === query)!)
          : 0;
      return fields.length ? [hit(r, field, at, fields, null)] : [];
    })
    .toSorted((a, b) => a.record.id.localeCompare(b.record.id));
  const offset = input.offset ?? 0,
    limit = input.limit ?? 20;
  const hits = matches.slice(offset, offset + limit);
  const result: LookupOutput = {
    hits,
    resultCount: hits.length,
    total: matches.length,
    outcome: matches.length === 0 ? "missing" : matches.length === 1 ? "found" : "ambiguous",
    offset,
    nextOffset: offset + limit < matches.length ? offset + limit : null,
    freshness: queryFreshness(data.checkedAt),
    coverage: coverage(data),
    ...(redirectedFrom ? { redirectedFrom } : {}),
  };
  // Several current pages of one type answering to one name are a merge candidate, not a choice to make.
  const pages = matches.filter((h) => h.record.kind === "page");
  if (
    result.outcome === "ambiguous" &&
    pages.length === matches.length &&
    new Set(pages.map((h) => h.record.type)).size === 1
  ) {
    result.coverage = {
      ...result.coverage,
      message:
        `${result.coverage.message} These ${pages.length} pages share this name; if they are one entity, merge them with knowledge_merge instead of choosing one.`.slice(
          0,
          500,
        ),
    };
  }
  return result;
}

/** Han, Hiragana or Katakana letters and numbers, including the prolonged-sound
 * and iteration marks those scripts share, each with its combining marks.
 * Hangul is space-delimited and stays as is. */
const CJK_RUN = String.raw`(?:(?=[\p{L}\p{N}])[\p{scx=Han}\p{scx=Hira}\p{scx=Kana}]\p{M}*)+`;
const cjkRuns = new RegExp(CJK_RUN, "gu"),
  cjkSplit = new RegExp(`(${CJK_RUN})`, "u"),
  hasCjk = new RegExp(CJK_RUN, "u");
/** A run's characters, each with its combining marks. unicode61 separates tokens
 * at a kana voicing mark, so a decomposed (NFD) が would index as か: each
 * character is composed first and any mark left over (e.g. an ideographic
 * variation selector) is dropped, as diacritics are elsewhere. A run without
 * marks that is already NFC, the usual case, has nothing to fold; CJK
 * compatibility ideographs (e.g. U+F900) carry no mark yet still compose. */
function cjkChars(run: string) {
  if (!/\p{M}/u.test(run) && run.normalize("NFC") === run) {
    const chars = Array.from(run);
    return { chars, folded: chars };
  }
  const chars = run.match(/\P{M}\p{M}*/gu) ?? [];
  return { chars, folded: chars.map((char) => char.normalize("NFC").replace(/\p{M}/gu, "")) };
}

/** unicode61 indexes an unbroken CJK run as one token, so a word inside a
 * sentence never matched. Indexed text instead spells each CJK character joined
 * with the next one in its run, the run's last character alone (新加坡NAS →
 * 新加 加坡 坡 NAS), so any CJK substring is a phrase of adjacent tokens.
 * Other text is copied verbatim; text without CJK is returned as is. When
 * `pieces` is given, each entry [indexed offset, original offset] added starts
 * one token or copy, so a match start maps back exactly.
 * A query term (`open`) may continue in the document after its last character:
 * its final run drops that closing token, and a lone final character becomes a
 * prefix of the token it starts. */
function cjkText(value: string, open = false, pieces?: [number, number][]) {
  if (!hasCjk.test(value)) {
    return { text: value, prefix: false };
  }
  let text = "",
    from = 0,
    prefix = false;
  for (const run of value.matchAll(cjkRuns)) {
    pieces?.push([text.length, from]);
    text += value.slice(from, run.index);
    const { chars, folded } = cjkChars(run[0]),
      final = open && run.index + run[0].length === value.length;
    prefix = final && chars.length === 1;
    let at = run.index;
    for (let index = 0; index < chars.length; index++) {
      const next = folded[index + 1] ?? "";
      if (final && !next && !prefix) {
        break;
      }
      text += " ";
      pieces?.push([text.length, at]);
      text += folded[index] + next;
      at += chars[index]!.length;
    }
    text += " ";
    from = run.index + run[0].length;
  }
  pieces?.push([text.length, from]);
  return { text: text + value.slice(from), prefix };
}
/** The original offset of a highlight position in `value`'s indexed text. */
function originalOffset(value: string, at: number) {
  const pieces: [number, number][] = [[0, 0]];
  cjkText(value, false, pieces);
  const [indexed, original] = pieces.findLast(([start]) => start <= at)!;
  return original + at - indexed;
}

/** Deliberately literal modes, never raw FTS syntax/SQL/regex. Punctuation is token separation. */
export function keywordExpression(input: SearchInput): string {
  if (!Check(SearchInput, input)) {
    throw new Error("Invalid keyword search input.");
  }
  const tokens = input.query.match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
  if (!tokens.length || tokens.length > 64) {
    throw new Error("Keyword search requires 1–64 word tokens. Use exact lookup for a name or ID.");
  }
  // Adjacent tokens: a CJK word matches as an exact substring (see cjkText).
  const phrase = (words: string) => {
    const { text, prefix } = cjkText(words, true);
    return `"${text}"${prefix ? "*" : ""}`;
  };
  // In any mode each bigram of a CJK run, or its lone character, may match alone.
  const anyTerms = (word: string) =>
    word.split(cjkSplit).flatMap((part, index) => {
      if (index % 2 === 0) {
        return part ? [`"${part}"`] : [];
      }
      const chars = cjkChars(part).folded;
      return chars.length === 1
        ? [`"${chars[0]}"*`]
        : chars.slice(1).map((char, position) => `"${chars[position]}${char}"`);
    });
  // FTS5's unicode61 tokenizer does no canonical normalization, so composed (NFC)
  // and decomposed (NFD) spellings of a word index as distinct terms. Non-CJK text is
  // indexed verbatim (only CJK runs are folded, see cjkChars), so in all/any modes each
  // word matches its original spelling plus both canonical spellings — a partially
  // normalized token (e.g. Hangul 가나,
  // U+AC00 U+1102 U+1161) is neither fully NFC nor fully NFD, and only its literal
  // form is indexed. Spellings that coincide (ASCII, CJK, unaccented) collapse to
  // one literal: an unaccented query still cannot reach a composed accented note,
  // so no accent folding is added. Phrase mode keeps whole-phrase alternatives (each
  // spells the whole phrase one way), since matching a mixed-spelling phrase would
  // need the cross product of per-word spellings; a uniformly spelled phrase query
  // can miss a record that mixes NFC and NFD across its words — a rare accepted gap.
  const spellingsOf = (t: string) => [...new Set([t, t.normalize("NFC"), t.normalize("NFD")])];
  if (input.mode === "phrase") {
    const alternatives = [
      ...new Set(
        [tokens, tokens.map((t) => t.normalize("NFC")), tokens.map((t) => t.normalize("NFD"))].map(
          (words) => phrase(words.join(" ")),
        ),
      ),
    ];
    return alternatives.length === 1 ? alternatives[0]! : `(${alternatives.join(") OR (")})`;
  }
  return tokens
    .map((t) => {
      const terms = [
        ...new Set(spellingsOf(t).flatMap((f) => (input.mode === "any" ? anyTerms(f) : phrase(f)))),
      ];
      return terms.length === 1 ? terms[0]! : `(${terms.join(" OR ")})`;
    })
    .join(input.mode === "any" ? " OR " : " AND ");
}

// body_bytes is the stored body's UTF-8 size: the highlight bound (see keywordSearch)
// counts authored text, not the longer CJK index text.
const FTS_COLUMNS =
  "id UNINDEXED, title, aliases, body, body_bytes UNINDEXED, tokenize='unicode61 remove_diacritics 2'";
const FTS_INSERT = "(id,title,aliases,body,body_bytes) VALUES (?,?,?,?,?)";
const indexedRow = (r: LoadedRecord) =>
  [
    r.id,
    ...(["title", "aliases", "body"] as const).map((f) => cjkText(fieldText(r, f)).text),
    Buffer.byteLength(r.body),
  ] as const;

/** The scope's keyword corpora: eligible current records, and the eligible
 * superseded records whose `superseded_by` chain reaches one of them, each mapped to
 * that current record. Chains step only through eligible superseded records; one
 * that ends in a missing, withdrawn, ineligible or expired record has no target, so
 * its wording can never surface a result or shape ranking. */
function keywordCorpora(data: Snapshot, withdrawn: Set<string>) {
  const active = eligible(data, withdrawn, false),
    historical = eligible(data, withdrawn, true);
  const byId = new Map(historical.map((r) => [r.id, r])),
    now = new Map(active.map((r) => [r.id, r])),
    targets = new Map<string, LoadedRecord>();
  for (const r of historical) {
    // Chains are short; the visited set only stops a cycle.
    const visited = new Set<string>();
    let next = r.lifecycle === "superseded" ? r.metadata.superseded_by : undefined;
    while (next !== undefined && !visited.has(next)) {
      visited.add(next);
      const target = now.get(next);
      if (target) {
        targets.set(r.id, target);
        break;
      }
      const step = byId.get(next);
      next = step?.lifecycle === "superseded" ? step.metadata.superseded_by : undefined;
    }
  }
  return { active, historical, targets, history: historical.filter((r) => targets.has(r.id)) };
}

/** Bring one tracked FTS table to exactly `records`. Rows are tracked by record ID
 * and content hash, so a change re-indexes only the records that changed. */
function syncFts(db: DatabaseSync, table: string, rows: string, records: LoadedRecord[]) {
  const wanted = new Map(records.map((r) => [r.id, r]));
  const remove = db.prepare(`DELETE FROM ${table} WHERE rowid=?`),
    untrack = db.prepare(`DELETE FROM ${rows} WHERE id=?`);
  for (const row of db.prepare(`SELECT id,hash,fts_rowid FROM ${rows}`).all()) {
    const r = wanted.get(String(row.id));
    if (r && r.hash === row.hash) {
      wanted.delete(r.id);
      continue;
    }
    remove.run(row.fts_rowid!);
    untrack.run(row.id!);
  }
  const insert = db.prepare(`INSERT INTO ${table}${FTS_INSERT}`),
    track = db.prepare(`INSERT INTO ${rows} VALUES (?,?,?)`);
  for (const r of wanted.values()) {
    track.run(r.id, r.hash, insert.run(...indexedRow(r)).lastInsertRowid);
  }
}

/** Bring the scope's FTS tables to exactly the eligible `records` and the
 * `history` corpus (see keywordCorpora). One snapshot covers both tables, so an
 * edit to a superseded record changes the token that pagination compares even when
 * the current-record corpus is unchanged. */
function reconcileKeywordIndex(
  db: DatabaseSync,
  data: Snapshot,
  records: LoadedRecord[],
  history: LoadedRecord[],
  binding: string,
  generation: string,
) {
  const suffix = digest(binding);
  // v2 indexes CJK bigrams (see cjkText); a v1 table never matches v2 queries.
  const tables = [
    { table: `keyword_fts_v2_${suffix}`, rows: `keyword_rows_v2_${suffix}`, records },
    {
      table: `keyword_history_fts_v2_${suffix}`,
      rows: `keyword_history_rows_v2_${suffix}`,
      records: history,
    },
  ] as const;
  const snapshot = digest(
    JSON.stringify([
      generation,
      data.ontology?.fingerprint,
      records.map((r) => [r.id, r.path, r.hash, r.revision]),
      history.map((r) => [r.id, r.path, r.hash, r.revision]),
    ]),
  );
  const untracked = tables.filter(
    ({ table, rows }) => !tableExists(db, rows) || !tableExists(db, table),
  );
  const state = db.prepare("SELECT * FROM keyword_state_v1 WHERE binding=?").get(binding);
  let indexedAt = String(state?.indexed_at ?? "");
  if (untracked.length || state?.snapshot !== snapshot) {
    // The storage worker owns this index. Acquire the writer before reading rows
    // to update, rather than upgrading a read snapshot after an unrelated commit.
    indexedAt = runSqliteImmediateTransactionSync(
      db,
      () => {
        // A scope upgrading to v2 has no v2 tables yet; its v1 projection is never read again.
        if (untracked.length) {
          for (const retired of [
            "keyword_fts",
            "keyword_rows",
            "keyword_history_fts",
            "keyword_history_rows",
          ]) {
            db.exec(`DROP TABLE IF EXISTS ${retired}_v1_${suffix}`);
          }
        }
        for (const entry of tables) {
          const { table, rows, records: wanted } = entry;
          db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING fts5(${FTS_COLUMNS})`);
          db.exec(
            `CREATE TABLE IF NOT EXISTS ${rows} (id TEXT PRIMARY KEY, hash TEXT NOT NULL, fts_rowid INTEGER NOT NULL) STRICT`,
          );
          // Missing tracking or FTS means unknown contents; rebuild the pair.
          if (untracked.includes(entry)) {
            db.exec(`DELETE FROM ${table}`);
            db.exec(`DELETE FROM ${rows}`);
          }
          syncFts(db, table, rows, wanted);
        }
        const updatedAt = new Date().toISOString();
        const updated = { snapshot, indexed_at: updatedAt };
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<StorageTables>(db)
            .insertInto("keyword_state_v1")
            .values({ binding, ...updated })
            .onConflict((oc) => oc.column("binding").doUpdateSet(updated)),
        );
        return updatedAt;
      },
      { operationLabel: "knowledge.keyword.reconcile" },
    );
  }
  return { table: tables[0].table, historyTable: tables[1].table, snapshot, indexedAt };
}

/** Current records reached through superseded wording that matches `expression`,
 * in `corpus`'s BM25 order (then ID). Each target appears once, after every ID in
 * `direct`, credited to its best-ranked earlier record. */
function followReplacements(
  db: DatabaseSync,
  corpus: string,
  expression: string,
  history: Map<string, LoadedRecord>,
  targets: Map<string, LoadedRecord>,
  direct: () => Set<string>,
) {
  const matched = db
    .prepare(`SELECT id FROM ${corpus} WHERE ${corpus} MATCH ? ORDER BY bm25(${corpus},0,8,6,1),id`)
    .all(expression)
    .map((row) => String(row.id));
  if (!matched.length) {
    return [];
  }
  const seen = direct(),
    out: { record: LoadedRecord; via: LoadedRecord }[] = [];
  for (const id of matched) {
    const record = targets.get(id)!;
    if (!seen.has(record.id)) {
      seen.add(record.id);
      out.push({ record, via: history.get(id)! });
    }
  }
  return out;
}

/** Verification reconciles the same index without running a synthetic ranked search. */
export function verifyKeywordIndex(
  db: DatabaseSync,
  data: Snapshot,
  binding: string,
  generation: string,
  withdrawn = new Set<string>(),
): Set<string> | null {
  try {
    const { active, history } = keywordCorpora(data, withdrawn);
    const { table } = reconcileKeywordIndex(db, data, active, history, binding, generation);
    return new Set(
      db
        .prepare(`SELECT id FROM ${table}`)
        .all()
        .map((r) => String(r.id)),
    );
  } catch {
    return null;
  }
}

/** A query-local FTS corpus holding just `records`, so BM25 statistics come only from them. */
function temporaryCorpus(db: DatabaseSync, name: string, records: LoadedRecord[]) {
  db.exec(`DROP TABLE IF EXISTS temp.${name}`);
  db.exec(`CREATE VIRTUAL TABLE temp.${name} USING fts5(${FTS_COLUMNS})`);
  const insert = db.prepare(`INSERT INTO temp.${name}${FTS_INSERT}`);
  for (const r of records) {
    insert.run(...indexedRow(r));
  }
}

/** Called only inside the storage authority/identity fence, using the latest validated snapshot. */
export function keywordSearch(
  db: DatabaseSync,
  data: Snapshot,
  input: SearchInput,
  binding: string,
  generation: string,
  withdrawn = new Set<string>(),
): SearchOutput {
  const expression = keywordExpression(input),
    offset = input.offset ?? 0,
    limit = input.limit ?? 20;
  const base = {
    mode: "keyword" as const,
    queryMode: input.mode ?? "all",
    offset,
    freshness: queryFreshness(data.checkedAt),
    coverage: coverage(data),
  };
  const current = (input.lifecycle ?? "active") === "active",
    { active, historical, targets, history } = keywordCorpora(data, withdrawn),
    records = current ? active : historical,
    selected = filtered(data, records, input);
  // Like the direct corpus, superseded wording ranks only among histories whose
  // current record passes this query's filters.
  const selectedIds = new Set(selected.map((r) => r.id)),
    ranked = current ? history.filter((r) => selectedIds.has(targets.get(r.id)!.id)) : [];
  try {
    // Finish persistent-index writes before building query-local corpora.
    const { table, historyTable, snapshot, indexedAt } = reconcileKeywordIndex(
      db,
      data,
      records,
      history,
      binding,
      generation,
    );
    return runSqliteDeferredTransactionSync(
      db,
      (): SearchOutput => {
        // BM25 statistics must come only from the searched corpus. The scope table
        // holds exactly the eligible records, so an unfiltered search queries it
        // directly; a filtered search ranks within just its validated subset.
        const corpus = selected.length === records.length ? table : "keyword_query_v1",
          historyCorpus =
            !current || ranked.length === history.length
              ? historyTable
              : "keyword_history_query_v1";
        if (corpus !== table) {
          temporaryCorpus(db, corpus, selected);
        }
        if (historyCorpus !== historyTable) {
          temporaryCorpus(db, historyCorpus, ranked);
        }
        // Unpredictable delimiters checked against the corpus prevent authored marker injection.
        let marker: string;
        do {
          marker = randomUUID();
        } while (
          selected.some((r) =>
            [r.title, r.body, ...(r.metadata.aliases ?? [])].some((v) => v.includes(marker)),
          )
        );
        const total = Number(
          db.prepare(`SELECT count(*) AS n FROM ${corpus} WHERE ${corpus} MATCH ?`).get(expression)!
            .n,
        );
        const rows = db
          .prepare(`SELECT id,bm25(${corpus},0,8,6,1) AS score,
      CASE WHEN body_bytes<=${SEARCH_HIGHLIGHT_MAX_BYTES} THEN highlight(${corpus},1,?,'') END AS title,
      CASE WHEN body_bytes<=${SEARCH_HIGHLIGHT_MAX_BYTES} THEN highlight(${corpus},2,?,'') END AS aliases,
      CASE WHEN body_bytes<=${SEARCH_HIGHLIGHT_MAX_BYTES} THEN highlight(${corpus},3,?,'') END AS body
      FROM ${corpus} WHERE ${corpus} MATCH ? ORDER BY score,id LIMIT ? OFFSET ?`)
          .all(marker, marker, marker, expression, limit, offset);
        const byId = new Map(selected.map((r) => [r.id, r]));
        // FTS5 highlight/snippet enumeration becomes quadratic with many repeated
        // instances. Full-record matching and BM25 stay authoritative; large bodies
        // use an explicitly labelled opening excerpt, not an approximate token match.
        // The bound counts stored body bytes: CJK index text is about twice as long
        // but holds no more tokens per stored byte than Latin text.
        const fieldExpression = keywordExpression({
          ...input,
          mode: input.mode === "phrase" ? "phrase" : "any",
        });
        const columnMatch = db.prepare(
          `SELECT 1 FROM ${corpus} WHERE id=? AND ${corpus} MATCH ? LIMIT 1`,
        );
        const hits = rows.map((row) => {
          if (row.body === null) {
            const fields = (["title", "aliases", "body"] as const).filter((field) =>
              columnMatch.get(row.id!, `${field} : (${fieldExpression})`),
            );
            const field = fields.includes("body") ? "body" : (fields[0] ?? "title");
            const result = hit(byId.get(String(row.id))!, field, 0, fields, -Number(row.score));
            result.snippet.matchLocated = false;
            return result;
          }
          const fields = (["title", "aliases", "body"] as const).filter((field) =>
            String(row[field]).includes(marker),
          );
          const field = fields.includes("body") ? "body" : (fields[0] ?? "title"),
            record = byId.get(String(row.id))!,
            at = Math.max(0, String(row[field]).indexOf(marker));
          return hit(
            record,
            field,
            originalOffset(fieldText(record, field), at),
            fields,
            -Number(row.score),
          );
        });
        // A current-record search also reaches current records through the wording
        // of superseded versions it hides, listed after every direct match. The hit
        // cites the current record; `via` pins the earlier revision that matched.
        const followed = ranked.length
          ? followReplacements(
              db,
              historyCorpus,
              expression,
              new Map(ranked.map((r) => [r.id, r])),
              targets,
              () => {
                const ids = db.prepare(`SELECT id FROM ${corpus} WHERE ${corpus} MATCH ?`);
                return new Set(ids.all(expression).map((r) => String(r.id)));
              },
            )
          : [];
        const from = Math.max(0, offset - total);
        for (const { record, via } of followed.slice(from, from + limit - hits.length)) {
          const result = hit(record, "body", 0, ["superseded"], null);
          result.snippet.matchLocated = false;
          result.via = {
            id: via.id,
            title: via.title,
            path: via.path,
            revision: via.revision,
            hash: via.hash,
          };
          hits.push(result);
        }
        for (const temporary of [corpus, historyCorpus]) {
          if (temporary !== table && temporary !== historyTable) {
            db.exec(`DROP TABLE temp.${temporary}`);
          }
        }
        const combined = total + followed.length;
        return {
          ...base,
          freshness: queryFreshness(data.checkedAt, indexedAt),
          hits,
          resultCount: hits.length,
          total: combined,
          nextOffset: offset + limit < combined ? offset + limit : null,
          index: {
            state: "ready",
            lag: false,
            snapshot,
            message:
              "Indexed from the current reconciled scope. Higher BM25 scores rank first; compare scores only within this query and snapshot.",
          },
        };
      },
      { operationLabel: "knowledge.keyword.search" },
    );
  } catch {
    return {
      ...base,
      hits: [],
      resultCount: 0,
      total: null,
      nextOffset: null,
      index: {
        state: "unavailable",
        lag: null,
        snapshot: null,
        message:
          "Keyword indexing/query failed; no stale results returned. Retry search to rebuild or inspect the plugin-owned SQLite state. Exact lookup and record listing remain available.",
      },
    };
  }
}
