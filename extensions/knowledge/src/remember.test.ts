import { randomUUID } from "node:crypto";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { contract } from "./contract.js";
import type { RememberInput } from "./remember-contract.js";
import { createKnowledgeService } from "./service.js";
import { KnowledgeStorage } from "./storage.js";
import {
  accessFor,
  defaultOrder,
  storeFixture,
  toolContext,
  useTestTempDirs,
} from "./test-support.js";

const tempDirs = useTestTempDirs();

async function fixture() {
  const f = await storeFixture(tempDirs.make("knowledge-remember-"), {
    policy: { writesEnabled: true, operatorRead: true },
  });
  const service = createKnowledgeService(f.api),
    owner = toolContext(f.api);
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
  const record = (id: string) =>
    service.record({ id, includeMetadata: true, includeEvidence: true }, owner);
  return { ...f, service, owner, page, remember, record };
}

it("remember links a claim to a uniquely matching page and cites the retained excerpt", async () => {
  const f = await fixture();
  const project = await f.page("Garden Pilot", { aliases: ["pilot"] });
  const text = `${"A".repeat(198)}😀 trailer`;
  const out = await f.remember([{ text, kind: "decision", subject: "pilot" }], { excerpt: text });
  expect(Check(contract.operations.remember.output, out)).toBeTruthy();
  expect(out.receipt!.state).toBe("published");
  expect(out.items.map((i) => [i.status, i.subject, i.subjectId])).toStrictEqual([
    ["inserted", "attached", project.id],
  ]);
  const read = await f.record(out.items[0]!.id);
  expect(read.record!.title).toBe(`${"A".repeat(198)}…`);
  expect(read.record!.metadata!.entities).toStrictEqual([project.id]);
  expect(read.record!.metadata!.claim_kind).toBe("decision");
  expect(read.record!.metadata!.assertion_origin).toBe("source");
  expect(read.evidence![0]!.verified).toBe(true);
  const claims = await f.service.connections({ id: project.id, direction: "claims" }, f.owner);
  expect(claims.connections[0]!.record.id).toBe(out.items[0]!.id);
});

it("remember replays an accepted request once and rejects changed payloads", async () => {
  const f = await fixture();
  await f.page("Garden Pilot");
  const requestId = randomUUID();
  const items: RememberInput["items"] = [
    { text: "Prefers short replies.", kind: "preference", subject: "Garden Pilot" },
  ];
  const storage = new KnowledgeStorage(f.config, undefined, (where) => {
    if (where === "after-accept") {
      throw new Error("interrupted");
    }
  });
  const input: RememberInput = {
    requestId,
    attribution: "Synthetic user",
    excerpt: "I prefer short replies.",
    items,
  };
  await expect(storage.remember(input, accessFor(f.owner, true), "agent")).rejects.toThrow(
    "interrupted",
  );
  const before = (await f.service.mutation({ requestId, includeFiles: false }, f.owner)).receipt!;
  expect(before.state).toBe("accepted");
  const changed = () => f.remember([{ text: "Changed.", kind: "fact" }], { requestId });
  await expect(changed()).rejects.toThrow();
  expect(
    (await f.service.mutation({ requestId, includeFiles: false }, f.owner)).receipt,
  ).toStrictEqual(before);
  const replay = await createKnowledgeService(f.api).remember(input, f.owner);
  expect(replay.receipt!.state).toBe("published");
  expect(replay.receipt!.requestId).toBe(requestId);
  const { evidence } = await f.record(replay.items[0]!.id);
  expect(evidence!.map((e) => e.verified)).toStrictEqual([true]);
  expect((await f.service.remember(input, f.owner)).items).toStrictEqual(replay.items);
  await expect(changed()).rejects.toThrow(/different payload/);
  const again = await f.remember([
    { text: "  prefers SHORT   replies. ", kind: "preference", subject: "garden pilot" },
    { text: "Ships Friday.", kind: "commitment" },
    { text: "ships friday.", kind: "commitment" },
  ]);
  expect(again.items.map((i) => i.status)).toStrictEqual(["duplicate", "inserted", "duplicate"]);
  expect(again.items[0]!.id).toBe(replay.items[0]!.id);
  expect(again.items[2]!.id).toBe(again.items[1]!.id);
  expect((await f.service.records({ kind: "claim" }, f.owner)).total).toBe(2);
  const none = await f.remember(items);
  expect(none.receipt).toBe(null);
  expect(none.items[0]!.status).toBe("duplicate");
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

it("named and omitted subjects never guess competing names or create pages", async () => {
  const f = await fixture();
  const pilot = await f.page("Garden Pilot"),
    alice = await f.page("Alice Example", { type: "person" });
  await f.page("Weekly Sync", { type: "meeting" });
  const a = await f.page("Atlas"),
    b = await f.page("Atlas", { type: "person" });
  const pages = (await f.service.records({ kind: "page" }, f.owner)).total;
  const out = await f.remember([
    { text: "Atlas launched.", kind: "event", subject: "Atlas", occurred_at: "2026-10-18" },
    { text: "Nimbus is paused.", kind: "fact", subject: "Nimbus" },
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
    ["ambiguous", undefined],
    ["missing", undefined],
    ["inferred", pilot.id],
    ["inferred", pilot.id],
    ["inferred", alice.id],
    ["inferred", pilot.id],
    ...Array.from({ length: 5 }, () => ["none", undefined]),
  ]);
  expect(out.items[0]!.candidates!.map((c) => c.id).toSorted(defaultOrder)).toStrictEqual(
    [a.id, b.id].toSorted(defaultOrder),
  );
  expect((await f.service.records({ kind: "page" }, f.owner)).total).toBe(pages);
  expect((await f.record(out.items[1]!.id)).record!.metadata!.entities).toBe(undefined);
  expect((await f.record(out.items[0]!.id)).record!.metadata!.occurred_at).toBe("2026-10-18");
  expect(out.message).toMatch(/2 unlinked/);
  const read = (await f.record(out.items[2]!.id)).record!.metadata;
  expect(read!.entities).toStrictEqual([pilot.id]);
  expect((await f.record(out.items[6]!.id)).record!.metadata!.entities).toBe(undefined);
  expect(out.message).toMatch(/4 linked by inference/);
});
