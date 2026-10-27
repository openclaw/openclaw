import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FeatureInput } from "openclaw/plugin-sdk/feature-contract";
import { expect, it } from "vitest";
import { contract } from "./contract.js";
import type { ExtractSectionInput } from "./mutation-contract.js";
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
  const read = async (id: string, extra = {}) =>
    (await call("record", { id, view: "summary", metadataView: "full", ...extra })).record!;
  const fence = async (id: string) => {
    const r = await read(id);
    return { id, expectedRevision: r.revision, expectedHash: r.hash };
  };
  const file = (relative: string) => readFile(path.join(root, "private", relative), "utf8");
  const body = async (relative: string) =>
    (await file(relative)).replace(/^---\n[\s\S]*?\n---\n/, "");
  // Oversized pages exist only through external Markdown edits, as before budgets.
  const inflate = async (relative: string, next: string) => {
    const raw = await file(relative);
    await writeFile(
      path.join(root, "private", relative),
      raw.slice(0, raw.length - (await body(relative)).length) + next,
    );
  };
  const fences = { expectedVaultId: vaultId, expectedOntologyFingerprint: fingerprint };
  const edit = async (id: string, start: number, end: number, replacement: string) =>
    call("edit_body", {
      requestId: randomUUID(),
      ...(await fence(id)),
      ...fences,
      start,
      end,
      replacement,
      reason: "Edit",
    });
  const extract = async (
    source: string,
    sectionStart: number,
    extra: Partial<ExtractSectionInput> = {},
  ) =>
    call("extract_section", {
      requestId: randomUUID(),
      ...fences,
      source: await fence(source),
      sectionStart,
      destination: { title: "Atlas billing", type: "project" },
      summary: "Billing moved to Stripe; Sam owns it.",
      reason: "Own subject.",
      ...extra,
    });
  const upload = await call("attach", {
    requestId: randomUUID(),
    filename: "chat.txt",
    mediaType: "text/plain",
    attribution: "Synthetic chat",
    offset: 0,
    data: Buffer.from("Alex: We chose option B.").toString("base64"),
    final: true,
  });
  const cite = { ...upload.evidence!, start_line: 1, end_line: 1, quote: "We chose option B." };
  const claim = (title: string, text: string, entities: string[]) =>
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
  return { call, save, read, fence, file, body, inflate, fences, edit, extract, cite, claim };
}

it("rejects page growth on every prose path, never gates claims, and lets oversized pages shrink", async () => {
  const f = await fixture();
  const atlas = await f.save("Atlas", "concept", "Atlas.\n");
  const oversized = `## State\n${"a".repeat(20000)}\n## Timeline\n${"t".repeat(10000)}\n`;
  await f.inflate(atlas.path, oversized);
  const bytes = await f.file(atlas.path),
    before = await f.read(atlas.id);

  const grown = await f.edit(atlas.id, 0, 0, "x");
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
          hub: { hub: false },
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
  expect((await f.call("mutation", { requestId: grown.requestId })).receipt).toBe(null);
  const big = "b".repeat(PAGE_BUDGET_CHARS + 1);
  const left = await f.save("Sam", "person", "s".repeat(13000)),
    right = await f.save("Samuel", "person", "m".repeat(13000));
  for (const result of [
    await f.call("save_page", {
      requestId: randomUUID(),
      ...(await f.fence(atlas.id)),
      title: "Atlas",
      body: oversized + "more",
    }),
    await f.save("Too big", "concept", big),
    await f.call("publish_batch", {
      requestId: randomUUID(),
      ...f.fences,
      items: [
        { key: "page", kind: "page", input: { title: "Batch page", type: "concept", body: big } },
      ],
    }),
    await f.call("merge", {
      requestId: randomUUID(),
      reason: "Same person.",
      survivor: await f.fence(left.id),
      absorbed: await f.fence(right.id),
      body: "s".repeat(13000) + "m".repeat(13000),
    }),
  ]) {
    expect(result.state).toBe("rejected");
  }
  expect(await f.file(atlas.path)).toBe(bytes);

  // Facts about an oversized page are always saved as claims.
  const remembered = await f.call("remember", {
    requestId: randomUUID(),
    attribution: "user in test session",
    excerpt: "User: Atlas ships Friday.",
    items: [{ text: "Atlas ships Friday.", kind: "commitment", subject: "Atlas" }],
  });
  expect(remembered.items[0]).toMatchObject({ status: "inserted", subjectId: atlas.id });
  expect((await f.claim("Atlas size", "x".repeat(40000), [atlas.id])).state).toBe("published");

  // Same-size and shrinking edits pass, and extracting a section shrinks it further.
  expect((await f.edit(atlas.id, 9, 10, "b")).state).toBe("published");
  expect((await f.edit(atlas.id, 9, 109, "")).state).toBe("published");
  const timeline = (await f.body(atlas.path)).indexOf("## Timeline");
  expect(
    (
      await f.extract(atlas.id, timeline, {
        destination: { title: "Atlas history", type: "concept" },
      })
    ).state,
  ).toBe("published");
  expect((await f.body(atlas.path)).length).toBeLessThan(oversized.length - 9000);
});

it("extracts a section with its links, evidence, claim subjects and history, or changes nothing", async () => {
  const f = await fixture();
  const ledger = await f.save("Ledger", "concept", "Ledger notes.\n");
  const orphan = await f.save("Orphan", "concept", "Unrelated.\n");
  const atlas = await f.save("Atlas", "concept", "Atlas.\n", { attachments: [f.cite] });
  const provider = await f.claim("Billing provider", "Billing moved to Stripe.", [atlas.id]);
  const owner = await f.claim("Billing owner", "Atlas billing is owned by Sam.", [atlas.id]);
  const search = await f.claim("Search engine", "Search uses FTS.", [atlas.id]);
  const billing = `### Billing\n\nBilling moved to Stripe [[${provider.id}|decision]]; Sam owns it [[${owner.id}|owner]]. Invoices live in [Ledger](ledger.md): "We chose option B."\n\n`;
  const text = `# Atlas\n\n## State\n\nAtlas is the platform; see [Ledger](ledger.md).\n\n${billing}### Search\n\nSearch uses FTS [[${search.id}|search]].\n`;
  await f.call("save_page", {
    requestId: randomUUID(),
    ...(await f.fence(atlas.id)),
    title: "Atlas",
    body: text,
  });
  const start = text.indexOf("### Billing"),
    bytes = await f.file(atlas.path),
    sourceBefore = await f.read(atlas.id);

  // Unconnected destinations, non-heading offsets and stale fences change nothing.
  await expect(
    f.extract(atlas.id, start, { destination: await f.fence(orphan.id) }),
  ).rejects.toThrow(/not connected/);
  await expect(f.extract(atlas.id, 3)).rejects.toThrow(/No section heading/);
  await expect(
    f.extract(atlas.id, start, {
      source: { ...(await f.fence(atlas.id)), expectedHash: "0".repeat(64) },
    }),
  ).rejects.toThrow(/conflict/);
  // The destination's own budget applies.
  await f.inflate(ledger.path, "l".repeat(PAGE_BUDGET_CHARS - 100));
  expect(await f.extract(atlas.id, start, { destination: await f.fence(ledger.id) })).toMatchObject(
    { state: "rejected", id: ledger.id },
  );
  expect(await f.file(atlas.path)).toBe(bytes);

  const request = {
    requestId: randomUUID(),
    ...f.fences,
    source: await f.fence(atlas.id),
    sectionStart: start,
    destination: { title: "Atlas billing", type: "project" },
    summary: "Billing moved to Stripe; Sam owns it.",
    reason: "Billing has its own history.",
  };
  const receipt = await f.call("extract_section", request);
  expect(receipt).toMatchObject({ state: "published", operation: "extract", targetId: atlas.id });
  expect(await f.call("extract_section", request)).toStrictEqual(receipt);
  const destination = receipt.items!.find((i) => i.key === "destination")!;

  // The section moves verbatim with its relative link rewritten; the source keeps a summary link.
  const rewritten = path.posix.relative(path.posix.dirname(destination.path), ledger.path);
  expect(rewritten).not.toBe("ledger.md");
  expect(await f.body(destination.path)).toBe(billing.replace("](ledger.md)", `](${rewritten})`));
  expect(await f.body(atlas.path)).toBe(
    text.slice(0, start) +
      `### Billing\n\nBilling moved to Stripe; Sam owns it. See [[${destination.id}|Atlas billing]].\n\n` +
      text.slice(start + billing.length),
  );
  const links = async (id: string) =>
    (await f.call("connections", { id, direction: "links" })).connections
      .map((c) => c.record.id)
      .toSorted();
  expect(await links(destination.id)).toStrictEqual([ledger.id, owner.id, provider.id].toSorted());
  expect(await links(atlas.id)).toStrictEqual([destination.id, ledger.id, search.id].toSorted());
  const carried = await f.call("record", {
    id: destination.id,
    includeEvidence: true,
    view: "summary",
  });
  expect(JSON.stringify(carried.evidence)).toContain("We chose option B.");

  // Cited claims move their primary subject; the source stays only where the claim names it.
  const entities = async (id: string) => (await f.read(id)).metadata!.entities;
  expect(await entities(provider.id)).toStrictEqual([destination.id]);
  expect(await entities(owner.id)).toStrictEqual([destination.id, atlas.id]);
  expect(await entities(search.id)).toStrictEqual([atlas.id]);

  // The original text stays in history.
  const history = await f.call("history", { id: atlas.id });
  const previous = history.entries.find((e) => e.revision === sourceBefore.revision)!;
  expect(
    (await f.call("revision", { sequence: previous.sequence, maxChars: 65536 })).raw,
  ).toContain(billing);
});
