import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FeatureInput } from "openclaw/plugin-sdk/feature-contract";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { contract } from "./contract.js";
import { createKnowledgeService } from "./service.js";
import { defaultOrder, storeFixture, toolContext, useTestTempDirs } from "./test-support.js";

const tempDirs = useTestTempDirs();

// One private vault: a PR page with two status snapshots and the outcome that replaces them.
async function fixture() {
  const { api, root } = await storeFixture(tempDirs.make("knowledge-supersede-"), {
    policy: { writesEnabled: true, operatorRead: true },
  });
  const service = createKnowledgeService(api),
    owner = toolContext(api);
  const call = async <K extends keyof typeof service>(
    op: K,
    input: FeatureInput<typeof contract, K>,
  ): Promise<any> => service[op](input, owner);
  const fingerprint = (await call("ontology", {})).fingerprint;
  const page = (title: string) =>
    call("save_page", { requestId: randomUUID(), title, type: "project", body: `${title}.\n` });
  const source = await call("attach", {
    requestId: randomUUID(),
    filename: "chat.txt",
    mediaType: "text/plain",
    attribution: "Discord #maintainers",
    offset: 0,
    data: Buffer.from("CI is red on the PR.\nCI is green now.\nThe PR merged.").toString("base64"),
    final: true,
  });
  const claim = (body: string, line: number, extra = {}) =>
    call("create_claim", {
      requestId: randomUUID(),
      expectedOntologyFingerprint: fingerprint,
      title: body,
      body,
      claim_kind: "event",
      assertion_origin: "source",
      attribution: "maintainer in #maintainers",
      evidence: [{ ...source.evidence, start_line: line, end_line: line }],
      ...extra,
    });
  const record = async (id: string) => (await call("record", { id, metadataView: "full" })).record;
  const fence = async (id: string) => {
    const r = await record(id);
    return { id, expectedRevision: r.revision, expectedHash: r.hash };
  };
  const supersede = async (by: string, superseded: string[], extra = {}) =>
    call("supersede", {
      requestId: randomUUID(),
      reason: "The merge outcome replaces the CI snapshots.",
      by: await fence(by),
      superseded: await Promise.all(superseded.map(fence)),
      ...extra,
    });
  const pr = await page("PR 4242");
  const red = await claim("CI is red on PR 4242.", 1, { entities: [pr.id] });
  const green = await claim("CI is green on PR 4242.", 2, { entities: [pr.id] });
  const merged = await claim("PR 4242 merged.", 3, { entities: [pr.id] });
  const prClaims = async (historical = false) =>
    (await call("connections", { id: pr.id, direction: "claims", historical })).connections
      .map((c: any) => c.record.id)
      .toSorted(defaultOrder);
  return { root, call, page, claim, record, fence, supersede, pr, red, green, merged, prClaims };
}

it("supersedes snapshots by an existing outcome without copying it, and undo restores them", async () => {
  const f = await fixture();
  const before = await f.record(f.red.id);
  const receipt = await f.supersede(f.merged.id, [f.red.id, f.green.id]);
  expect(Check(contract.operations.supersede.output, receipt)).toBeTruthy();
  expect(receipt).toMatchObject({
    state: "published",
    operation: "supersede",
    targetId: f.red.id,
    replacementId: f.merged.id,
    items: [
      { key: "superseded", id: f.red.id, revision: 2 },
      { key: "superseded", id: f.green.id, revision: 2 },
    ],
  });
  const red = await f.record(f.red.id);
  expect(red).toMatchObject({
    lifecycle: "superseded",
    body: before.body,
    metadata: {
      superseded_by: f.merged.id,
      evidence: before.metadata.evidence,
      attribution: before.metadata.attribution,
      lifecycle_change: { reason: "The merge outcome replaces the CI snapshots.", actor: "agent" },
    },
  });
  expect((await f.record(f.merged.id)).revision, "the outcome is not rewritten").toBe(1);
  expect(
    (await f.call("records", { kind: "claim", lifecycle: "all" })).total,
    "no replacement copy is written",
  ).toBe(3);
  expect(await f.prClaims(), "default reads exclude superseded claims").toStrictEqual([
    f.merged.id,
  ]);
  expect(await f.prClaims(true)).toStrictEqual(
    [f.red.id, f.green.id, f.merged.id].toSorted(defaultOrder),
  );
  expect((await f.call("history", { id: f.red.id })).entries).toHaveLength(2);

  const undo = await f.call("supersede", {
    requestId: randomUUID(),
    reason: "The PR was reverted; the snapshots are current history again.",
    by: await f.fence(f.merged.id),
    superseded: receipt.items.map((i: any) => ({
      id: i.id,
      expectedRevision: i.revision,
      expectedHash: i.hash,
    })),
    undo: true,
  });
  expect(undo).toMatchObject({ state: "published", operation: "unsupersede" });
  // A fresh scan applies durable lifecycle guards; the restore lifted the supersession guards.
  const restored = await f.record(f.red.id);
  expect(restored.lifecycle).toBe("active");
  expect(restored.metadata.superseded_by).toBe(undefined);
  expect(await f.prClaims()).toStrictEqual(
    [f.red.id, f.green.id, f.merged.id].toSorted(defaultOrder),
  );
  expect((await f.call("history", { id: f.red.id })).entries).toHaveLength(3);
});

it("a stale active file cannot revive a superseded claim", async () => {
  const f = await fixture();
  const original = await readFile(
    path.join(f.root, "private", (await f.record(f.red.id)).path),
    "utf8",
  );
  await f.supersede(f.merged.id, [f.red.id]);
  await writeFile(path.join(f.root, "private", (await f.record(f.red.id)).path), original);
  expect((await f.record(f.red.id)).lifecycle).toBe("superseded");
  expect(await f.prClaims()).toStrictEqual([f.green.id, f.merged.id].toSorted(defaultOrder));
});

it("rejects self-supersession, cycles, other subjects, non-claims, stale fences and correction undo", async () => {
  const f = await fixture();
  const rejects = (promise: Promise<unknown>, message: RegExp) =>
    expect(promise).rejects.toThrow(message);
  await rejects(f.supersede(f.merged.id, [f.merged.id]), /cannot supersede itself/);
  await rejects(f.supersede(f.merged.id, [f.red.id, f.red.id]), /listed once/);
  const other = await f.page("Unrelated project");
  const elsewhere = await f.claim("CI is red on another PR.", 1, { entities: [other.id] });
  await rejects(f.supersede(f.merged.id, [elsewhere.id]), /shares no linked page/);
  const unlinked = await f.claim("CI is red somewhere.", 1);
  await rejects(f.supersede(f.merged.id, [unlinked.id]), /shares no linked page/);
  await rejects(f.supersede(f.pr.id, [f.red.id]), /Superseding claim unavailable, not a claim/);
  await rejects(
    f.call("supersede", {
      requestId: randomUUID(),
      reason: "stale",
      by: await f.fence(f.merged.id),
      superseded: [{ ...(await f.fence(f.red.id)), expectedRevision: 9 }],
    }),
    /Superseded claim unavailable/,
  );

  await f.supersede(f.merged.id, [f.red.id]);
  // The reverse edge would form a cycle: the superseded claim is no longer current.
  await rejects(f.supersede(f.red.id, [f.merged.id]), /not current in this scope/);
  await rejects(f.supersede(f.green.id, [f.red.id]), /is superseded, not active/);
  await rejects(f.supersede(f.merged.id, [f.green.id], { undo: true }), /is not superseded by/);
  await f.call("withdraw", {
    requestId: randomUUID(),
    ...(await f.fence(f.green.id)),
    reason: "Wrong PR.",
  });
  const late = await f.claim("PR 4242 merged after review.", 3, { entities: [f.pr.id] });
  await rejects(f.supersede(late.id, [f.green.id]), /is withdrawn, not active/);

  // A correction's replacement is a new version of the original; undo goes through correct.
  const corrected = await f.call("correct", {
    requestId: randomUUID(),
    expectedOntologyFingerprint: (await f.call("ontology", {})).fingerprint,
    ...(await f.fence(late.id)),
    reason: "Date was missing.",
    replacement: {
      kind: "claim",
      title: "PR 4242 merged on Friday.",
      body: "PR 4242 merged on Friday.",
      claim_kind: "event",
      assertion_origin: "source",
      attribution: "maintainer in #maintainers",
      evidence: (await f.record(late.id)).metadata.evidence,
      entities: [f.pr.id],
    },
  });
  await rejects(
    f.supersede(corrected.replacementId, [late.id], { undo: true }),
    /replaced by knowledge_correct/,
  );
});
