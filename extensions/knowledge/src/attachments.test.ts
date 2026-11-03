import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import { writeFile, readFile, rm, symlink, link } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Check } from "typebox/value";
import { expect, it, vi } from "vitest";
import { ATTACHMENT_CHUNK_BYTES, ATTACHMENT_DOWNLOAD_CHUNK_BYTES } from "./attachment-contract.js";
import { contract } from "./contract.js";
import { SqliteIdentityStore } from "./identity-store.js";
import { createKnowledgeService } from "./service.js";
import { KnowledgeStorage } from "./storage.js";
import {
  accessFor,
  apiFor,
  createVault,
  jsonRoundTrip,
  operatorContext,
  sessionActions,
  toolContext,
  useTestTempDirs,
} from "./test-support.js";

const tempDirs = useTestTempDirs();

async function fixture() {
  const base = tempDirs.make("knowledge-files-");
  const { root, config } = await createVault(base);
  const api = apiFor(base, config);
  return {
    base,
    root,
    config,
    api,
    owner: operatorContext(api),
    service: createKnowledgeService(api),
  };
}

// Register the plugin on the fixture API, capturing session actions and tool factories.
async function register(f: any) {
  const actions = new Map(),
    factories = new Map();
  const { default: plugin } = await import("./index.js");
  const controls = sessionActions((action) => {
    actions.set(action.id, action);
  }).session.controls;
  plugin.register({
    ...f.api,
    id: "knowledge",
    session: { ...f.api.session, controls: { ...f.api.session?.controls, ...controls } },
    registerTool(factory: any, options: any) {
      factories.set(options!.name, factory);
    },
  });
  return { actions, factories };
}
const draft = (attachments: any) => ({
  requestId: randomUUID(),
  title: "File-backed evidence",
  type: "note",
  body: "An ordinary page.",
  attachments,
});
const uploadInput = (extra = {}) => ({
  requestId: randomUUID(),
  filename: "original.txt",
  mediaType: "text/plain",
  attribution: "User-provided original",
  offset: 0,
  data: "",
  final: true,
  ...extra,
});
async function upload(f: any, bytes: any, metadata = {}) {
  const base = uploadInput(metadata);
  let result;
  for (let offset = 0; offset < bytes.length || !result; offset += ATTACHMENT_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES);
    result = await f.service.attach(
      {
        ...base,
        offset,
        data: chunk.toString("base64"),
        final: offset + chunk.length === bytes.length,
      },
      f.owner,
    );
    expect(Check(contract.operations.attach.output, result)).toBeTruthy();
    expect(result).toStrictEqual(jsonRoundTrip(result));
  }
  return result.evidence;
}

it("large Unicode source survives chunking, bounded preview, restart, search and byte-exact download", async () => {
  const f = await fixture(),
    bytes = Buffer.from(
      `${"x".repeat(3999)}😀tail\n${"Original 🌱 evidence with Unicode\n".repeat(6000)}`,
    );
  const evidence = await upload(f, bytes);
  const stored = await readFile(path.join(f.root, "private", evidence.path));
  expect(stored.equals(bytes), "stored original bytes").toBe(true);
  const receipt = await f.service.save_page(draft([evidence]), f.owner);
  const service = createKnowledgeService(f.api),
    read = await service.record({ includeEvidence: true, id: receipt.id }, f.owner);
  expect(read.record!.valid).toBeTruthy();
  expect(read.evidence![0]!.verified).toBe(true);
  expect(read.evidence![0]!.excerpt).toBe("x".repeat(3999));
  expect(read.evidence![0]!.excerptTruncated).toBe(true);
  expect(Check(contract.operations.record.output, read)).toBeTruthy();
  const chunks = [];
  let offset: number | null = 0;
  do {
    const result = await service.attachment(
      { id: receipt.id, path: evidence.path, sha256: evidence.sha256, offset },
      f.owner,
    );
    expect(Check(contract.operations.attachment.output, result)).toBeTruthy();
    chunks.push(Buffer.from(result.data, "base64"));
    offset = result.nextOffset;
  } while (offset !== null);
  expect(Buffer.concat(chunks).equals(bytes), "downloaded original bytes").toBe(true);
  const search = await service.grep({ query: "ordinary" }, f.owner);
  expect(search.total).toBe(1);
  expect(Check(contract.operations.grep.output, search)).toBeTruthy();
  expect(search, "No undefined line locators for whole-file evidence").toStrictEqual(
    jsonRoundTrip(search),
  );
  const committed = execFileSync("git", ["show", `HEAD:private/${evidence.path}`], { cwd: f.root });
  expect(committed.equals(bytes), "Git original bytes").toBe(true);
});

it("binary/PDF originals are never coerced into UTF-8; media remains outside automatic Git", async () => {
  const f = await fixture(),
    bytes = Buffer.from([0, 255, 254, 128, 10, 13, 42]);
  const pdf = await upload(f, bytes, { filename: "scan.pdf", mediaType: "application/pdf" });
  const media = await upload(f, bytes, { filename: "photo.png", mediaType: "image/png" });
  const saved = await f.service.save_page(draft([pdf, media]), f.owner);
  const read = await f.service.record({ includeEvidence: true, id: saved.id }, f.owner);
  expect(read.evidence!.every((e) => e.verified && !e.excerpt)).toBeTruthy();
  expect(execFileSync("git", ["show", `HEAD:private/${pdf.path}`], { cwd: f.root })).toStrictEqual(
    bytes,
  );
  const tracked = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
    cwd: f.root,
    encoding: "utf8",
  });
  expect(!tracked.includes(media.path)).toBeTruthy();
  expect(await readFile(path.join(f.root, "private", media.path))).toStrictEqual(bytes);
});

it("more than twenty sources save and enumerate without truncating stored evidence", async () => {
  const f = await fixture(),
    sources = [];
  for (let i = 0; i < 27; i++) {
    sources.push(await upload(f, Buffer.from(`Source ${i}`), { filename: `${i}.txt` }));
  }
  const saved = await f.service.save_page(draft(sources), f.owner);
  const first = await f.service.record({ includeEvidence: true, id: saved.id }, f.owner);
  expect(first.evidenceTotal).toBe(27);
  expect(first.evidence!.length).toBe(20);
  expect(first.nextEvidenceOffset).toBe(20);
  const second = await f.service.record(
    { includeEvidence: true, id: saved.id, evidenceOffset: first.nextEvidenceOffset! },
    f.owner,
  );
  expect(second.evidence!.length).toBe(7);
  expect(second.nextEvidenceOffset).toBe(null);
  expect([...first.evidence!, ...second.evidence!].map((e) => e.path)).toStrictEqual(
    sources.map((e) => e.path),
  );
});

it("upload resumes across reload, exact chunks replay, divergent chunks and metadata fail closed", async () => {
  const f = await fixture(),
    base = uploadInput({ data: Buffer.from("first").toString("base64"), final: false });
  const first = await f.service.attach(base, f.owner);
  const service = createKnowledgeService(f.api);
  expect(await service.attach(base, f.owner)).toStrictEqual(first);
  await expect(
    service.attach({ ...base, data: Buffer.from("other").toString("base64") }, f.owner),
  ).rejects.toThrow(/differs/);
  await expect(service.attach({ ...base, filename: "changed.txt" }, f.owner)).rejects.toThrow(
    /different metadata/,
  );
  await expect(service.attach({ ...base, offset: 10 }, f.owner)).rejects.toThrow(/offset/);
  const final = { ...base, offset: 5, data: Buffer.from("second").toString("base64"), final: true };
  const completed = await service.attach(final, f.owner);
  expect(await service.attach(final, f.owner)).toStrictEqual(completed);
  expect(await readFile(path.join(f.root, "private", completed.evidence!.path))).toStrictEqual(
    Buffer.from("firstsecond"),
  );
  expect(
    (await service.records({}, f.owner)).total,
    "Uploading is independent of page publication",
  ).toBe(0);
});

it("attachment authority, record-scoped reads, tampering, paths and links are enforced", async () => {
  const f = await fixture(),
    readOnly = { ...f.owner, action: { client: { scopes: ["operator.read"] } } };
  await expect(f.service.attach(uploadInput(), readOnly)).rejects.toThrow(/authority/);
  await expect(f.service.attach(uploadInput({ filename: "../escape" }), f.owner)).rejects.toThrow(
    /Invalid/,
  );
  await expect(
    f.service.attach(uploadInput({ expectedVaultId: randomUUID() }), f.owner),
  ).rejects.toThrow(/vault changed/);
  const evidence = await upload(f, Buffer.from("private original"));
  await expect(
    f.service.attachment(
      { id: "not-a-record", path: evidence.path, sha256: evidence.sha256 },
      f.owner,
    ),
  ).rejects.toThrow(/unavailable/);
  await expect(
    f.service.save_page(draft([{ ...evidence, path: "artifacts/../../private-file" }]), f.owner),
  ).rejects.toThrow(/Unsafe/);
  const saved = await f.service.save_page(draft([evidence]), f.owner);
  const file = path.join(f.root, "private", evidence.path);
  await writeFile(file, "tampered");
  expect(
    (await f.service.record({ includeEvidence: true, id: saved.id }, f.owner)).evidence![0]!
      .verified,
  ).toBe(false);
  await expect(
    f.service.attachment({ id: saved.id, path: evidence.path, sha256: evidence.sha256 }, f.owner),
  ).rejects.toThrow(/hash/);
  await rm(file);
  await symlink(path.join(f.base, "outside"), file);
  await expect(
    f.service.attachment({ id: saved.id, path: evidence.path, sha256: evidence.sha256 }, f.owner),
  ).rejects.toThrow(/Unsafe/);
  await rm(file);
  await writeFile(path.join(f.base, "outside"), "private original");
  await link(path.join(f.base, "outside"), file);
  await expect(
    f.service.attachment({ id: saved.id, path: evidence.path, sha256: evidence.sha256 }, f.owner),
  ).rejects.toThrow(/Unsafe/);
});

it("source files are independent of the catalog scan byte budget; legacy large text is retained", async () => {
  const f = await fixture(),
    bytes = Buffer.alloc(9 * 1024 * 1024, 65);
  const evidence = await upload(f, bytes);
  const saved = await f.service.save_page(draft([evidence]), f.owner);
  expect(
    (await f.service.record({ includeEvidence: true, id: saved.id }, f.owner)).record!.valid,
  ).toBe(true);
  const source = { text: "Legacy source\n".repeat(8000), attribution: "Older client" };
  expect(Check(contract.operations.save_page.input, { ...draft([]), source })).toBeTruthy();
  const legacy = await f.service.save_page({ ...draft([]), source }, f.owner);
  const record = await f.service.record({ includeEvidence: true, id: legacy.id }, f.owner);
  expect(record.evidence![0]!.sha256).toBe(createHash("sha256").update(source.text).digest("hex"));
  const original = await readFile(path.join(f.root, "private", record.evidence![0]!.path));
  expect(original.equals(Buffer.from(source.text)), "legacy original bytes").toBe(true);
});

it("attachment filesystem work and live authority checks leave the SQLite writer unlocked", async () => {
  const f = await fixture(),
    store = new SqliteIdentityStore(f.config.statePath),
    storage = new KnowledgeStorage(f.config, store, () => assertUnlocked()),
    access = accessFor(f.owner, true);
  await storage.initialize(access);
  const contender = new DatabaseSync(f.config.statePath, { timeout: 0 });
  const assertUnlocked = () => contender.exec("BEGIN IMMEDIATE; COMMIT");
  const sync = fs.fsyncSync;
  const spy = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    assertUnlocked();
    sync(fd);
  });
  syncBuiltinESMExports();
  try {
    const receipt = await storage.attach(
      uploadInput({ data: Buffer.from("Original bytes").toString("base64") }),
      {
        ...access,
        assertCurrent: () => {
          access.assertCurrent();
          assertUnlocked();
        },
      },
    );
    expect(receipt.state).toBe("complete");
    expect(spy).toHaveBeenCalled();
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
    contender.close();
  }
});

for (const stage of [
  "attachment-after-chunk",
  "attachment-after-stage",
  "attachment-after-link",
  "attachment-descriptor-after-link",
  "attachment-before-receipt",
  "attachment-after-receipt",
]) {
  it(`file installation interruption at ${stage} recovers without overwriting the original`, async () => {
    const f = await fixture(),
      input = uploadInput({ data: Buffer.from("Original bytes").toString("base64") });
    const storage = new KnowledgeStorage(
      f.config,
      new SqliteIdentityStore(f.config.statePath),
      (where) => {
        if (where === stage) {
          throw new Error("interrupted");
        }
      },
    );
    await expect(storage.attach(input, accessFor(f.owner, true))).rejects.toThrow(/interrupted/);
    if (stage === "attachment-after-chunk") {
      const retry = new KnowledgeStorage(f.config);
      await expect(
        retry.attach(
          { ...input, offset: 14, data: Buffer.from("extra").toString("base64") },
          accessFor(f.owner, true),
        ),
      ).rejects.toThrow(/offset/);
    }
    const resumed = await createKnowledgeService(f.api).attach(input, f.owner);
    expect(resumed.state).toBe("complete");
    expect(await readFile(path.join(f.root, "private", resumed.evidence!.path))).toStrictEqual(
      Buffer.from("Original bytes"),
    );
    expect(await f.service.attach(input, f.owner)).toStrictEqual(resumed);
  });
}

it("conversation uploads and downloads cannot reach private originals or receipts", async () => {
  const f = await fixture(),
    sessionId = randomUUID();
  const group = toolContext(f.api, "main", {
    kind: "conversation",
    agentId: "main",
    sessionKey: "agent:main:group-files",
    sessionId,
  });
  const input = uploadInput({ data: Buffer.from("PRIVATE").toString("base64") });
  const privateFile = await f.service.attach(input, f.owner),
    privatePage = await f.service.save_page(draft([privateFile.evidence]), f.owner);
  await expect(
    f.service.attachment(
      {
        id: privatePage.id,
        path: privateFile.evidence!.path,
        sha256: privateFile.evidence!.sha256,
      },
      group,
    ),
  ).rejects.toThrow(/unavailable/);
  const sharedFile = await f.service.attach(
    { ...input, data: Buffer.from("SHARED").toString("base64") },
    group,
  );
  expect(sharedFile.evidence!.sha256).not.toBe(privateFile.evidence!.sha256);
  const sharedPage = await f.service.save_page(draft([sharedFile.evidence]), group);
  expect(
    (await f.service.record({ includeEvidence: true, id: sharedPage.id }, f.owner)).record,
  ).toBe(null);
  expect(
    (await f.service.record({ includeEvidence: true, id: sharedPage.id }, group)).evidence![0]!
      .excerpt,
  ).toBe("SHARED");
  expect(await readFile(path.join(f.root, "private", privateFile.evidence!.path))).toStrictEqual(
    Buffer.from("PRIVATE"),
  );
});

// Exercise the public SDK boundary, not just the storage service. Base64 must
// fit host JSON validation on both upload and download.
it("native feature adapter accepts full-size upload and download chunks", async () => {
  const f = await fixture(),
    { actions } = await register(f);
  const invoke = async (name: any, payload: any) => {
    const response = await actions.get(name).handler({ ...f.owner.action, payload });
    expect(response.ok, response.error).toBe(true);
    return response.result;
  };
  const bytes = Buffer.alloc(ATTACHMENT_CHUNK_BYTES, 255);
  const uploaded = await invoke(
    "attach",
    uploadInput({
      filename: "boundary.bin",
      mediaType: "application/octet-stream",
      data: bytes.toString("base64"),
    }),
  );
  const saved = await invoke("save_page", draft([uploaded.evidence]));
  const chunks = [];
  let offset = 0;
  do {
    const downloaded = await invoke("attachment", {
      id: saved.id,
      path: uploaded.evidence.path,
      sha256: uploaded.evidence.sha256,
      offset,
    });
    const chunk = Buffer.from(downloaded.data, "base64");
    expect(chunk.length <= ATTACHMENT_DOWNLOAD_CHUNK_BYTES).toBeTruthy();
    chunks.push(chunk);
    offset = downloaded.nextOffset;
  } while (offset !== null);
  expect(Buffer.concat(chunks).equals(bytes), "downloaded original bytes").toBe(true);
});

it("agent download JSON survives the dynamic-tool response budget with continuation intact", async () => {
  const f = await fixture(),
    { factories } = await register(f);
  const tool = factories.get("knowledge_attachment")({
    agentId: "main",
    sessionId: randomUUID(),
    sessionKey: "agent:main:download-budget",
    memoryAudience: { kind: "owner-private", agentId: "main" },
    assertInvocationCurrent() {},
    assertMemoryAudienceCurrent() {},
  });
  const bytes = Buffer.from("Original 🌱 evidence\n".repeat(10000));
  const evidence = await upload(f, bytes, {
    filename: "源".repeat(65) + ".txt",
    mediaType: "x".repeat(200),
  });
  const saved = await f.service.save_page(draft([evidence]), f.owner);
  const chunks = [];
  let offset = 0;
  do {
    const response = await tool.execute(randomUUID(), {
      id: saved.id,
      path: evidence.path,
      sha256: evidence.sha256,
      offset,
    });
    const text = response.content
      .filter((block: any) => block.type === "text")
      .map((block: any) => block.text)
      .join("\n");
    expect(text.length < 64000, `Tool JSON needs framing headroom: ${text.length}`).toBeTruthy();
    const downloaded = JSON.parse(text.slice(0, 64000));
    const chunk = Buffer.from(downloaded.data, "base64");
    expect(downloaded.offset).toBe(offset);
    expect(downloaded.sha256).toBe(evidence.sha256);
    expect(chunk.length > 0 && chunk.length <= ATTACHMENT_DOWNLOAD_CHUNK_BYTES).toBeTruthy();
    expect(downloaded.nextOffset).toBe(
      offset + chunk.length < bytes.length ? offset + chunk.length : null,
    );
    chunks.push(chunk);
    offset = downloaded.nextOffset;
  } while (offset !== null);
  expect(Buffer.concat(chunks).equals(bytes), "downloaded original bytes").toBe(true);
});
