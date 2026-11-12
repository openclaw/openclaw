// Result evidence is optional: it never gates completion or dependency scheduling.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { syncWorkboardSubagentEnded } from "./lifecycle-sync.js";
import { workboardSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { WorkboardStore } from "./store.js";
import { createWorkboardSqliteStores } from "./test/database-config.js";
import { createWorkboardSqliteTestStore, sqliteTestAuxStores } from "./test/sqlite-store.js";

const workerModuleUrl = resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint);
const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function openPersistentStore(dbPath: string) {
  const stores = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
  return { store: new WorkboardStore(stores.cards, sqliteTestAuxStores(stores)), stores };
}

describe("Workboard result evidence", () => {
  it("completes cards with or without evidence and leaves dependents unaffected", async () => {
    const store = createWorkboardSqliteTestStore();
    const recorded = await store.create({ title: "With evidence", agentId: "worker" });
    const plain = await store.create({ title: "Without evidence", agentId: "worker" });
    const child = await store.create({ title: "Child", parents: [recorded.id, plain.id] });

    const { token } = await store.claim(recorded.id, { ownerId: "worker" });
    const proofCard = await store.addProof(
      recorded.id,
      { status: "passed", command: "pnpm test" },
      { ownerId: "worker", token },
    );
    const proofId = proofCard.metadata!.proof!.at(-1)!.id;
    const done = await store.complete(
      recorded.id,
      { summary: "Fixed.", claims: [{ statement: "Tests pass.", proofId }] },
      { ownerId: "worker", token },
    );
    await store.claim(plain.id, { ownerId: "worker" });
    const plainDone = await store.complete(plain.id, { summary: "Fixed." }, { ownerId: "worker" });

    expect(done.status).toBe("done");
    expect(done.metadata?.proof?.at(-1)).toMatchObject({ id: proofId, status: "passed" });
    const claim = done.metadata?.automation?.evidence?.[0];
    expect(claim).toMatchObject({ kind: "claim", claimedBy: "worker", statement: "Tests pass." });
    expect(plainDone.status).toBe("done");
    expect(plainDone.metadata?.automation?.evidence).toBeUndefined();

    // A disputing check is recorded, but "done" and dependency scheduling stay as they were.
    const self = await store.verify(
      recorded.id,
      { scope: "Reran pnpm test.", outcome: "confirmed", claimId: claim!.id },
      { ownerId: "worker" },
    );
    const other = await store.verify(
      recorded.id,
      { scope: "Read the diff against the issue.", outcome: "disputed", proofId },
      { ownerId: "reviewer" },
    );
    expect(self.metadata?.automation?.evidence?.at(-1)).toMatchObject({
      checkerId: "worker",
      checkedOwnWork: true,
    });
    expect(other.status).toBe("done");
    expect(other.metadata?.automation?.evidence?.at(-1)).toMatchObject({
      kind: "verification",
      checkerId: "reviewer",
      checkedOwnWork: false,
      outcome: "disputed",
      proofId,
    });
    await expect(store.claim(child.id, { ownerId: "next" })).resolves.toMatchObject({
      card: { status: "running" },
    });
  });

  it("refuses evidence from raw metadata and unverifiable references", async () => {
    const store = createWorkboardSqliteTestStore();
    const forged = [
      {
        kind: "observation",
        id: "forged",
        recordedAt: 1,
        observedAt: 1,
        source: "session-lifecycle",
        outcome: "succeeded",
        sessionKey: "agent:worker:main",
      },
    ];
    const card = await store.create({
      title: "Forged",
      metadata: { automation: { summary: "x", evidence: forged } },
    });
    expect(card.metadata?.automation?.evidence).toBeUndefined();
    const updated = await store.update(card.id, { metadata: { automation: { evidence: forged } } });
    expect(updated.metadata?.automation?.evidence).toBeUndefined();

    await expect(
      store.verify(
        card.id,
        { scope: "Looked.", outcome: "confirmed", proofId: "missing" },
        {
          ownerId: "reviewer",
        },
      ),
    ).rejects.toThrow("proof not found on card: missing");
    await expect(
      store.verify(
        card.id,
        { scope: "Looked.", outcome: "confirmed", url: "javascript:x" },
        {
          ownerId: "reviewer",
        },
      ),
    ).rejects.toThrow("http");
  });

  it("keeps large evidence from crowding out proof the next completion needs", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Many checks" });
    const firstProof = await store.addProof(card.id, { status: "passed", command: "first" });
    // Character caps allow about 3.4 KB per check in UTF-8; eight exceed the 24 KiB card budget.
    const wide = "検".repeat(300);
    const url = `https://example.test/${"検".repeat(470)}`;
    for (let index = 0; index < 10; index += 1) {
      await store.verify(
        card.id,
        { scope: wide, note: wide, url, outcome: "inconclusive" },
        {
          ownerId: `reviewer-${index}`,
        },
      );
    }
    await store.claim(card.id, { ownerId: "worker" });
    const done = await store.complete(
      card.id,
      { summary: "Done.", proof: { status: "passed", command: "final" } },
      { ownerId: "worker" },
    );
    expect(done.status).toBe("done");
    expect(done.metadata?.proof?.map((proof) => proof.command)).toEqual(["first", "final"]);
    expect(done.metadata?.proof?.[0]?.id).toBe(firstProof.metadata?.proof?.[0]?.id);
    expect(done.metadata?.automation?.evidence?.at(-1)).toMatchObject({ checkerId: "reviewer-9" });
  });

  it("records the session lifecycle outcome once and keeps evidence across reopen", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workboard-evidence-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "workboard.sqlite");
    const sessionKey = "agent:worker:subagent:evidence";
    {
      const { store, stores } = openPersistentStore(dbPath);
      const card = await store.create({
        title: "Linked",
        agentId: "worker",
        sessionKey,
        runId: "run-1",
      });
      await store.claim(card.id, { ownerId: "worker" });
      await store.complete(
        card.id,
        { summary: "Done.", claims: [{ statement: "Shipped." }] },
        { ownerId: "worker" },
      );
      const event = {
        targetSessionKey: sessionKey,
        runId: "run-1",
        endedAt: Date.now() + 1000,
        outcome: "ok" as const,
      };
      await syncWorkboardSubagentEnded({ store, event });
      await syncWorkboardSubagentEnded({ store, event });
      // Later metadata writes renormalize automation and must keep store-owned evidence.
      await store.addComment(card.id, { body: "Follow-up note." });
      stores.close();
    }
    const { store, stores } = openPersistentStore(dbPath);
    const [reopened] = await store.list();
    expect(reopened?.status).toBe("done");
    expect(reopened?.metadata?.automation?.evidence).toEqual([
      expect.objectContaining({ kind: "claim", runId: "run-1" }),
      expect.objectContaining({
        kind: "observation",
        source: "session-lifecycle",
        outcome: "succeeded",
        sessionKey,
        runId: "run-1",
      }),
    ]);
    stores.close();
  });
});
