import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, rm, rename, link, symlink } from "node:fs/promises";
import path from "node:path";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { stringify } from "yaml";
import { contract } from "./contract.js";
import { SqliteIdentityStore } from "./identity-store.js";
import { isFullHit } from "./retrieval-contract.js";
import { keywordExpression } from "./retrieval.js";
import { AGENT_HIT_LIMIT, COMPACT_SNIPPET_CHARS } from "./search-detail.js";
import { createKnowledgeService } from "./service.js";
import { apiFor, useTestTempDirs, defaultOrder, type TestStoreConfig } from "./test-support.js";

const tempDirs = useTestTempDirs();

async function fixture() {
  const base = tempDirs.make("knowledge-retrieval-");

  const root = path.join(base, "vault"),
    sessionId = randomUUID();
  const manifest = {
    format: "knowledge-vault-v2",
    vaultId: randomUUID(),
    generation: 0,
    publicationId: randomUUID(),
  };
  await mkdir(root);
  await mkdir(path.join(root, "private"));
  await writeFile(path.join(root, "vault.json"), JSON.stringify(manifest));
  const config: TestStoreConfig = {
    root,
    statePath: path.join(base, "state.sqlite"),
    vaultId: manifest.vaultId,
    publicationId: manifest.publicationId,
    writesEnabled: false,
    operatorRead: true,
  };
  const api = apiFor(base, config);
  const owner: any = {
    source: "tool",
    api,
    tool: {
      agentId: "main",
      memoryAudience: { kind: "owner-private", agentId: "main" },
      assertInvocationCurrent() {},
      assertMemoryAudienceCurrent() {},
    },
  };
  const operator: any = {
    source: "session-action",
    api,
    action: { client: { connId: "test", scopes: ["operator.read"] } },
  };
  const service = createKnowledgeService(api),
    store = new SqliteIdentityStore(config.statePath);
  async function put(id: any, title: any, body: any, metadata = {}, partition = "private") {
    const scope =
      partition === "private"
        ? { visibility: "private" }
        : { visibility: "conversation", sessionId: partition.split("/")[1] };
    const envelope = {
      format: "knowledge-record-v1",
      id,
      revision: 1,
      kind: "page",
      title,
      scope,
      type: "note",
      fields: {},
      recorded_at: "2026-09-23T00:00:00Z",
      updated_at: "2026-09-23T00:00:00Z",
      lifecycle: "active",
      ...metadata,
    };
    const target = path.join(root, partition, "notes", id + ".md");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `---\n${stringify(envelope)}---\n${body}`);
    return target;
  }
  return {
    // Total keyword hits and exact-lookup outcome for the current owner audience.
    total: async (input: any) => (await service.grep(input, owner)).total,
    outcome: async (input: any) => (await service.lookup(input, owner)).outcome,
    root,
    base,
    config,
    manifest,
    sessionId,
    api,
    owner,
    operator,
    service,
    store,
    put,
    group: () => {
      owner.tool.memoryAudience = {
        kind: "conversation",
        agentId: "main",
        sessionKey: "agent:main:group",
        sessionId,
      };
    },
  };
}
const ids = (result: any) => result.hits.map((h: any) => h.record.id);
const stable = (value: any) =>
  JSON.parse(JSON.stringify(value), (k, v) =>
    ["checkedAt", "indexedAt", "queriedAt", "scannedAt"].includes(k) ? undefined : v,
  );

it("UI and tool share FTS title/alias/body retrieval, literal modes and stable citation contracts", async () => {
  const f = await fixture();
  await f.put(
    "record_alpha",
    "Orchid title",
    "A long introduction.\nA distinctive body marker.\n",
    { aliases: ["Purple flower"], tags: ["botany"] },
  );
  for (const [query, field] of [
    ["orchid", "title"],
    ["purple flower", "aliases"],
    ["distinctive", "body"],
  ] as const) {
    const result = await f.service.grep({ query, detail: "full" }, f.owner),
      ui = await f.service.grep({ query }, f.operator),
      compact = await f.service.grep({ query }, f.owner);
    expect(Check(contract.operations.grep.output, result)).toBeTruthy();
    expect(Check(contract.operations.grep.output, compact)).toBeTruthy();
    expect(stable(result)).toStrictEqual(stable(ui));
    expect(compact.hits.map((h) => h.record.id)).toStrictEqual(ui.hits.map((h) => h.record.id));
    expect(result.index.state).toBe("ready");
    expect(result.index.lag).toBe(false);
    expect(result.total).toBe(1);
    expect(result.hits[0]!.matches).toStrictEqual([field]);
    const current = (await f.service.record({ id: "record_alpha" }, f.owner)).record;
    expect(result.hits.find(isFullHit)!.citation.hash).toBe(current!.hash);
    expect(result.hits.find(isFullHit)!.citation.revision).toBe(current!.revision);
  }
  expect(await f.total({ query: "orchid nonexistent", mode: "all" })).toBe(0);
  expect(await f.total({ query: "orchid nonexistent", mode: "any" })).toBe(1);
  expect(await f.total({ query: "distinctive body", mode: "phrase" })).toBe(1);
  expect(await f.total({ query: "body distinctive", mode: "phrase" })).toBe(0);
  expect(await f.total({ query: "flower", tag: "wrong" })).toBe(0);
  expect(await f.total({ query: "flower", tag: "botany", kind: "page", type: "note" })).toBe(1);
});

it("exact ID/name/alias lookup normalizes names, exposes ambiguity and never selects arbitrarily", async () => {
  const f = await fixture();
  await f.put("record_alpha", "Full Name", "Body", { aliases: [" Shared Alias ", "Ｃａｆｅ"] });
  await f.put("record_beta", "Someone else", "Body", { aliases: ["shared alias"] });
  for (const query of ["record_alpha", " full   NAME ", "cafe"]) {
    const result = await f.service.lookup({ query }, f.owner);
    expect(Check(contract.operations.lookup.output, result)).toBeTruthy();
    expect(result.outcome).toBe("found");
    expect(ids(result)).toStrictEqual(["record_alpha"]);
  }
  expect(await f.outcome({ query: "Full" })).toBe("missing");
  expect(await f.outcome({ query: "RECORD_ALPHA" })).toBe("missing");
  const ambiguous = await f.service.lookup({ query: "shared alias", limit: 1 }, f.owner);
  expect(ambiguous.outcome).toBe("ambiguous");
  expect(ambiguous.total).toBe(2);
  expect(ambiguous.nextOffset).toBe(1);
});

it("all saved records are discoverable regardless of legacy approval metadata; lifecycle filters still apply", async () => {
  const f = await fixture();
  await f.put("accepted_one", "Orbit", "short text");
  await f.put("candidate_one", "Orbit", "orbit ".repeat(1000), { acceptance: "candidate" });
  await f.put("historical_one", "Orbit", "orbit history", { lifecycle: "superseded" });
  const after = await f.service.grep({ query: "orbit" }, f.owner);
  expect(ids(after).toSorted(defaultOrder)).toStrictEqual(["accepted_one", "candidate_one"]);
  expect(after.hits.every((hit) => !Object.hasOwn(hit.record, "acceptance"))).toBeTruthy();
  expect(
    ids(await f.service.grep({ query: "orbit", lifecycle: "superseded" }, f.owner)),
  ).toStrictEqual(["historical_one"]);
  expect(await f.total({ query: "orbit", lifecycle: "all" })).toBe(3);
  expect(await f.outcome({ query: "candidate_one" })).toBe("found");
  expect((await f.service.records({}, f.owner)).total).toBe(2);
  expect((await f.service.records({ lifecycle: "all" }, f.owner)).total).toBe(3);
});

it("scope isolates results, counts, exact identity, snippets, corpus statistics and cached projections", async () => {
  const f = await fixture(),
    shared = `conversations/${f.sessionId}`;
  await f.put("shared_first", "Comet", "shared text", {}, shared);
  await f.put("shared_second", "Other", "comet tail", {}, shared);
  await f.put("private_record", "PRIVATE SENTINEL", "comet ".repeat(1000));
  await f.service.grep({ query: "comet" }, f.owner); // private projection exists
  f.group();
  const before = await f.service.grep({ query: "comet" }, f.owner);
  await f.put("private_second", "PRIVATE SECOND", "comet ".repeat(2000));
  const after = await createKnowledgeService(f.api).grep({ query: "comet" }, f.owner);
  expect(stable(after)).toStrictEqual(stable(before));
  expect(JSON.stringify(after)).not.toMatch(/PRIVATE|private_record|private_second/);
  expect(await f.outcome({ query: "PRIVATE SENTINEL" })).toBe("missing");
  await f.put(
    "foreign_scope",
    "PRIVATE SENTINEL",
    "comet",
    { scope: { visibility: "private" } },
    shared,
  );
  expect(JSON.stringify(await f.service.grep({ query: "comet" }, f.owner))).not.toMatch(/PRIVATE/);
});

it("invalid, duplicate, broken evidence and unavailable dependent records cannot leak through retrieval", async () => {
  const f = await fixture();
  const good = await f.put("duplicate_one", "DUPLICATE SENTINEL", "secretword");
  await writeFile(path.join(path.dirname(good), "duplicate.md"), await readFile(good));
  await f.put("invalid_one", "INVALID SENTINEL", "secretword", { type: "unrecognized" });
  await f.put("broken_evidence", "EVIDENCE SENTINEL", "secretword", {
    evidence: [
      { path: "artifacts/missing.txt", sha256: "0".repeat(64), start_line: 1, end_line: 1 },
    ],
  });
  await f.put("dependent_one", "DEPENDENT SENTINEL", "secretword", {
    dependencies: ["invalid_one"],
  });
  await f.put("dependent_two", "TRANSITIVE SENTINEL", "secretword", {
    dependencies: ["dependent_one"],
  });
  const result = await f.service.grep({ query: "secretword" }, f.owner);
  expect(result.total).toBe(0);
  expect(result.coverage.complete).toBe(false);
  expect(JSON.stringify(result)).not.toMatch(/SENTINEL/);
  for (const query of [
    "duplicate_one",
    "INVALID SENTINEL",
    "EVIDENCE SENTINEL",
    "DEPENDENT SENTINEL",
  ]) {
    expect(await f.outcome({ query })).toBe("missing");
  }
});

it("observed withdrawals persist across stale-file reappearance, restart and projection rebuild", async () => {
  const f = await fixture(),
    target = await f.put("withdrawn_one", "Withdraw this", "secretword");
  const stale = await readFile(target, "utf8");
  await f.put("dependent_one", "Derived prose", "secretword", { dependencies: ["withdrawn_one"] });
  expect(await f.total({ query: "secretword" })).toBe(2);
  await writeFile(target, stale.replace("lifecycle: active", "lifecycle: withdrawn"));
  // Any normal scoped scan records the operational safeguard, not only search.
  await f.service.records({}, f.owner);
  await writeFile(target, stale);
  f.store.withDatabase((db) => {
    for (const row of db
      .prepare("SELECT name FROM sqlite_master WHERE sql LIKE 'CREATE VIRTUAL TABLE%'")
      .all()) {
      db.exec(`DROP TABLE ${String(row.name)}`);
    }
  });
  const service = createKnowledgeService(f.api);
  const result = await service.grep({ query: "secretword", lifecycle: "all" }, f.owner);
  expect(result.total).toBe(0);
  expect(
    (await service.lookup({ query: "withdrawn_one", lifecycle: "all" }, f.owner)).outcome,
  ).toBe("missing");
});

it("external edits, rename, deletion, malformed replacement and ontology changes replace the projection", async () => {
  const f = await fixture();
  let target = await f.put("editable_one", "Oldname", "oldword");
  const before = await f.service.grep({ query: "oldword" }, f.owner);
  await writeFile(target, (await readFile(target, "utf8")).replace("oldword", "newword"));
  await rename(target, target + "-renamed.md");
  target += "-renamed.md";
  expect(await f.total({ query: "oldword" })).toBe(0);
  const changed = await f.service.grep({ query: "newword", detail: "full" }, f.owner);
  expect(changed.index.snapshot).not.toBe(before.index.snapshot);
  expect(changed.hits.find(isFullHit)!.citation.path).toMatch(/renamed/);
  expect(changed.hits.find(isFullHit)!.citation.revision).toBe(2);
  await writeFile(target, "malformed newword");
  expect(await f.total({ query: "newword" })).toBe(0);
  await f.put("editable_two", "Newname", "newword");
  expect(await f.total({ query: "newword" })).toBe(1);
  await writeFile(path.join(f.root, "private", "ontology.yaml"), "not: a valid ontology");
  expect(await f.total({ query: "newword" })).toBe(0);
  await rm(path.join(f.root, "private", "ontology.yaml"));
  await rm(path.join(f.root, "private", "notes", "editable_two.md"));
  expect(await f.total({ query: "newword" })).toBe(0);
});

it("failed index updates return unavailable, not empty/stale; exact lookup and listing still work; retry rebuilds", async () => {
  const f = await fixture(),
    target = await f.put("editable_one", "Known identity", "oldword");
  expect(await f.total({ query: "oldword" })).toBe(1);
  f.store.withDatabase((db) =>
    db.exec(
      "CREATE TRIGGER fail_keyword BEFORE INSERT ON keyword_state_v1 BEGIN SELECT RAISE(ABORT,'injected indexing failure'); END",
    ),
  );
  await writeFile(target, (await readFile(target, "utf8")).replace("oldword", "newword"));
  const failed = await f.service.grep({ query: "oldword" }, f.owner);
  expect(Check(contract.operations.grep.output, failed)).toBeTruthy();
  expect(failed.index.state).toBe("unavailable");
  expect(failed.total).toBe(null);
  expect(failed.hits).toStrictEqual([]);
  expect(await f.outcome({ query: "Known identity" })).toBe("found");
  expect((await f.service.records({}, f.owner)).total).toBe(1);
  f.store.withDatabase((db) => db.exec("DROP TRIGGER fail_keyword"));
  expect(await f.total({ query: "newword" })).toBe(1);
  expect(await f.total({ query: "oldword" })).toBe(0);
});

// Manifest identity mismatch after a cached index is covered by the restored-generation case below.
it("revoked authority rejects retrieval without cached fallback", async () => {
  const f = await fixture();
  await f.put("private_record", "PRIVATE SENTINEL", "secretword");
  await f.service.grep({ query: "secretword" }, f.owner);
  const revoked = {
    ...f.owner,
    tool: {
      ...f.owner.tool,
      assertInvocationCurrent() {
        throw new Error("revoked");
      },
    },
  };
  for (const op of ["grep", "lookup"] as const) {
    await expect(f.service[op]({ query: "secretword" }, revoked)).rejects.toThrow(/revoked/);
  }
});

it("hardlinks and symlinks cannot import another scope into the keyword corpus", async () => {
  const f = await fixture(),
    target = await f.put("private_record", "PRIVATE SENTINEL", "secretword");
  const shared = path.join(f.root, "conversations", f.sessionId);
  await mkdir(shared, { recursive: true });
  await link(target, path.join(shared, "hardlink.md"));
  await symlink(target, path.join(shared, "symlink.md"));
  f.group();
  const result = await f.service.grep({ query: "secretword" }, f.owner);
  expect(result.total).toBe(0);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE/);
});

it("bounded contextual snippets have truthful original Markdown lines", async () => {
  const f = await fixture(),
    body = `${"Introduction\n".repeat(100)}rareword <script>alert('unsafe')</script>\n${"tail 😀\n".repeat(200)}`;
  const target = await f.put("snippet_record", "Long record", body),
    raw = await readFile(target, "utf8");
  const result = await f.service.grep({ query: "rareword", detail: "full" }, f.owner),
    hit = result.hits.find(isFullHit),
    snippet = hit!.snippet;
  expect(snippet.field).toBe("body");
  expect(snippet.text).toMatch(/rareword/);
  expect(snippet.text.length <= 480).toBeTruthy();
  expect(snippet.truncated).toBe(true);
  expect(snippet.text).toBe(body.slice(snippet.start, snippet.end));
  expect(
    raw
      .split("\n")
      .slice(snippet.startLine! - 1, snippet.endLine!)
      .join("\n")
      .includes(snippet.text),
  ).toBeTruthy();
  expect(Check(contract.operations.grep.output, result)).toBeTruthy();
  // Agent calls default to compact hits whose short snippet still keeps the match.
  const compact = (await f.service.grep({ query: "rareword" }, f.owner)).hits[0]!;
  expect(Object.keys(compact).toSorted(defaultOrder)).toStrictEqual([
    "matches",
    "record",
    "snippet",
  ]);
  expect(Object.keys(compact.record).toSorted(defaultOrder)).toStrictEqual([
    "id",
    "kind",
    "lifecycle",
    "path",
    "revision",
    "title",
    "type",
    "valid",
  ]);
  expect(compact.snippet.text).toMatch(/rareword/);
  // The cut never splits the emoji tail's surrogate pairs.
  expect(compact.snippet.text.length <= COMPACT_SNIPPET_CHARS).toBeTruthy();
  expect(compact.snippet.text.isWellFormed()).toBe(true);
});

it("FTS operators are literal words, malformed/oversized input is rejected, Unicode terms work", async () => {
  const f = await fixture();
  await f.put("unicode_record", "Café project", "alpha OR beta 東京");
  expect(await f.total({ query: "cafe" })).toBe(1);
  expect(await f.total({ query: "東京" })).toBe(1);
  expect(keywordExpression({ query: "alpha OR beta" })).toBe('"alpha" AND "OR" AND "beta"');
  for (const query of ["", "   ", "***", "a ".repeat(65), "a".repeat(501)]) {
    await expect(f.service.grep({ query }, f.owner)).rejects.toThrow(/input|tokens/);
  }
  await expect(f.service.grep({ query: '"' }, f.owner)).rejects.toThrow();
  for (const query of ["column:missing", "NEAR(alpha)", 'alpha") OR 1=1 --']) {
    expect((await f.service.grep({ query }, f.owner)).index.state).toBe("ready");
  }
  for (const field of [
    { scope: "private" },
    { agentId: "main" },
    { lifecycle: "withdrawn" },
    { mode: "regex" },
  ]) {
    expect(Check(contract.operations.grep.input, { query: "cafe", ...field })).toBe(false);
  }
});

it("ranking emphasizes titles, deterministic pagination and scoped index reuse", async () => {
  const f = await fixture();
  await f.put("title_record", "Needle", "text");
  await f.put("body_record", "Other", "needle");
  for (let n = 0; n <= AGENT_HIT_LIMIT; n++) {
    await f.put(`haystack_${n}`, "Other", "haystack");
  }
  const first = await f.service.grep({ query: "needle", limit: 1 }, f.owner);
  expect(ids(first)).toStrictEqual(["title_record"]);
  expect(first.total).toBe(2);
  expect(first.nextOffset).toBe(1);
  const next = await f.service.grep({ query: "needle", limit: 1, offset: 1 }, f.owner);
  expect(ids(next)).toStrictEqual(["body_record"]);
  expect(next.nextOffset).toBe(null);
  expect(next.index.snapshot).toBe(first.index.snapshot);
  expect(next.freshness.indexedAt).toBe(first.freshness.indexedAt);
  // Agent calls that omit limit get the agent page size, not the storage default.
  const agentPage = await f.service.grep({ query: "haystack" }, f.owner);
  expect(agentPage.hits.length).toBe(AGENT_HIT_LIMIT);
  expect(agentPage.nextOffset).toBe(AGENT_HIT_LIMIT);
});

it("published pages are immediately searchable without approval; restored generations cannot serve a newer index", async () => {
  const f = await fixture(),
    api = { ...f.api, pluginConfig: { operatorRead: true, writesEnabled: true } },
    service = createKnowledgeService(api);
  const receipt = await service.save_page(
    {
      requestId: randomUUID(),
      title: "Fresh publication",
      type: "note",
      body: "newlypublishedword",
      source: { text: "Original source\nSecond line", attribution: "User note" },
    },
    f.owner,
  );
  expect(receipt.state).toBe("published");
  expect(receipt.indexed).toBe(false);
  expect(receipt.message).toMatch(/pending/);
  const indexed = await service.grep({ query: "newlypublishedword", detail: "full" }, f.owner);
  expect(indexed.index.state).toBe("ready");
  expect(indexed.total).toBe(1);
  expect(indexed.hits.find(isFullHit)!.citation.hash).toBe(receipt.hash);
  expect(indexed.hits.find(isFullHit)!.evidence.length).toBe(1);
  expect(indexed.hits.find(isFullHit)!.evidence[0]!.start_line).toBe(1);
  expect(indexed.hits.find(isFullHit)!.attribution).toBe("User note");
  expect((await service.lookup({ query: receipt.id }, f.owner)).outcome).toBe("found");
  const raw = (await service.record({ id: receipt.id, view: "raw" }, f.owner)).record!.raw;
  expect(raw).not.toMatch(/acceptance:/);
  await writeFile(path.join(f.root, "vault.json"), JSON.stringify(f.manifest));
  for (const op of ["grep", "lookup"] as const) {
    await expect(service[op]({ query: "newlypublishedword" }, f.owner)).rejects.toThrow(/identity/);
  }
});

it("empty conversations return a ready empty scope without materializing a directory", async () => {
  const f = await fixture();
  await f.put("private_record", "PRIVATE", "privateword");
  f.group();
  const result = await f.service.grep({ query: "privateword" }, f.owner);
  expect(result.index.state).toBe("ready");
  expect(result.total).toBe(0);
  expect(result.coverage.complete).toBe(true);
  expect(await f.outcome({ query: "PRIVATE" })).toBe("missing");
  await expect(readFile(path.join(f.root, "conversations", f.sessionId))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("editing a legacy page removes approval metadata through journaled publication and preserves authored material", async () => {
  const f = await fixture();
  await f.put("legacy_record", "Legacy page", "Original body", {
    acceptance: "candidate",
    custom_note: "Preserve me",
  });
  const api = { ...f.api, pluginConfig: { operatorRead: true, writesEnabled: true } },
    service = createKnowledgeService(api);
  const previous = (await service.record({ id: "legacy_record", includeMetadata: true }, f.owner))
    .record;
  const receipt = await service.save_page(
    {
      requestId: randomUUID(),
      id: previous!.id,
      expectedRevision: previous!.revision,
      expectedHash: previous!.hash,
      title: previous!.title,
      body: previous!.body!,
    },
    f.owner,
  );
  expect(receipt.state).toBe("published");
  const current = (
    await service.record({ id: previous!.id, view: "raw", includeMetadata: true }, f.owner)
  ).record;
  expect(current!.raw).not.toMatch(/acceptance:/);
  // Authored metadata keys outside the contract survive the edit.
  const metadata: Record<string, unknown> = current!.metadata!;
  expect(metadata.custom_note).toBe("Preserve me");
  expect(current!.revision).toBe(previous!.revision + 1);
  expect((await service.grep({ query: "Original body" }, f.owner)).total).toBe(1);
  for (const op of ["grep", "lookup"] as const) {
    expect(Check(contract.operations[op].input, { query: "Legacy", acceptance: "candidate" })).toBe(
      false,
    );
  }
});

it("an index built before row tracking is repopulated, never left empty and ready", async () => {
  const f = await fixture();
  await f.put("upgrade_note_1", "Upgrade sentinel", "lanternword body");
  expect(await f.total({ query: "lanternword" })).toBe(1);
  // Simulate the previous version: FTS rows and a matching state row, no tracking table.
  f.store.withDatabase((db) => {
    for (const { name } of db
      .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'keyword_rows_v1_%'")
      .all()) {
      db.exec(`DROP TABLE ${String(name)}`);
    }
  });
  expect(await f.total({ query: "lanternword" })).toBe(1);
});
