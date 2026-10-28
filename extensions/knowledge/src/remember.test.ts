import { randomUUID } from "node:crypto";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { contract } from "./contract.js";
import type { RememberInput } from "./remember-contract.js";
import { createKnowledgeService } from "./service.js";
import { storeFixture, toolContext, useTestTempDirs, defaultOrder } from "./test-support.js";

const tempDirs = useTestTempDirs();

async function fixture() {
  const { api } = await storeFixture(tempDirs.make("knowledge-remember-"), {
    policy: { writesEnabled: true, operatorRead: true },
  });
  const service = createKnowledgeService(api),
    owner = toolContext(api);
  const page = (title: any, extra = {}) =>
    service.save_page(
      { requestId: randomUUID(), title, type: "project", body: "Project page.\n", ...extra },
      owner,
    );
  const remember = (items: any, extra = {}) =>
    service.remember(
      {
        requestId: randomUUID(),
        attribution: "user in test session, 2026-10-19",
        excerpt: "User: we picked option B because it ships sooner.\nUser: I prefer short replies.",
        items,
        ...extra,
      },
      owner,
    );
  return { service, owner, page, remember };
}

it("remember links a claim to a uniquely matching page and cites the retained excerpt", async () => {
  const f = await fixture();
  const project = await f.page("Garden Pilot", { aliases: ["pilot"] });
  const out = await f.remember([
    { text: "Picked option B because it ships sooner.", kind: "decision", subject: "pilot" },
  ]);
  expect(Check(contract.operations.remember.output, out)).toBeTruthy();
  expect(out.receipt!.state).toBe("published");
  expect(out.items.map((i) => [i.status, i.subject, i.subjectId])).toStrictEqual([
    ["inserted", "attached", project.id],
  ]);
  const read = await f.service.record(
    { id: out.items[0]!.id, includeMetadata: true, includeEvidence: true },
    f.owner,
  );
  expect(read.record!.metadata!.entities).toStrictEqual([project.id]);
  expect(read.record!.metadata!.claim_kind).toBe("decision");
  expect(read.record!.metadata!.assertion_origin).toBe("source");
  expect(read.evidence![0]!.verified).toBe(true);
  const claims = await f.service.connections({ id: project.id, direction: "claims" }, f.owner);
  expect(claims.connections[0]!.record.id).toBe(out.items[0]!.id);
});

it("exact repeats return the saved claim instead of writing again", async () => {
  const f = await fixture();
  await f.page("Garden Pilot");
  const first = await f.remember([
    { text: "Prefers short replies.", kind: "preference", subject: "Garden Pilot" },
  ]);
  const again = await f.remember([
    { text: "  prefers SHORT   replies. ", kind: "preference", subject: "garden pilot" },
    { text: "Ships Friday.", kind: "commitment" },
    { text: "ships friday.", kind: "commitment" },
  ]);
  expect(again.items.map((i) => i.status)).toStrictEqual(["duplicate", "inserted", "duplicate"]);
  expect(again.items[0]!.id).toBe(first.items[0]!.id);
  expect(again.items[2]!.id).toBe(again.items[1]!.id);
  expect((await f.service.records({ kind: "claim" }, f.owner)).total).toBe(2);
  const none = await f.remember([
    { text: "Prefers short replies.", kind: "preference", subject: "Garden Pilot" },
  ]);
  expect(none.receipt).toBe(null);
  expect(none.items[0]!.status).toBe("duplicate");
});

it("unmatched and ambiguous subjects save unlinked, report candidates and create no page", async () => {
  const f = await fixture();
  const a = await f.page("Atlas"),
    b = await f.page("Atlas", { type: "person" });
  const pages = (await f.service.records({ kind: "page" }, f.owner)).total;
  const out = await f.remember([
    { text: "Atlas launched.", kind: "event", subject: "Atlas", occurred_at: "2026-10-18" },
    { text: "Nimbus is paused.", kind: "fact", subject: "Nimbus" },
  ]);
  expect(out.items[0]!.subject).toBe("ambiguous");
  expect(out.items[0]!.candidates!.map((c) => c.id).toSorted(defaultOrder)).toStrictEqual(
    [a.id, b.id].toSorted(defaultOrder),
  );
  expect(out.items[1]!.subject).toBe("missing");
  expect((await f.service.records({ kind: "page" }, f.owner)).total).toBe(pages);
  const unlinked = (
    await f.service.record({ id: out.items[1]!.id, includeMetadata: true }, f.owner)
  ).record!.metadata;
  expect(unlinked!.entities).toBe(undefined);
  expect(out.message).toMatch(/2 unlinked/);
  expect(
    (await f.service.record({ id: out.items[0]!.id, includeMetadata: true }, f.owner)).record!
      .metadata!.occurred_at,
  ).toBe("2026-10-18");
});

it("a replayed request returns its original result; a changed payload is rejected", async () => {
  const f = await fixture();
  const requestId = randomUUID(),
    items = [{ text: "Uses link-only placement.", kind: "decision" }];
  const first = await f.remember(items, { requestId });
  const replay = await f.remember(items, { requestId });
  expect(replay.items).toStrictEqual(first.items);
  expect(replay.receipt!.requestId).toBe(requestId);
  await expect(
    f.remember([{ text: "Something else.", kind: "fact" }], { requestId }),
  ).rejects.toThrow(/different payload/);
});

it("remember rejects agent inference, oversized excerpts and missing request IDs outside a flush", async () => {
  const f = await fixture();
  await expect(
    f.remember([{ text: "Seems tired.", kind: "belief", origin: "agent_inference" }]),
  ).rejects.toThrow();
  await expect(
    f.remember([{ text: "Big.", kind: "fact" }], { excerpt: "x".repeat(17 * 1024) }),
  ).rejects.toThrow();
  await expect(
    f.remember([{ text: "No id.", kind: "fact" }], { requestId: undefined }),
  ).rejects.toThrow(/requires requestId/);
  const flush = { ...f.owner, tool: { ...f.owner.tool, memoryFlush: { flushId: "flush-1" } } };
  const input: RememberInput = {
    attribution: "flush",
    excerpt: "User: keep it.",
    items: [{ text: "Keep it.", kind: "preference" }],
  };
  const saved = await f.service.remember(input, flush),
    retried = await f.service.remember(input, flush);
  expect(saved.items[0]!.status).toBe("inserted");
  expect(retried.items).toStrictEqual(saved.items);
});

it("an omitted subject is inferred only from one named entity page with no competing name", async () => {
  const f = await fixture();
  const pilot = await f.page("Garden Pilot"),
    alice = await f.page("Alice Example", { type: "person" });
  await f.page("Weekly Sync", { type: "meeting" });
  const out = await f.remember([
    { text: "Garden Pilot hired a CFO.", kind: "event" },
    { text: "Decided Garden Pilot uses link-only placement.", kind: "decision" },
    { text: "Met Alice Example for coffee.", kind: "event" },
    { text: "Garden Pilot slipped a week in Weekly Sync.", kind: "event" },
    { text: "Nimbus copied Garden Pilot pricing.", kind: "fact" },
    { text: "Alice prefers mornings.", kind: "preference" },
    { text: "Alice Example and Garden Pilot signed.", kind: "event" },
    { text: "Ships on Friday.", kind: "commitment" },
    { text: "Garden Pilot is paused.", kind: "fact", infer_subject: false },
  ]);
  expect(out.items.map((i) => [i.subject, i.subjectId])).toStrictEqual([
    ["inferred", pilot.id],
    ["inferred", pilot.id],
    ["inferred", alice.id],
    ["inferred", pilot.id],
    ["none", undefined],
    ["none", undefined],
    ["none", undefined],
    ["none", undefined],
    ["none", undefined],
  ]);
  const read = (await f.service.record({ id: out.items[0]!.id, includeMetadata: true }, f.owner))
    .record!.metadata;
  expect(read!.entities).toStrictEqual([pilot.id]);
  expect(
    (await f.service.record({ id: out.items[4]!.id, includeMetadata: true }, f.owner)).record!
      .metadata!.entities,
  ).toBe(undefined);
  expect(out.message).toMatch(/4 linked by inference/);
});

it("keeps a shortened claim title well-formed when the cap lands inside a surrogate pair", async () => {
  const f = await fixture();
  // 198 ASCII units place the emoji pair across the 199-unit shortening cut.
  const text = `${"A".repeat(198)}😀 trailer`;
  const out = await f.remember([{ text, kind: "fact" }]);
  const read = await f.service.record({ id: out.items[0]!.id }, f.owner);
  expect(read.record!.title).toBe(`${"A".repeat(198)}…`);
  expect(read.record!.title.isWellFormed()).toBe(true);
});
