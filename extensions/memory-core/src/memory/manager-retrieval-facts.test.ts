import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { expect, it } from "vitest";
import {
  createPublication,
  publicationReplacement,
} from "./manager-publication-fixture.test-support.js";
import { readMemoryDatabaseFacts } from "./manager-retrieval-read.js";

function replacement(model: string, hash: string) {
  const input = publicationReplacement(hash);
  input.state = { ...input.state, fts: { enabled: false, available: false } };
  for (const source of input.sources) {
    source.header.model = model;
  }
  return input;
}

it("scans corpus facts once per persisted revision across independent writers", () => {
  using writer = createPublication();
  writer.expectResult({ type: "source.replace.group", input: replacement("fts-only", "initial") });
  using reader = createPublication({ filename: writer.filename, initialize: false });
  const visits = { model: 0, hash: 0 };
  for (const name of ["model", "hash"] as const) {
    reader.db.function(`visit_${name}`, (value) => {
      visits[name] += 1;
      return value;
    });
  }
  reader.db.exec(`
    CREATE TEMP VIEW memory_index_chunks AS
      SELECT visit_model(model) AS model FROM main.memory_index_chunks;
    CREATE TEMP VIEW memory_index_sources AS
      SELECT source, visit_hash(hash) AS hash FROM main.memory_index_sources;
  `);
  let statements = 0;
  const observer = observeHostDataSql((sql, database) => {
    if (database === undefined && /select .*hasSemanticChunks/i.test(sql)) {
      statements += 1;
    }
  });
  const facts = () => reader.backend.execute({ type: "index.facts", input: undefined });
  try {
    expect(facts()).toMatchObject({ hasSemanticChunks: false, invalidatedSources: [] });
    expect(visits).toEqual({ model: 4, hash: 2 });
    for (let index = 0; index < 9; index++) {
      facts();
    }
    expect(visits).toEqual({ model: 4, hash: 2 });
    // The revision/meta snapshot remains one statement, including cache misses.
    expect(statements).toBe(10);
    writer.expectResult({
      type: "index.writeMetadata",
      input: { provider: "none", model: "fts-only", chunkTokens: 400, chunkOverlap: 80 },
    });
    expect(facts()).toMatchObject({ meta: { provider: "none" } });
    expect(visits).toEqual({ model: 4, hash: 2 });
    writer.expectResult({
      type: "source.replace.group",
      input: replacement("fts-only", "changed"),
    });
    expect(facts()).toMatchObject({ revision: 2, hasSemanticChunks: false });
    expect(visits).toEqual({ model: 8, hash: 4 });
    facts();
    expect(visits).toEqual({ model: 8, hash: 4 });
  } finally {
    observer.restore();
  }
});

it("matches uncached snapshots through invalidation, semantic and FTS-only publications", () => {
  using writer = createPublication();
  using reader = createPublication({ filename: writer.filename, initialize: false });
  const check = (expected: object) => {
    const actual = readMemoryDatabaseFacts(reader.db);
    expect(actual).toMatchObject(expected);
    using fresh = createPublication({ filename: writer.filename, initialize: false });
    expect(actual).toEqual(readMemoryDatabaseFacts(fresh.db));
  };
  check({ hasIndexedChunks: false, hasSemanticChunks: false, invalidatedSources: [] });
  for (const [model, hash, expected] of [
    ["fts-only", "", { invalidatedSources: ["memory"], hasSemanticChunks: false }],
    ["fts-only", "restored", { invalidatedSources: [], hasSemanticChunks: false }],
    ["semantic-model", "semantic", { invalidatedSources: [], hasSemanticChunks: true }],
    ["fts-only", "provider-switch", { invalidatedSources: [], hasSemanticChunks: false }],
  ] as const) {
    writer.expectResult({ type: "source.replace.group", input: replacement(model, hash) });
    check({ ...expected, hasIndexedChunks: true });
  }
});

it("does not reuse transactional facts after a refused inline publication reuses its revision", () => {
  using fixture = createPublication();
  const { backend, db, admission } = fixture;
  fixture.expectResult({ type: "source.replace.group", input: replacement("fts-only", "initial") });
  db.exec("BEGIN IMMEDIATE; UPDATE memory_index_sources SET hash = ''");
  try {
    expect(readMemoryDatabaseFacts(db)).toMatchObject({
      revision: 1,
      invalidatedSources: ["memory"],
    });
  } finally {
    db.exec("ROLLBACK");
  }
  admission.denied = true;
  const refused = replacement("semantic-model", "");
  expect(
    backend.execute({
      type: "source.replace.inline",
      input: { ...refused.sources[0]!, state: refused.state },
    }),
  ).toMatchObject({ ok: false, committed: false });
  admission.denied = false;
  fixture.expectResult({
    type: "source.replace.group",
    input: replacement("fts-only", "committed"),
  });
  expect(readMemoryDatabaseFacts(db)).toMatchObject({
    revision: 2,
    hasSemanticChunks: false,
    invalidatedSources: [],
  });
  using fresh = createPublication({ filename: fixture.filename, initialize: false });
  expect(readMemoryDatabaseFacts(db)).toEqual(readMemoryDatabaseFacts(fresh.db));
});
