import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FeatureInput } from "openclaw/plugin-sdk/feature-contract";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { contract } from "./contract.js";
import { PAGE_BUDGET_CHARS } from "./page-budget.js";
import { createKnowledgeService } from "./service.js";
import { storeFixture, toolContext, useTestTempDirs } from "./test-support.js";

const tempDirs = useTestTempDirs();

// One isolated private vault driven through the agent tool handlers.
async function fixture() {
  const { api, root } = await storeFixture(tempDirs.make("knowledge-page-budget-"), {
    policy: { writesEnabled: true, operatorRead: true },
  });
  const service = createKnowledgeService(api),
    owner = toolContext(api);
  const call = async <K extends keyof typeof service>(
    op: K,
    input: FeatureInput<typeof contract, K>,
  ) => service[op](input, owner);
  const vaultId = (await call("status", {})).vault,
    fingerprint = (await call("ontology", {})).fingerprint;
  const save = (title: string, type: string, body: string, extra = {}) =>
    call("save_page", { requestId: randomUUID(), title, type, body, ...extra });
  const summary = async (id: string) => (await call("record", { id, view: "summary" })).record!;
  const fence = async (id: string) => {
    const r = await summary(id);
    return { id, expectedRevision: r.revision, expectedHash: r.hash };
  };
  const file = (relative: string) => path.join(root, "private", relative);
  const body = async (relative: string) =>
    (await readFile(file(relative), "utf8")).replace(/^---\n[\s\S]*?\n---\n/, "");
  // Oversized pages exist only through external Markdown edits, as before budgets.
  const inflate = async (relative: string, next: string) => {
    const raw = await readFile(file(relative), "utf8");
    await writeFile(
      file(relative),
      raw.slice(0, raw.length - (await body(relative)).length) + next,
    );
  };
  const edit = async (id: string, start: number, end: number, replacement: string) =>
    call("edit_body", {
      requestId: randomUUID(),
      ...(await fence(id)),
      expectedVaultId: vaultId,
      expectedOntologyFingerprint: fingerprint,
      start,
      end,
      replacement,
      reason: "Fixture body edit",
    });
  const evidence = async (text: string, quote: string) => ({
    ...(
      await call("attach", {
        requestId: randomUUID(),
        filename: "chat.txt",
        mediaType: "text/plain",
        attribution: "Synthetic chat",
        offset: 0,
        data: Buffer.from(text).toString("base64"),
        final: true,
      })
    ).evidence!,
    start_line: 1,
    end_line: 1,
    quote,
  });
  const claim = async (title: string, text: string, entities: string[], cite: any) =>
    call("create_claim", {
      requestId: randomUUID(),
      expectedOntologyFingerprint: fingerprint,
      title,
      body: text,
      claim_kind: "fact",
      assertion_origin: "source",
      attribution: "Synthetic chat line 1",
      evidence: [cite],
      entities,
    });
  const entities = async (id: string) =>
    (await call("record", { id, metadataView: "full", view: "summary" })).record!.metadata!
      .entities;
  return {
    call,
    vaultId,
    fingerprint,
    save,
    summary,
    fence,
    file,
    body,
    inflate,
    edit,
    evidence,
    claim,
    entities,
  };
}

it("rejects page growth past the budget on every prose path, never gates claims, and lets oversized pages shrink", async () => {
  const f = await fixture();
  const atlas = await f.save("Atlas", "concept", "Atlas.\n");
  const oversized = `## State\n${"a".repeat(20000)}\n## Timeline\n${"t".repeat(10000)}\n`;
  await f.inflate(atlas.path, oversized);
  const bytes = await readFile(f.file(atlas.path), "utf8"),
    before = await f.summary(atlas.id);

  const grown = await f.edit(atlas.id, 0, 0, "x");
  expect(Check(contract.operations.edit_body.output, grown)).toBe(true);
  expect(grown).toMatchObject({
    state: "rejected",
    id: atlas.id,
    revision: before.revision,
    hash: before.hash,
    budget: {
      pages: [
        {
          id: atlas.id,
          currentChars: oversized.length,
          attemptedChars: oversized.length + 1,
          budgetChars: PAGE_BUDGET_CHARS,
          hub: { hub: false, degree: 0 },
          sectionsOf: "current",
        },
      ],
    },
  });
  expect(grown.budget!.pages[0]!.sections.map((s) => [s.heading, s.start, s.chars])).toStrictEqual([
    ["State", 0, 20010],
    ["Timeline", 20010, 10013],
  ]);
  expect(grown.message).toMatch(/knowledge_extract_section/);
  expect(await readFile(f.file(atlas.path), "utf8")).toBe(bytes);
  expect((await f.call("mutation", { requestId: grown.requestId })).receipt).toBe(null);

  const growPage = await f.call("save_page", {
    requestId: randomUUID(),
    ...(await f.fence(atlas.id)),
    title: "Atlas",
    body: oversized + "more",
  });
  expect(growPage.state).toBe("rejected");
  const create = await f.save("Too big", "concept", "n".repeat(PAGE_BUDGET_CHARS + 1));
  expect(create).toMatchObject({ state: "rejected", id: "", budget: { pages: [{ id: null }] } });
  const batch = await f.call("publish_batch", {
    requestId: randomUUID(),
    expectedVaultId: f.vaultId,
    expectedOntologyFingerprint: f.fingerprint,
    items: [
      {
        key: "page",
        kind: "page",
        input: { title: "Batch page", type: "concept", body: "b".repeat(PAGE_BUDGET_CHARS + 1) },
      },
    ],
  });
  expect(batch.state).toBe("rejected");
  expect(await readFile(f.file(atlas.path), "utf8")).toBe(bytes);

  // Same-size rewrites and shrinking edits pass on a page already over budget.
  expect((await f.edit(atlas.id, 9, 10, "b")).state).toBe("published");
  expect((await f.edit(atlas.id, 9, 109, "")).state).toBe("published");
  expect((await f.body(atlas.path)).length).toBe(oversized.length - 100);

  // A combined merge body is page prose too.
  const left = await f.save("Sam", "person", "s".repeat(13000));
  const right = await f.save("Samuel", "person", "m".repeat(13000));
  const merged = await f.call("merge", {
    requestId: randomUUID(),
    reason: "Same person.",
    survivor: await f.fence(left.id),
    absorbed: await f.fence(right.id),
    body: "s".repeat(13000) + "m".repeat(13000),
  });
  expect(merged).toMatchObject({ state: "rejected", id: left.id });

  // Facts about an oversized page are always saved as claims.
  const remembered = await f.call("remember", {
    requestId: randomUUID(),
    attribution: "user in test session",
    excerpt: "User: Atlas ships Friday.",
    items: [{ text: "Atlas ships Friday.", kind: "commitment", subject: "Atlas" }],
  });
  expect(remembered.receipt!.state).toBe("published");
  expect(remembered.items[0]!.subjectId).toBe(atlas.id);
  const cite = await f.evidence("Alex: Atlas is large.", "Atlas is large.");
  expect((await f.claim("Atlas size", "x".repeat(40000), [atlas.id], cite)).state).toBe(
    "published",
  );
});

it("extracts a section with its links, evidence, claim subjects and history in one fenced publication", async () => {
  const f = await fixture();
  const cite = await f.evidence("Alex: We chose option B.", "We chose option B.");
  const ledger = await f.save("Ledger", "concept", "Ledger notes.\n");
  const atlas = await f.save("Atlas", "concept", "Atlas.\n", { attachments: [cite] });
  const provider = await f.claim("Billing provider", "Billing moved to Stripe.", [atlas.id], cite);
  const owner = await f.claim("Billing owner", "Atlas billing is owned by Sam.", [atlas.id], cite);
  const search = await f.claim("Search engine", "Search uses FTS.", [atlas.id], cite);
  const billing = `### Billing\n\nBilling moved to Stripe [[${provider.id}|decision]]; Sam owns it [[${owner.id}|owner]]. Invoices live in [Ledger](ledger.md): "We chose option B."\n\n`;
  const text = `# Atlas\n\n## State\n\nAtlas is the platform; see [Ledger](ledger.md).\n\n${billing}### Search\n\nSearch uses FTS [[${search.id}|search]].\n`;
  await f.call("save_page", {
    requestId: randomUUID(),
    ...(await f.fence(atlas.id)),
    title: "Atlas",
    body: text,
  });
  const sectionStart = text.indexOf("### Billing"),
    sourceBefore = await f.summary(atlas.id);
  const request = {
    requestId: randomUUID(),
    expectedVaultId: f.vaultId,
    expectedOntologyFingerprint: f.fingerprint,
    source: await f.fence(atlas.id),
    sectionStart,
    destination: { title: "Atlas billing", type: "project" },
    summary: "Billing moved to Stripe; Sam owns it.",
    reason: "Billing has its own history.",
  };
  const receipt = await f.call("extract_section", request);
  expect(receipt).toMatchObject({ state: "published", operation: "extract", targetId: atlas.id });
  const [destination, source] = receipt.items!;
  expect([destination!.key, source!.key, source!.id]).toStrictEqual([
    "destination",
    "source",
    atlas.id,
  ]);
  expect(await f.call("extract_section", request)).toStrictEqual(receipt);

  // The section moves verbatim; its relative link is rewritten for the new directory.
  const rewritten = path.posix.relative(path.posix.dirname(destination!.path), ledger.path);
  expect(rewritten).not.toBe("ledger.md");
  expect(await f.body(destination!.path)).toBe(billing.replace("](ledger.md)", `](${rewritten})`));
  expect(await f.body(atlas.path)).toBe(
    text.slice(0, sectionStart) +
      `### Billing\n\nBilling moved to Stripe; Sam owns it. See [[${destination!.id}|Atlas billing]].\n\n` +
      text.slice(sectionStart + billing.length),
  );
  const links = async (id: string) =>
    (await f.call("connections", { id, direction: "links" })).connections
      .map((c) => c.record.id)
      .toSorted();
  expect(await links(destination!.id)).toStrictEqual([ledger.id, owner.id, provider.id].toSorted());
  expect(await links(atlas.id)).toStrictEqual([destination!.id, ledger.id, search.id].toSorted());
  const carried = await f.call("record", {
    id: destination!.id,
    includeEvidence: true,
    view: "summary",
  });
  expect(JSON.stringify(carried.evidence)).toContain("We chose option B.");

  // Cited claims move their primary subject; the source stays only where the claim names it.
  expect(await f.entities(provider.id)).toStrictEqual([destination!.id]);
  expect(await f.entities(owner.id)).toStrictEqual([destination!.id, atlas.id]);
  expect(await f.entities(search.id)).toStrictEqual([atlas.id]);
  expect((await f.summary(search.id)).revision).toBe(search.revision);

  // The original text stays in history.
  const history = await f.call("history", { id: atlas.id });
  const previous = history.entries.find((e) => e.revision === sourceBefore.revision)!;
  expect(
    (await f.call("revision", { sequence: previous.sequence, maxChars: 65536 })).raw,
  ).toContain(billing);
});

it("rejects unsafe extractions without changing the source, and an oversized page may shrink by extracting", async () => {
  const f = await fixture();
  const ledger = await f.save("Ledger", "concept", "Ledger notes.\n");
  const orphan = await f.save("Orphan", "concept", "Unrelated.\n");
  const atlas = await f.save("Atlas", "concept", "Atlas.\n");
  const text = `See [[Ledger]].\n\n### Archive\n${"a".repeat(13000)}\n### Notes\n${"n".repeat(13000)}\n`;
  await f.inflate(atlas.path, text);
  const bytes = await readFile(f.file(atlas.path), "utf8");
  const request = async (extra = {}) => ({
    requestId: randomUUID(),
    expectedVaultId: f.vaultId,
    expectedOntologyFingerprint: f.fingerprint,
    source: await f.fence(atlas.id),
    sectionStart: text.indexOf("### Archive"),
    destination: { title: "Atlas archive", type: "concept" } as any,
    summary: "Archived notes.",
    reason: "Shrink Atlas.",
    ...extra,
  });
  for (const [extra, error] of [
    [{ destination: await f.fence(orphan.id) }, /not connected/],
    [{ sectionStart: 3 }, /No section heading/],
    [{ source: { ...(await f.fence(atlas.id)), expectedHash: "0".repeat(64) } }, /conflict/],
  ] as const) {
    const input = await request(extra);
    await expect(f.call("extract_section", input)).rejects.toThrow(error);
    expect((await f.call("mutation", { requestId: input.requestId })).receipt).toBe(null);
  }
  // The destination's budget applies: Ledger cannot absorb 13,000 more characters past 24,000.
  await f.inflate(ledger.path, "l".repeat(PAGE_BUDGET_CHARS - 1000));
  const full = await f.call(
    "extract_section",
    await request({ destination: await f.fence(ledger.id) }),
  );
  expect(full).toMatchObject({ state: "rejected", id: ledger.id });
  expect(await readFile(f.file(atlas.path), "utf8")).toBe(bytes);

  const moved = await f.call("extract_section", await request());
  expect(moved.state).toBe("published");
  expect((await f.body(atlas.path)).length).toBeLessThan(text.length - 12000);
});
