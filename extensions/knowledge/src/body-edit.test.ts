import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { editBody } from "./body-edit.js";
import { capacityFixture } from "./capacity-test-support.js";
import type { Envelope } from "./model.js";
import { createKnowledgeService } from "./service.js";
import { operations } from "./storage-host.js";
import { KnowledgeStorage } from "./storage.js";
import {
  plainAccess,
  hostApi,
  adopt,
  toolContext,
  operatorContext,
  afterTest,
  useTestTempDirs,
} from "./test-support.js";

const tempDirs = useTestTempDirs();
// The open envelope schema does not model the body_change record that body edits add.
type BodyChanged = Envelope & { body_change: { reason: string } };

/** Fresh complete fences for one synthetic active-page edit. */
async function input(f: any, overrides = {}) {
  const current = await f.record(),
    data = await f.scan();
  return {
    requestId: randomUUID(),
    id: current.id,
    expectedVaultId: f.config.vaultId,
    expectedRevision: current.revision,
    expectedHash: current.hash,
    expectedOntologyFingerprint: data.ontology.fingerprint,
    start: 0,
    end: 0,
    replacement: "Added paragraph.\n",
    reason: "Fixture body edit",
    ...overrides,
  };
}

it("bounded edits grow a page beyond input size, preserve metadata/evidence and replay exactly", async () => {
  const f = await capacityFixture(tempDirs),
    before = await f.record();
  // Unknown YAML/comments and existing evidence remain intact through the normal writer.
  await writeFile(
    f.file,
    before!.raw.replace("revision:", "# authored comment\ncustom: preserve-me\nrevision:"),
  );
  const baseline = await f.record(),
    request = await input(f, { replacement: "b".repeat(48000) });
  const saved = await f.storage.editBody(request, f.access);
  expect(saved.state).toBe("published");
  const after = await f.record();
  expect(after!.body).toBe(request.replacement + baseline!.body);
  expect(after!.revision).toBe(baseline!.revision + 1);
  expect(after!.raw).toMatch(/# authored comment/);
  expect(after!.raw).toMatch(/custom: preserve-me/);
  expect(after!.metadata.evidence).toStrictEqual(baseline!.metadata.evidence);
  expect((after!.metadata as BodyChanged).body_change.reason).toBe(request.reason);
  expect(await f.storage.editBody(request, f.access)).toStrictEqual(saved);
  await expect(
    f.storage.editBody({ ...request, replacement: "different" }, f.access),
  ).rejects.toThrow(/request|payload|intent/i);
  const tail = await input(f, {
    start: after!.body.length,
    end: after!.body.length,
    replacement: "tail",
  });
  await f.storage.editBody(tail, f.access);
  expect((await f.record())!.body).toBe(after!.body + "tail");
  const deletion = await input(f, { start: 0, end: 48000, replacement: "" });
  await f.storage.editBody(deletion, f.access);
  expect((await f.record())!.body).toBe(baseline!.body + "tail");
});

it("all fences, range, request budget, authority and byte overflow fail before acceptance", async () => {
  const f = await capacityFixture(tempDirs, 4999000),
    request = await input(f);
  const before = await readFile(f.file, "utf8");
  for (const change of [
    { expectedVaultId: randomUUID() },
    { expectedRevision: request.expectedRevision + 1 },
    { expectedHash: "0".repeat(64) },
    { expectedOntologyFingerprint: "0".repeat(64) },
    { end: 9000000 },
    { start: 3, end: 2 },
    { replacement: "x".repeat(48001) },
    { replacement: "\u0000".repeat(48000) },
    { replacement: "é".repeat(1000) },
  ]) {
    await expect(
      f.storage.editBody({ ...request, requestId: randomUUID(), ...change }, f.access),
    ).rejects.toThrow();
  }
  await expect(
    f.storage.editBody(
      request,
      plainAccess({ visibility: "conversation", sessionId: "other-session" }),
    ),
  ).rejects.toThrow(/unavailable|scope|partition|exist/i);
  await expect(
    f.storage.editBody(request, {
      ...f.access,
      assertCurrent() {
        throw new Error("revoked");
      },
    }),
  ).rejects.toThrow(/revoked/);
  expect(await readFile(f.file, "utf8")).toBe(before);
  expect(f.storage.mutation(f.access, request.requestId).receipt).toBe(null);
});

it("interrupted large edits replay once; external changes before acceptance are never overwritten", async () => {
  const f = await capacityFixture(tempDirs),
    request = await input(f),
    before = await f.record();
  let cut = false;
  const interrupted = new KnowledgeStorage(f.config, f.db, (stage) => {
    if (stage === "after-accept" && !cut) {
      cut = true;
      throw new Error("interrupted");
    }
  });
  await expect(interrupted.editBody(request, f.access)).rejects.toThrow(/interrupted/);
  const resumed = await new KnowledgeStorage(f.config, f.db).editBody(request, f.access);
  expect(resumed.revision).toBe(before!.revision + 1);
  expect(resumed.state).toBe("published");
  expect((await f.record())!.body).toBe(request.replacement + before!.body);
  const next = await input(f),
    raw = await readFile(f.file, "utf8");
  const concurrent = new KnowledgeStorage(f.config, f.db, (stage) => {
    if (stage === "before-accept") {
      writeFileSync(f.file, raw + "external");
    }
  });
  await expect(concurrent.editBody(next, f.access)).rejects.toThrow(/conflict/);
  expect(await readFile(f.file, "utf8")).toBe(raw + "external");
});

it("service operation is agent-only and worker reads remain bounded for large single lines", async () => {
  const f = await capacityFixture(tempDirs, 400000),
    host = hostApi(f.base, { policy: { writesEnabled: true, operatorRead: true } });
  adopt(host.stateRoot, "agent:main", f.config);
  const lifecycles: any = [];
  host.api.registerService = (s) => lifecycles.push(s);
  const service = createKnowledgeService(host.api);
  afterTest(async () => {
    for (const s of lifecycles) {
      await s.stop();
    }
  });
  const request = await input(f);
  await expect(service.edit_body(request, operatorContext(host.api))).rejects.toThrow(/chat|agent/);
  expect((await service.edit_body(request, toolContext(host.api))).state).toBe("published");
  const current = await f.record();
  await writeFile(f.file, current!.raw.slice(0, -current!.body.length) + "x".repeat(400000));
  await expect(
    operations.memoryGet(f.storage, f.access, { id: request.id, from: 3, count: 100 }),
  ).rejects.toThrow(/transport budget/);
});

it("range edits reject surrogate splits and lone surrogates, retaining complete emoji", () => {
  expect(editBody("a😀b", { start: 1, end: 3, replacement: "é" })).toBe("aéb");
  expect(() => editBody("a😀b", { start: 2, end: 3, replacement: "" })).toThrow(/Unicode/);
  expect(() => editBody("abc", { start: 0, end: 0, replacement: "\ud800" })).toThrow(/Unicode/);
});
