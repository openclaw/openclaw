import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { writeFile, readFile, rm, rename } from "node:fs/promises";
import path from "node:path";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import type { VaultAccess } from "./access.js";
import { contract } from "./contract.js";
import { SqliteIdentityStore } from "./identity-store.js";
import { createKnowledgeService } from "./service.js";
import { KnowledgeStorage } from "./storage.js";
import {
  accessFor,
  childEvalArgs,
  operatorContext,
  sourceModule,
  storeFixture,
  toolContext,
  type TestAudience,
  useTestTempDirs,
} from "./test-support.js";

const tempDirs = useTestTempDirs();

async function fixture() {
  const f = await storeFixture(tempDirs.make("knowledge-publication-"), {
    policy: { writesEnabled: true, operatorRead: true },
  });
  const owner = toolContext(f.api);
  return {
    ...f,
    owner,
    operator: operatorContext(f.api),
    store: new SqliteIdentityStore(f.config.statePath),
    service: createKnowledgeService(f.api),
    access: () => accessFor(owner, true),
    setAudience: (value: TestAudience) => {
      owner.tool.memoryAudience = value;
    },
  };
}
const draft = () => ({
  requestId: randomUUID(),
  title: "Publication test",
  type: "note",
  body: "Authored text.\n",
});
const edit = (record: any, fields = {}) => ({
  requestId: randomUUID(),
  id: record.id,
  expectedRevision: record.revision,
  expectedHash: record.hash,
  title: record.title,
  body: record.body,
  ...fields,
});

it("UI creates sourced page; agent reads and edits; durable retry/history/readback agree", async () => {
  const f = await fixture(),
    input = {
      ...draft(),
      source: { text: "Exact original\nSecond line", attribution: "User supplied note" },
    };
  const receipt = await f.service.save_page(input, f.operator);
  expect(receipt.state).toBe("published");
  expect(Check(contract.operations.save_page.output, receipt)).toBeTruthy();
  const read = await f.service.record({ id: receipt.id, includeEvidence: true }, f.owner);
  expect(read.record!.body).toBe(input.body);
  expect(read.evidence![0]!.verified).toBe(true);
  const changed = await f.service.save_page(
    edit(read.record, { body: "Agent revision\n" }),
    f.owner,
  );
  expect(changed.revision).toBe(2);
  expect((await f.service.record({ id: receipt.id }, f.operator)).record!.body).toBe(
    "Agent revision\n",
  );
  expect(await createKnowledgeService(f.api).save_page(input, f.operator)).toStrictEqual(receipt);
  await expect(
    f.service.save_page({ ...input, body: "changed payload" }, f.operator),
  ).rejects.toThrow(/different payload/);
  const history = await f.service.history({}, f.owner);
  expect(Check(contract.operations.history.output, history)).toBeTruthy();
  expect(history.mutations.length).toBe(2);
  expect(history.entries.map((e) => e.provenance)).toStrictEqual(["agent", "operator"]);
  expect(JSON.parse(await readFile(path.join(f.root, "vault.json"), "utf8")).generation).toBe(2);
});

it("stale hash/revision, rename, deletion, and unknown metadata preservation", async () => {
  const f = await fixture(),
    created = await f.service.save_page(draft(), f.owner);
  const original = (await f.service.record({ id: created.id }, f.owner)).record;
  const full = path.join(f.root, "private", created.path);
  await writeFile(
    full,
    (await f.service.record({ id: created.id, view: "raw" }, f.owner))
      .record!.raw!.replace("title:", "custom: preserve-me\n# authored comment\ntitle:")
      .replace("Authored text.", "External prose."),
  );
  const rejected = edit(original);
  await expect(f.service.save_page(rejected, f.owner)).rejects.toThrow(/this draft was not saved/);
  expect(await f.service.mutation({ requestId: rejected.requestId }, f.owner)).toStrictEqual({
    receipt: null,
    files: [],
  });
  let current = (await f.service.record({ id: created.id }, f.owner)).record;
  expect(current!.revision).toBe(2);
  await rename(full, full + "-renamed.md");
  current = (await f.service.record({ id: created.id }, f.owner)).record;
  expect(current!.revision).toBe(3);
  const saved = await f.service.save_page(edit(current, { title: "New title" }), f.owner);
  const updated = (await f.service.record({ id: created.id }, f.owner)).record;
  const updatedRaw = (await f.service.record({ id: created.id, view: "raw" }, f.owner)).record!.raw;
  expect(updatedRaw).toMatch(/custom: preserve-me/);
  expect(updatedRaw).toMatch(/# authored comment/);
  expect(updated!.body).toBe("External prose.\n");
  expect(saved.revision).toBe(4);
  await rm(full + "-renamed.md");
  await expect(f.service.save_page(edit(updated), f.owner)).rejects.toThrow(/conflict/);
  expect((await f.service.record({ id: created.id }, f.owner)).record).toBe(null);
  expect((await f.service.history({}, f.owner)).entries[0]!.provenance).toBe(
    "external-unavailable",
  );
});

for (const stage of [
  "after-accept",
  "after-install:private/artifacts/",
  "after-link:private/artifacts/",
  "after-link:vault.json",
  "after-displace:vault.json",
  "after-install:vault.json",
  "before-receipt",
]) {
  it(`interruption at ${stage} recovers once across restart`, async () => {
    const f = await fixture(),
      input = { ...draft(), source: { text: "Retained evidence", attribution: "Test original" } };
    const publisher = new KnowledgeStorage(f.config, f.store, (where) => {
      if (where.startsWith(stage)) {
        throw new Error("simulated crash");
      }
    });
    await expect(publisher.save(input, f.access(), "agent")).rejects.toThrow(/simulated crash/);
    await expect(f.service.records({}, f.owner)).rejects.toThrow(/publication|identity/);
    const resumed = await createKnowledgeService(f.api).save_page(input, f.owner);
    expect(resumed.state).toBe("published");
    expect((await f.service.records({}, f.owner)).total).toBe(1);
    expect((await f.service.history({}, f.owner)).mutations.length).toBe(1);
    expect(await f.service.save_page(input, f.owner)).toStrictEqual(resumed);
  });
}

it("external rewrite immediately before displacement retains editor and intended versions", async () => {
  const f = await fixture(),
    created = await f.service.save_page(draft(), f.owner);
  const r = (await f.service.record({ id: created.id }, f.owner)).record,
    input = edit(r, { body: "Plugin proposal\n" });
  const originalRaw = (await f.service.record({ id: created.id, view: "raw" }, f.owner)).record!
    .raw;
  const publisher = new KnowledgeStorage(f.config, f.store, (where) => {
    if (where === `before-displace:private/${r!.path}`) {
      writeFileSync(
        path.join(f.root, "private", r!.path),
        originalRaw!.replace("Authored text.", "Racing editor."),
      );
    }
  });
  const receipt = await publisher.save(input, f.access(), "agent");
  expect(receipt.state).toBe("conflict");
  const retained = await readFile(
    path.join(f.root, "private", ".knowledge-history", input.requestId, "0.before"),
    "utf8",
  );
  expect(retained).toMatch(/Racing editor/);
  expect(await readFile(path.join(f.root, "private", r!.path), "utf8")).toMatch(/Racing editor/);
  const row = f.store.withDatabase((db) =>
    db.prepare("SELECT plan FROM mutations WHERE request=?").get(input.requestId),
  );
  expect(row!.plan).toMatch(/Plugin proposal/);
  await expect(f.service.records({}, f.owner)).rejects.toThrow(/publication/);
  expect((await f.service.history({}, f.owner)).mutations[0]!.state).toBe("conflict");
  const detail = await f.service.mutation({ requestId: input.requestId }, f.owner);
  expect(detail.files[0]!.displaced).toMatch(/Racing editor/);
  expect(detail.files[0]!.proposed).toMatch(/Plugin proposal/);
});

it("new editor file between displacement and installation is never overwritten", async () => {
  const f = await fixture(),
    created = await f.service.save_page(draft(), f.owner);
  const r = (await f.service.record({ id: created.id }, f.owner)).record;
  const publisher = new KnowledgeStorage(f.config, f.store, (where) => {
    if (where === `before-install:private/${r!.path}`) {
      writeFileSync(path.join(f.root, "private", r!.path), "New editor file");
    }
  });
  const receipt = await publisher.save(edit(r, { body: "Plugin proposal" }), f.access(), "agent");
  expect(receipt.state).toBe("conflict");
  expect(await readFile(path.join(f.root, "private", r!.path), "utf8")).toBe("New editor file");
});

it("write authority, scope isolation, missing conversation creation and disabled/sample writes", async () => {
  const f = await fixture();
  const readOnly = {
    ...f.operator,
    action: { client: { connId: "x", scopes: ["operator.read"] } },
  };
  await expect(f.service.save_page(draft(), readOnly)).rejects.toThrow(/authority/);
  const input = draft(),
    privateReceipt = await f.service.save_page(input, f.owner);
  f.setAudience({
    kind: "conversation",
    agentId: "main",
    sessionKey: "agent:main:group",
    sessionId: randomUUID(),
  });
  expect((await f.service.history({}, f.owner)).mutations.length).toBe(0);
  await expect(f.service.resume({ requestId: input.requestId }, f.owner)).rejects.toThrow(
    /unavailable/,
  );
  const shared = await f.service.save_page(input, f.owner);
  expect(shared.id).not.toBe(privateReceipt.id);
  expect((await f.service.record({ id: privateReceipt.id }, f.owner)).record).toBe(null);
  expect((await f.service.record({ id: shared.id }, f.operator)).record).toBe(null);
  await expect(
    createKnowledgeService({ ...f.api, pluginConfig: { writesEnabled: false } }).save_page(
      draft(),
      f.owner,
    ),
  ).rejects.toThrow(/disabled/);
});

type ChildResult = { code: number | null; stdout: string; stderr: string };
async function childWrite(f: any, input: any, crashAt?: string): Promise<ChildResult> {
  const { spawn } = await import("node:child_process");
  const source = `
    const { KnowledgeStorage } = await import(${JSON.stringify(sourceModule("storage"))});
    const { SqliteIdentityStore } = await import(${JSON.stringify(sourceModule("identity-store"))});
    let data=''; for await (const c of process.stdin) data+=c;
    const { config, input, crashAt } = JSON.parse(data);
    const publisher = new KnowledgeStorage(config,new SqliteIdentityStore(config.statePath), stage => { if(stage === crashAt) process.exit(77); });
    try { console.log(JSON.stringify(await publisher.save(input,{scope:{visibility:'private'},agentId:'main',assertCurrent(){}},'agent'))); }
    catch(e) { console.error(e.message); process.exitCode=1; }
  `;
  return new Promise<ChildResult>((resolve) => {
    const child = spawn(process.execPath, childEvalArgs(source), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify({ config: f.config, input, crashAt }));
  });
}

it("actual process death with a live SQLite transaction and two stage hardlinks recovers", async () => {
  const f = await fixture(),
    input = draft();
  await f.service.status({}, f.owner);
  const killed = await childWrite(f, input, "after-link:vault.json");
  expect(killed.code).toBe(77);
  const receipt = await f.service.save_page(input, f.owner);
  expect(receipt.state).toBe("published");
  expect((await f.service.records({}, f.owner)).total).toBe(1);
});

it("cross-process publishers fence competing edits and never lose the winner", async () => {
  const f = await fixture(),
    created = await f.service.save_page(draft(), f.owner);
  const r = (await f.service.record({ id: created.id }, f.owner)).record;
  const inputs = [edit(r, { body: "Writer one" }), edit(r, { body: "Writer two" })];
  const results = await Promise.all(inputs.map((input) => childWrite(f, input)));
  expect(results.filter((result) => result.code === 0).length, JSON.stringify(results)).toBe(1);
  const winner = JSON.parse(results.find((result) => result.code === 0)!.stdout);
  expect(winner.state).toBe("published");
  const current = (await f.service.record({ id: created.id }, f.owner)).record;
  expect(current!.hash).toBe(winner.hash);
  expect(current!.revision).toBe(2);
});

it("revision snapshots and publication details never cross conversation boundaries", async () => {
  const f = await fixture(),
    input = draft();
  await f.service.save_page(input, f.owner);
  const sequence = (await f.service.history({}, f.owner)).entries[0]!.sequence;
  expect((await f.service.revision({ sequence }, f.owner)).raw).toMatch(/Authored text/);
  f.setAudience({
    kind: "conversation",
    agentId: "main",
    sessionKey: "agent:main:group",
    sessionId: randomUUID(),
  });
  expect((await f.service.revision({ sequence }, f.owner)).raw).toBe(null);
  expect((await f.service.mutation({ requestId: input.requestId }, f.owner)).receipt).toBe(null);
});

it("authority expires after acceptance: no new files; original scope can resume", async () => {
  const f = await fixture(),
    input = draft();
  let current = true;
  const access: VaultAccess = {
    scope: { visibility: "private" },
    agentId: "main",
    assertCurrent() {
      if (!current) {
        throw new Error("revoked");
      }
    },
  };
  const publisher = new KnowledgeStorage(f.config, f.store, (where) => {
    if (where === "after-accept") {
      current = false;
    }
  });
  await expect(publisher.save(input, access, "agent")).rejects.toThrow(/revoked/);
  expect((await f.service.history({}, f.operator)).mutations[0]!.state).toBe("accepted");
  expect((await f.service.save_page(input, f.owner)).state).toBe("published");
});

it("published generation restore and pending replacement roots are fenced", async () => {
  const f = await fixture();
  await f.service.save_page(draft(), f.owner);
  await writeFile(path.join(f.root, "vault.json"), JSON.stringify(f.manifest));
  await expect(f.service.history({}, f.owner)).rejects.toThrow(/identity/);
  await expect(f.service.records({}, f.owner)).rejects.toThrow(/identity/);
});
