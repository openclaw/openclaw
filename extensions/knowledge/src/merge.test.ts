import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { FeatureInput } from "openclaw/plugin-sdk/feature-contract";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { contract } from "./contract.js";
import { createKnowledgeService } from "./service.js";
import { apiFor, useTestTempDirs, defaultOrder } from "./test-support.js";

const tempDirs = useTestTempDirs();

// One private vault with two person pages that turn out to be one person.
async function fixture() {
  const base = tempDirs.make("knowledge-merge-");

  const root = path.join(base, "vault");
  await mkdir(path.join(root, "private"), { recursive: true });
  const manifest = {
    format: "knowledge-vault-v2",
    vaultId: randomUUID(),
    generation: 0,
    publicationId: randomUUID(),
  };
  await writeFile(path.join(root, "vault.json"), JSON.stringify(manifest));
  const config = {
    root,
    statePath: path.join(base, "state.sqlite"),
    vaultId: manifest.vaultId,
    publicationId: manifest.publicationId,
    operatorRead: true,
    writesEnabled: true,
  };
  const api = apiFor(base, config),
    service = createKnowledgeService(api);
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
  const call = async <K extends keyof typeof service>(
    op: K,
    input: FeatureInput<typeof contract, K>,
  ) => service[op](input, owner);
  const fingerprint = (await call("ontology", {})).fingerprint;
  const page = (title: any, extra = {}) =>
    call("save_page", {
      requestId: randomUUID(),
      title,
      type: "person",
      body: `${title} notes.\n`,
      ...extra,
    });
  const source = await call("attach", {
    requestId: randomUUID(),
    filename: "chat.txt",
    mediaType: "text/plain",
    attribution: "Discord #maintainers",
    offset: 0,
    data: Buffer.from("jacob: I will review the PR by Friday.\nshakker: I am Gideon.").toString(
      "base64",
    ),
    final: true,
  });
  const evidence = {
    ...source.evidence!,
    start_line: 1,
    end_line: 1,
    quote: "I will review the PR by Friday.",
  };
  const claim = (extra = {}) =>
    call("create_claim", {
      requestId: randomUUID(),
      expectedOntologyFingerprint: fingerprint,
      title: "Review commitment",
      body: "Jacob will review the PR by Friday.",
      claim_kind: "commitment",
      assertion_origin: "source",
      attribution: "jacob in #maintainers",
      evidence: [evidence],
      occurred_at: "2026-10-05",
      ...extra,
    });
  const record = (id: any) => call("record", { id, metadataView: "full" });
  const fence = async (id: any) => {
    const r = (await record(id)).record!;
    return { id, expectedRevision: r.revision, expectedHash: r.hash };
  };
  return { root, call, page, claim, record, fence, evidence, source, fingerprint };
}

async function merged() {
  const f: any = await fixture();
  f.survivor = await f.page("Jacob Tomlinson", {
    aliases: ["discord:111"],
    fields: {},
    tags: ["maintainer"],
  });
  f.absorbed = await f.page("Jacob (standup participant)", {
    aliases: ["jacob-standup", "discord:111"],
    tags: ["standup"],
  });
  f.owned = await f.claim({ owner: f.absorbed.id, entities: [f.absorbed.id] });
  f.linker = await f.page("Standup notes", {
    body: `Attended by [[${f.absorbed.id}]] and [[Jacob (standup participant)]].\n`,
  });
  f.receipt = await f.call("merge", {
    requestId: randomUUID(),
    reason: "Owner confirmed both pages are Jacob Tomlinson.",
    survivor: await f.fence(f.survivor.id),
    absorbed: await f.fence(f.absorbed.id),
  });
  return f;
}

it("a merge publishes both pages once and reports what changed", async () => {
  const f = await merged(),
    r = f.receipt;
  expect(Check(contract.operations.merge.output, r)).toBeTruthy();
  expect(r.state).toBe("published");
  expect(r.operation).toBe("merge");
  expect(r.id).toBe(f.survivor.id);
  expect(r.targetId).toBe(f.absorbed.id);
  expect(r.merge.aliases).toStrictEqual(["Jacob (standup participant)", "jacob-standup"]);
  expect(r.merge.redirectedRecords, "the owned claim named the absorbed page").toBe(1);
  const survivor = (await f.record(f.survivor.id)).record.metadata;
  expect(survivor.aliases).toStrictEqual([
    "discord:111",
    "Jacob (standup participant)",
    "jacob-standup",
  ]);
  expect(survivor.tags).toStrictEqual(["maintainer", "standup"]);
  expect(survivor.merged_from[0].id).toBe(f.absorbed.id);
  const absorbed = await f.record(f.absorbed.id);
  expect(absorbed.record.lifecycle).toBe("merged");
  expect(absorbed.record.metadata.merged_into).toBe(f.survivor.id);
  expect(absorbed.mergedInto.id, "exact reads of the old page say where it went").toBe(
    f.survivor.id,
  );
  expect(absorbed.record.body, "the absorbed body stays readable").toBe(
    "Jacob (standup participant) notes.\n",
  );
  expect((await f.record(f.survivor.id)).mergedFrom.map((p: any) => p.id)).toStrictEqual([
    f.absorbed.id,
  ]);
});

it("reads follow the redirect without rewriting claims", async () => {
  const f = await merged();
  const claim = await f.record(f.owned.id);
  expect(claim.record.metadata.owner, "the authored claim is unchanged").toBe(f.absorbed.id);
  expect(claim.record.owner.id, "but it is shown as the survivor's").toBe(f.survivor.id);
  expect(claim.redirects).toStrictEqual([{ from: f.absorbed.id, to: f.survivor.id }]);
  const lookup = await f.call("lookup", { query: f.absorbed.id });
  expect(lookup.outcome).toBe("found");
  expect(lookup.hits[0].record.id).toBe(f.survivor.id);
  expect(lookup.redirectedFrom).toBe(f.absorbed.id);
  expect((await f.call("lookup", { query: "Jacob (standup participant)" })).hits[0].record.id).toBe(
    f.survivor.id,
  );
  expect(
    (await f.call("lookup", { query: "discord:111" })).outcome,
    "the shared identity key no longer splits",
  ).toBe("found");
  const connections = await f.call("connections", { id: f.survivor.id });
  expect(
    connections.connections.some(
      (c: any) => c.direction === "claims" && c.record.id === f.owned.id,
    ),
  ).toBeTruthy();
  expect(
    connections.connections.some(
      (c: any) => c.direction === "backlinks" && c.record.id === f.linker.id,
    ),
  ).toBeTruthy();
  const stale = await f.call("connections", { id: f.absorbed.id });
  expect(stale.redirectedFrom).toBe(f.absorbed.id);
  expect(stale.total).toBe(connections.total);
  const timeline = await f.call("timeline", { entity: f.survivor.id });
  expect(timeline.items.map((i: any) => i.record.id)).toStrictEqual([f.owned.id]);
  expect(
    (await f.call("timeline", { entity: f.absorbed.id })).items.map((i: any) => i.record.id),
  ).toStrictEqual([f.owned.id]);
  expect(
    (await f.call("records", { kind: "page", query: "standup participant" })).records.map(
      (r: any) => r.id,
    ),
    "the merged page leaves listings",
  ).toStrictEqual([f.survivor.id]);
  expect(
    (await f.call("grep", { query: "standup participant notes" })).hits.some(
      (h: any) => h.record.id === f.absorbed.id,
    ),
    "and search",
  ).toBe(false);
  const links = (await f.record(f.linker.id)).links;
  expect(links.map((l: any) => [l.status, l.id])).toStrictEqual([
    ["resolved", f.survivor.id],
    ["resolved", f.survivor.id],
  ]);
  expect((await f.call("diagnostics", {})).total, "links to a merged page are not broken").toBe(0);
});

it("stale references to a merged page are rejected with the survivor named", async () => {
  const f = await merged();
  await expect(f.claim({ owner: f.absorbed.id })).rejects.toThrow(
    new RegExp(`merged into ${f.survivor.id}`),
  );
  await expect(
    f.call("save_page", {
      requestId: randomUUID(),
      ...(await f.fence(f.absorbed.id)),
      title: "x",
      body: "y",
    }),
  ).rejects.toThrow(/was merged into/);
  await expect(
    f.call("merge", {
      requestId: randomUUID(),
      reason: "again",
      survivor: await f.fence(f.survivor.id),
      absorbed: await f.fence(f.absorbed.id),
    }),
  ).rejects.toThrow(/already merged/);
});

it("merges refuse different types, self merges and stale fences", async () => {
  const f = await fixture();
  const a = await f.page("Colin"),
    b = await f.call("save_page", {
      requestId: randomUUID(),
      title: "Colin project",
      type: "project",
      body: "x\n",
    });
  await expect(
    f.call("merge", {
      requestId: randomUUID(),
      reason: "r",
      survivor: await f.fence(a.id),
      absorbed: await f.fence(b.id),
    }),
  ).rejects.toThrow(/same type/);
  await expect(
    f.call("merge", {
      requestId: randomUUID(),
      reason: "r",
      survivor: await f.fence(a.id),
      absorbed: await f.fence(a.id),
    }),
  ).rejects.toThrow(/into itself/);
  const c = await f.page("Colin B");
  await expect(
    f.call("merge", {
      requestId: randomUUID(),
      reason: "r",
      survivor: await f.fence(a.id),
      absorbed: { ...(await f.fence(c.id)), expectedRevision: 9 },
    }),
  ).rejects.toThrow(/changed/);
});

it("a merge can rename the survivor and replace its body; renamed titles stay resolvable", async () => {
  const f = await fixture();
  const a = await f.page("Shakker"),
    b = await f.page("Gideon Adegbesan", { fields: {} });
  const r = await f.call("merge", {
    requestId: randomUUID(),
    reason: "Self-introduction in #maintainer-whois",
    survivor: await f.fence(a.id),
    absorbed: await f.fence(b.id),
    title: "Gideon Adegbesan",
    body: "Gideon Adegbesan, known as Shakker on Discord.\n",
    evidence: [{ ...f.evidence, start_line: 2, end_line: 2, quote: "I am Gideon." }],
  });
  const page = (await f.record(a.id)).record!;
  expect(page.title).toBe("Gideon Adegbesan");
  expect(page.metadata!.aliases).toStrictEqual(["Shakker"]);
  expect(page.body).toBe("Gideon Adegbesan, known as Shakker on Discord.\n");
  expect(page.metadata!.evidence!.some((e: any) => e.quote === "I am Gideon.")).toBeTruthy();
  expect((await f.call("lookup", { query: "Shakker" })).hits[0]!.record.id).toBe(a.id);
  expect(r.merge!.aliases.length).toBe(1);
});

it("chained merges resolve to the final page", async () => {
  const f = await fixture();
  const a = await f.page("Jacob A"),
    b = await f.page("Jacob B"),
    c = await f.page("Jacob C");
  const owned = await f.claim({ owner: a.id });
  await f.call("merge", {
    requestId: randomUUID(),
    reason: "same",
    survivor: await f.fence(b.id),
    absorbed: await f.fence(a.id),
  });
  await f.call("merge", {
    requestId: randomUUID(),
    reason: "same",
    survivor: await f.fence(c.id),
    absorbed: await f.fence(b.id),
  });
  expect((await f.record(owned.id)).record!.owner!.id).toBe(c.id);
  expect((await f.call("lookup", { query: a.id })).hits[0]!.record.id).toBe(c.id);
  expect(
    (await f.record(c.id)).mergedFrom!.map((p: any) => p.id).toSorted(defaultOrder),
  ).toStrictEqual([a.id, b.id].toSorted(defaultOrder));
});

it("unmerge restores the page and removes exactly what the merge added", async () => {
  const f = await merged();
  const r = await f.call("unmerge", {
    requestId: randomUUID(),
    reason: "Different people after all.",
    merged: await f.fence(f.absorbed.id),
    survivor: await f.fence(f.survivor.id),
  });
  expect(Check(contract.operations.unmerge.output, r)).toBeTruthy();
  expect(r.operation).toBe("unmerge");
  expect(r.merge.redirectedRecords).toBe(1);
  const survivor = (await f.record(f.survivor.id)).record.metadata;
  expect(
    survivor.aliases,
    "the shared identity key the survivor already had is kept",
  ).toStrictEqual(["discord:111"]);
  expect(survivor.tags).toStrictEqual(["maintainer"]);
  expect(survivor.merged_from).toBe(undefined);
  const restored = (await f.record(f.absorbed.id)).record;
  expect(restored.lifecycle).toBe("active");
  expect(restored.metadata.merged_into).toBe(undefined);
  expect((await f.record(f.owned.id)).record.owner.id).toBe(f.absorbed.id);
  const candidates = (await f.call("diagnostics", {})).mergeCandidates;
  expect(
    candidates.map((c: any) => [c.strength, c.key]),
    "the shared identity key is a merge candidate again",
  ).toStrictEqual([["identity-key", "discord:111"]]);
});

it("diagnostics report merge candidates; invalid merge metadata fails closed", async () => {
  const f = await fixture();
  const a = await f.page("Colin", { aliases: ["discord:222"] }),
    b = await f.page("colin"),
    c = await f.page("Colin W", { aliases: ["Discord:222"] });
  const d = await f.call("diagnostics", {});
  expect(Check(contract.operations.diagnostics.output, d)).toBeTruthy();
  expect(
    d.mergeCandidates!.map((g: any) => [
      g.strength,
      g.pages.map((p: any) => p.id).toSorted(defaultOrder),
    ]),
  ).toStrictEqual([
    ["identity-key", [a.id, c.id].toSorted(defaultOrder)],
    ["title", [a.id, b.id].toSorted(defaultOrder)],
  ]);
  // Hand-edited merge metadata that points nowhere: the page is invalid and its dependents stay hidden.
  const owned = await f.claim({ owner: b.id });
  const file = path.join(f.root, "private", (await f.record(b.id)).record!.path);
  await writeFile(
    file,
    (await readFile(file, "utf8")).replace(
      "lifecycle: active",
      "lifecycle: merged\nmerged_into: missing-page-0000",
    ),
  );
  const issues = (await f.call("diagnostics", {})).issues;
  expect(issues.some((i: any) => i.code === "invalid-merge")).toBeTruthy();
  expect((await f.call("lookup", { query: owned.id })).outcome).toBe("missing");
});

it("recurring meetings that share a title are merge candidates only on the same day", async () => {
  const f = await fixture();
  const meeting = (day: any) =>
    f.page("Daily Standup", { type: "meeting", fields: { occurred_at: day } });
  const a = await meeting("2026-10-01T16:00:00Z"),
    b = await meeting("2026-10-01T16:30:00Z");
  await meeting("2026-10-02T16:00:00Z");
  const candidates = (await f.call("diagnostics", {})).mergeCandidates;
  expect(
    candidates!.map((g: any) => [g.key, g.pages.map((p: any) => p.id).toSorted(defaultOrder)]),
  ).toStrictEqual([["Daily Standup", [a.id, b.id].toSorted(defaultOrder)]]);
});
