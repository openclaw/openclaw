import { randomUUID } from "node:crypto";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { contract } from "./contract.js";
import type { RememberInput } from "./remember-contract.js";
import { claimPayload } from "./remember.js";
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

it("a replayed request returns its original result; a changed payload is rejected", async () => {
  const f = await fixture();
  const requestId = randomUUID(),
    items = [{ text: "Uses link-only placement.", kind: "decision" }];
  const first = await f.remember(items, { requestId });
  const replay = await f.remember(items, { requestId });
  expect(replay.items).toStrictEqual(first.items);
  expect(replay.receipt!.requestId).toBe(requestId);
  for (const change of [
    { excerpt: "A different supporting excerpt." },
    { attribution: "Another synthetic speaker" },
    { items: [{ ...items[0]!, text: "  USES link-only placement. " }] },
    { items: [{ ...items[0]!, about: "Different context" }] },
    { items: [...items, { text: "Additional claim.", kind: "fact" }] },
  ]) {
    await expect(f.remember(change.items ?? items, { requestId, ...change })).rejects.toThrow(
      /different payload/,
    );
  }
  await expect(
    f.remember([{ text: "Something else.", kind: "fact" }], { requestId }),
  ).rejects.toThrow(/different payload/);
});

it("validates retained original input before resuming an accepted remember", async () => {
  const f = await fixture();
  const input: RememberInput = {
    requestId: randomUUID(),
    attribution: "Synthetic user",
    excerpt: "Prefers short replies.",
    items: [{ text: "Prefers short replies.", kind: "preference" }],
  };
  const storage = new KnowledgeStorage(f.config, undefined, (where) => {
    if (where === "after-accept") {
      throw new Error("interrupted");
    }
  });
  await expect(storage.remember(input, accessFor(f.owner, true), "agent")).rejects.toThrow(
    "interrupted",
  );
  await expect(
    f.service.remember({ ...input, excerpt: "Changed excerpt" }, f.owner),
  ).rejects.toThrow(/different payload/);
  expect(
    (await f.service.mutation({ requestId: input.requestId!, includeFiles: false }, f.owner))
      .receipt!.state,
  ).toBe("accepted");
  const replay = await f.service.remember(input, f.owner);
  expect(replay.receipt!.state).toBe("published");
  expect((await f.service.remember(input, f.owner)).items).toStrictEqual(replay.items);
});

it("keeps same-title assertions with distinct dates and origins in one atomic batch", async () => {
  const f = await fixture();
  const items: RememberInput["items"] = [
    { text: "Ships Friday.", kind: "commitment", occurred_at: "2026-11-01" },
    { text: "Ships Friday.", kind: "commitment", occurred_at: "2026-11-02" },
    { text: "Ships Friday.", kind: "commitment", occurred_at: "2026-11-01T00:00:00Z" },
    { text: "Ships Friday.", kind: "commitment", origin: "user_belief" },
    { text: "Ships Friday.", kind: "commitment" },
    { text: "ships friday.", kind: "commitment", origin: "source" },
  ];
  const saved = await f.remember(items);
  expect(saved.receipt!.state).toBe("published");
  expect(saved.items.map((item) => item.status)).toStrictEqual([
    "inserted",
    "inserted",
    "inserted",
    "inserted",
    "inserted",
    "duplicate",
  ]);
  expect(new Set(saved.items.map((item) => item.id)).size).toBe(5);
  for (let n = 0; n < 5; n++) {
    const metadata = (await f.record(saved.items[n]!.id)).record!.metadata!;
    expect(metadata.occurred_at).toBe(items[n]!.occurred_at);
    expect(metadata.assertion_origin).toBe(items[n]!.origin ?? "source");
  }
  const repeat = await f.remember(items);
  expect(repeat.receipt).toBe(null);
  expect(repeat.items.map((item) => item.id)).toStrictEqual(saved.items.map((item) => item.id));
});

it("replays a legacy collapsed date batch without publishing the suppressed assertion", async () => {
  const f = await fixture();
  const input: RememberInput & { requestId: string } = {
    requestId: randomUUID(),
    attribution: "Synthetic legacy user",
    excerpt: "Ships Friday, first on November 1 then on November 2.",
    items: [
      { text: "Ships Friday.", kind: "commitment", occurred_at: "2026-11-01" },
      { text: "Ships Friday.", kind: "commitment", occurred_at: "2026-11-02" },
    ],
  };
  // Pre-6190ded64e14 remember collapsed equal text/kind/subjects before calling
  // attach + batch. Produce that receipt through the unchanged owners, without
  // editing its intent or inventing an original-input hash.
  const storage = new KnowledgeStorage(f.config);
  const access = accessFor(f.owner, true);
  const upload = await storage.attach(
    {
      requestId: input.requestId,
      expectedVaultId: f.config.vaultId,
      filename: "excerpt.txt",
      mediaType: "text/plain",
      attribution: input.attribution,
      offset: 0,
      data: Buffer.from(input.excerpt).toString("base64"),
      final: true,
    },
    access,
  );
  const vaultStatus = await f.service.status({}, f.owner);
  const receipt = await storage.batch(
    {
      requestId: input.requestId,
      expectedVaultId: f.config.vaultId,
      expectedOntologyFingerprint: vaultStatus.ontologyFingerprint,
      items: [
        {
          key: "i0",
          kind: "claim",
          input: claimPayload(
            input.items[0]!,
            { subject: "none" },
            {
              ...upload.evidence!,
              start_line: 1,
              end_line: 1,
            },
            input.attribution,
          ),
        },
      ],
    },
    access,
    "agent",
  );
  const restarted = createKnowledgeService(f.api);
  const replay = await restarted.remember(input, f.owner);
  expect(replay.receipt).toStrictEqual(receipt);
  expect(replay.items.map(({ status, id }) => [status, id])).toStrictEqual([
    ["inserted", receipt.items![0]!.id],
    ["duplicate", receipt.items![0]!.id],
  ]);
  expect((await restarted.records({ kind: "claim" }, f.owner)).total).toBe(1);
  expect((await f.record(receipt.items![0]!.id)).record!.metadata!.occurred_at).toBe("2026-11-01");
  await expect(
    restarted.remember(
      {
        ...input,
        items: [...input.items, { text: "Unrelated new claim.", kind: "fact" }],
      },
      f.owner,
    ),
  ).rejects.toThrow(/different payload/);
  const fresh = await restarted.remember({ ...input, requestId: randomUUID() }, f.owner);
  expect(fresh.items.map((item) => item.status)).toStrictEqual(["duplicate", "inserted"]);
  expect((await restarted.records({ kind: "claim" }, f.owner)).total).toBe(2);
  expect((await restarted.remember(input, f.owner)).items).toStrictEqual(replay.items);
});

it("remember preserves different assertion dates and origins within calls and against saved claims", async () => {
  const f = await fixture();
  const pairs: [
    string,
    Partial<RememberInput["items"][number]>,
    Partial<RememberInput["items"][number]>,
  ][] = [
    ["occurrence", { occurred_at: "2026-11-01" }, { occurred_at: "2026-11-02" }],
    ["due", { due_at: "2026-11-02" }, { due_at: "2026-11-04T09:00:00+11:00" }],
    ["validity", { valid_from: "2020-01-01T00:00:00Z" }, { valid_from: "2021-01-01T00:00:00Z" }],
    ["expiry", { expires_at: "2098-01-01T00:00:00Z" }, { expires_at: "2099-01-01T00:00:00Z" }],
    ["origin", { origin: "source" }, { origin: "user_belief" }],
    ["precision", { occurred_at: "2026-11-01" }, { occurred_at: "2026-11-01T00:00:00Z" }],
    ["unknown occurrence", {}, { occurred_at: "2026-11-01" }],
    ["unknown due", {}, { due_at: "2026-11-02" }],
  ];
  const items: RememberInput["items"] = pairs.flatMap(([name, left, right]) =>
    [left, right].map((fields) =>
      Object.assign({ text: "Historical " + name + ".", kind: "commitment" as const }, fields),
    ),
  );
  items.push(
    { text: "Default source origin.", kind: "fact" },
    { text: "default SOURCE origin.", kind: "fact", origin: "source" },
  );
  const saved = await f.remember(items);
  for (let n = 0; n < pairs.length * 2; n++) {
    expect(saved.items[n]!.status).toBe("inserted");
    const metadata = (
      await f.service.record({ id: saved.items[n]!.id, includeMetadata: true }, f.owner)
    ).record!.metadata!;
    const { origin, ...dates } = items[n]!;
    for (const field of ["occurred_at", "due_at", "valid_from", "expires_at"] as const) {
      expect(metadata[field]).toBe(dates[field]);
    }
    expect(metadata.assertion_origin).toBe(origin ?? "source");
    if (n % 2 === 1) {
      expect(saved.items[n]!.id).not.toBe(saved.items[n - 1]!.id);
    }
  }
  expect(saved.items.at(-1)!.status).toBe("duplicate");
  expect(saved.items.at(-1)!.id).toBe(saved.items.at(-2)!.id);
  const repeated = await f.remember(items);
  expect(repeated.receipt).toBe(null);
  expect(repeated.items.map((i) => i.status)).toStrictEqual(items.map(() => "duplicate"));
  expect(repeated.items.map((i) => i.id)).toStrictEqual(saved.items.map((i) => i.id));
});
