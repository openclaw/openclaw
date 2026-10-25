import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, symlink, rename } from "node:fs/promises";
import path from "node:path";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { ATTACHMENT_CHUNK_BYTES } from "./attachment-contract.js";
import { contract } from "./contract.js";
import type { AnnotateInput } from "./mutation-contract.js";
import { createKnowledgeService } from "./service.js";
import { storeFixture, toolContext, useTestTempDirs, jsonRoundTrip } from "./test-support.js";

const tempDirs = useTestTempDirs();

// Every filesystem change stays inside this disposable service fixture.
async function fixture() {
  const base = tempDirs.make("knowledge-evidence-read-");

  const f = await storeFixture(base, { policy: { writesEnabled: true, operatorRead: true } });
  const owner = toolContext(f.api),
    service = createKnowledgeService(f.api);
  const read = (input: any, context: any = owner) => service.evidence_read(input, context);
  return { ...f, base, owner, service, read };
}

// Upload original bytes through real service operations, including chunking.
async function upload(f: any, value: any, metadata = {}, context = f.owner) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const input = {
    requestId: randomUUID(),
    filename: "source.txt",
    mediaType: "text/plain",
    attribution: "Synthetic regression fixture",
    ...metadata,
  };
  let result;
  for (let offset = 0; offset < bytes.length || !result; offset += ATTACHMENT_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES);
    result = await f.service.attach(
      {
        ...input,
        offset,
        data: chunk.toString("base64"),
        final: offset + chunk.length === bytes.length,
      },
      context,
    );
  }
  expect(result.state).toBe("complete");
  return result.evidence;
}

// Publish source references instead of constructing internal records.
async function publish(f: any, attachments: any, context = f.owner) {
  return f.service.save_page(
    {
      requestId: randomUUID(),
      type: "note",
      title: "Passage fixture " + randomUUID(),
      body: "Synthetic note.",
      attachments,
    },
    context,
  );
}

// Optimistic-concurrency fields for a mutation of the record's current revision.
function fence(record: any) {
  return {
    requestId: randomUUID(),
    id: record.id,
    expectedRevision: record.revision,
    expectedHash: record.hash,
  };
}

// Build immutable source identity for every continuation.
function inputFor(record: any, evidence: any, extra = {}) {
  return { id: record.id, path: evidence.path, sha256: evidence.sha256, ...extra };
}

// Verify the schema, JSON byte budget, and scalar safety on every page.
function checkPage(page: any, maxChars = 3000) {
  expect(Check(contract.operations.evidence_read.output, page)).toBeTruthy();
  expect(page).toStrictEqual(jsonRoundTrip(page));
  expect(
    Buffer.byteLength(JSON.stringify(page)) < 24 * 1024,
    "JSON stays below 24 KiB",
  ).toBeTruthy();
  expect(page.text.length <= maxChars, "maxChars counts UTF-16 units").toBeTruthy();
  expect(page.text.isWellFormed(), "no split Unicode scalars").toBe(true);
  expect(page.verification).toStrictEqual({ hashMatches: true, rangeValid: true });
}

// Bound iteration so a stuck cursor fails instead of hanging the suite.
async function collect(f: any, input: any, context = f.owner, service = f.service) {
  const pages = [];
  let cursor: any,
    offset = 0;
  for (let count = 0; count < 400; count++) {
    const page = await service.evidence_read({ ...input, ...(cursor ? { cursor } : {}) }, context);
    checkPage(page, input.maxChars ?? 3000);
    expect(page.offset).toBe(offset);
    pages.push(page);
    if (page.nextCursor === null) {
      return pages;
    }
    expect(page.text.length > 0).toBeTruthy();
    expect(page.nextCursor).not.toBe(cursor);
    offset += page.text.length;
    cursor = page.nextCursor;
  }
  return expect.fail("cursor did not terminate within bounded fixture size");
}

it("short and empty passages expose exact identity, inclusive lines, normalization and completion", async () => {
  const f = await fixture(),
    original = "one 🌱\r\ntwo\r\nthree\r\n";
  const evidence = await upload(f, original),
    saved = await publish(f, [evidence]);
  const inspected = (await f.service.record({ id: saved.id }, f.owner)).record;
  const whole = await f.read(inputFor(saved, evidence));
  checkPage(whole);
  expect(whole.record).toStrictEqual({
    id: saved.id,
    revision: inspected!.revision,
    hash: inspected!.hash,
  });
  expect(whole.source).toStrictEqual({
    filename: "source.txt",
    sha256: createHash("sha256").update(original).digest("hex"),
  });
  expect(whole.range).toStrictEqual({ startLine: 1, endLine: 4 });
  expect(whole.text).toBe("one 🌱\ntwo\nthree\n");
  expect(whole.offset).toBe(0);
  expect(whole.nextCursor).toBe(null);
  // Explicit inclusive ranges omit the delimiter after their last line.
  for (const [bounds, expected, range] of [
    [{ startLine: 2, endLine: 3 }, "two\nthree", { startLine: 2, endLine: 3 }],
    [{ endLine: 1 }, "one 🌱", { startLine: 1, endLine: 1 }],
    [{ startLine: 3 }, "three\n", { startLine: 3, endLine: 4 }],
    [{ startLine: 4, endLine: 4 }, "", { startLine: 4, endLine: 4 }],
  ]) {
    const page = await f.read(inputFor(saved, evidence, bounds));
    checkPage(page);
    expect(page.text).toBe(expected);
    expect(page.range).toStrictEqual(range);
    expect(page.nextCursor).toBe(null);
  }
  expect(await readFile(path.join(f.root, "private", evidence.path))).toStrictEqual(
    Buffer.from(original),
  );
  const empty = await upload(f, ""),
    blank = await f.read(inputFor(await publish(f, [empty]), empty));
  checkPage(blank);
  expect(blank).toMatchObject({ text: "", offset: 0, range: { startLine: 1, endLine: 1 } });
  expect(blank.nextCursor).toBe(null);
});

it("long Unicode lines paginate in UTF-16 units without scalar splits or range leakage", async () => {
  const f = await fixture(),
    passage = "a".repeat(255) + "🌱" + "界é🧪".repeat(900);
  const evidence = await upload(f, "before\r\n" + passage + "\r\nafter must not leak");
  const saved = await publish(f, [evidence]),
    input = inputFor(saved, evidence, { startLine: 2, endLine: 2, maxChars: 256 });
  const first = await f.read(input);
  checkPage(first, 256);
  expect(first.text).toBe("a".repeat(255));
  expect(first.nextCursor).toBeTruthy();
  const restarted = createKnowledgeService(f.api);
  const omitted = await restarted.evidence_read(
    inputFor(saved, evidence, { cursor: first.nextCursor, maxChars: 256 }),
    f.owner,
  );
  const repeated = await restarted.evidence_read({ ...input, cursor: first.nextCursor! }, f.owner);
  expect(omitted, "omitted bounds survive service restart").toStrictEqual(repeated);
  expect(omitted.offset).toBe(255);
  expect(omitted.text.startsWith("🌱")).toBeTruthy();
  const pages = await collect(f, input, f.owner, restarted);
  expect(pages.map((page) => page.text).join("")).toBe(passage);
  expect(pages.length > 2).toBeTruthy();
  expect(
    pages.every((page) => page.range.startLine === 2 && page.range.endLine === 2),
  ).toBeTruthy();
  expect(pages.at(-1).nextCursor).toBe(null);
});

it("streaming normalizes boundary-spanning CRLF and decodes split UTF-8 scalars", async () => {
  const f = await fixture(),
    firstLine = "x".repeat(65535);
  const evidence = await upload(f, firstLine + "\r\n🌱 end\r\n"),
    saved = await publish(f, [evidence]);
  const pages = await collect(f, inputFor(saved, evidence));
  expect(pages.map((page) => page.text).join("")).toBe(firstLine + "\n🌱 end\n");
  expect(pages.at(-1).range).toStrictEqual({ startLine: 1, endLine: 3 });
  // A four-byte scalar starts in the last byte of a decoder input chunk.
  const split = "y".repeat(65535) + "🧪";
  const splitEvidence = await upload(f, split),
    splitSaved = await publish(f, [splitEvidence]);
  const splitPages = await collect(f, inputFor(splitSaved, splitEvidence));
  expect(splitPages.map((page) => page.text).join("")).toBe(split);
});

it("invalid schema bounds and nonexistent or reversed line ranges fail closed", async () => {
  const f = await fixture(),
    evidence = await upload(f, "one\ntwo"),
    saved = await publish(f, [evidence]);
  const input = inputFor(saved, evidence);
  for (const extra of [
    { maxChars: 255 },
    { maxChars: 3001 },
    { maxChars: 256.5 },
    { startLine: 0 },
    { endLine: -1 },
    { startLine: 1.5 },
    { cursor: "" },
    { cursor: "x".repeat(2001) },
    { sha256: "invalid" },
    { extra: true },
  ]) {
    expect(Check(contract.operations.evidence_read.input, { ...input, ...extra })).toBe(false);
    await expect(f.read({ ...input, ...extra })).rejects.toThrow(/Invalid evidence passage input/i);
  }
  for (const extra of [{ startLine: 2, endLine: 1 }, { startLine: 3 }, { endLine: 3 }]) {
    await expect(f.read({ ...input, ...extra })).rejects.toThrow(/range/i);
  }
});

it("malformed, cross-source, cross-record and changed-range cursors are rejected", async () => {
  const f = await fixture(),
    evidence = await upload(f, "head\n" + "🌱".repeat(700) + "\ntail");
  const other = await upload(f, "other source".repeat(100)),
    saved = await publish(f, [evidence, other]);
  const otherRecord = await publish(f, [evidence]);
  const input = inputFor(saved, evidence, { startLine: 2, endLine: 2, maxChars: 256 });
  const first = await f.read(input),
    cursor = first.nextCursor;
  expect(cursor).toBeTruthy();
  for (const invalid of [
    "!",
    "e30",
    Buffer.from("null").toString("base64url"),
    cursor + "=",
    cursor!.slice(0, -1),
  ]) {
    await expect(f.read({ ...input, cursor: invalid })).rejects.toThrow(/cursor/i);
  }
  for (const changed of [
    { startLine: 1 },
    { endLine: 3 },
    { id: otherRecord.id },
    { path: other.path, sha256: other.sha256 },
  ]) {
    await expect(f.read({ ...input, cursor: cursor!, ...changed })).rejects.toThrow(/cursor/i);
  }
  // Cursors select positions, never authority: malformed offsets and positions
  // halfway through a surrogate pair must fail even with valid source identity.
  const position = JSON.parse(Buffer.from(cursor!, "base64url").toString("utf8"));
  for (const changed of [
    { offset: -1 },
    { offset: 1.5 },
    { offset: 100000 },
    { offset: 257 },
    { start: 0 },
    { end: 1 },
    { unexpected: true },
  ]) {
    const forged = Buffer.from(JSON.stringify({ ...position, ...changed })).toString("base64url");
    await expect(f.read({ ...input, cursor: forged })).rejects.toThrow(/cursor|range|Unicode/i);
  }
});

it("only a source referenced by the authorized record can be read", async () => {
  const f = await fixture(),
    evidence = await upload(f, "referenced"),
    unreferenced = await upload(f, "not attached");
  const saved = await publish(f, [evidence]),
    empty = await publish(f, []);
  for (const input of [
    inputFor(saved, unreferenced),
    inputFor(empty, evidence),
    inputFor({ id: "not-a-record" }, evidence),
    inputFor(saved, evidence, { sha256: "0".repeat(64) }),
    inputFor(saved, evidence, { path: "artifacts/../../vault.json" }),
    inputFor(saved, evidence, { path: path.join(f.root, "private", evidence.path) }),
  ]) {
    await expect(f.read(input)).rejects.toThrow(/unavailable|Invalid/i);
  }
  const noAuthority = { ...f.owner, tool: { ...f.owner.tool, memoryAudience: undefined } };
  await expect(f.read(inputFor(saved, evidence), noAuthority)).rejects.toThrow(
    /authority|unavailable/i,
  );
});

it("private and conversation passages cannot share access or continuation cursors", async () => {
  const f = await fixture(),
    sessionId = randomUUID();
  const group = toolContext(f.api, "main", {
    kind: "conversation",
    agentId: "main",
    sessionKey: "agent:main:passages",
    sessionId,
  });
  const evidence = await upload(f, "PRIVATE ".repeat(100)),
    saved = await publish(f, [evidence]);
  const input = inputFor(saved, evidence, { maxChars: 256 }),
    first = await f.read(input);
  expect(first.nextCursor).toBeTruthy();
  // Plain partition isolation is proven for attachment reads; passages add cursor binding.
  await expect(f.read({ ...input, cursor: first.nextCursor! }, group)).rejects.toThrow(
    /unavailable/i,
  );
  // Retain record/source identity but author valid conversation metadata.
  // Simply copying private metadata is correctly rejected before cursor checks.
  const record = (await f.service.record({ id: saved.id, view: "raw" }, f.owner)).record;
  const scopeRoot = path.join(f.root, "conversations", sessionId);
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(record!.raw!);
  expect(frontmatter).toBeTruthy();
  const metadata = parse(frontmatter![1]!);
  metadata.scope = { visibility: "conversation", sessionId };
  const scopedRaw =
    "---\n" + stringify(metadata) + "---\n" + record!.raw!.slice(frontmatter![0].length);
  for (const [relative, bytes] of [
    [record!.path, scopedRaw],
    [evidence.path, Buffer.from("PRIVATE ".repeat(100))],
  ]) {
    const target = path.join(scopeRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  // A digest is not authority: the receiving partition must retain its descriptor too.
  await expect(f.read(input, group)).rejects.toThrow(/unavailable/i);
  const descriptorPath = `artifacts/sources/${evidence.source}.json`;
  await mkdir(path.join(scopeRoot, "artifacts/sources"), { recursive: true });
  await writeFile(
    path.join(scopeRoot, descriptorPath),
    await readFile(path.join(f.root, "private", descriptorPath)),
  );
  expect((await f.read(input, group)).text).toBe(first.text);
  await expect(f.read({ ...input, cursor: first.nextCursor! }, group)).rejects.toThrow(/cursor/i);
});

it("every continuation rechecks live invocation and audience authority", async () => {
  const f = await fixture(),
    evidence = await upload(f, "live authority ".repeat(100)),
    saved = await publish(f, [evidence]);
  const input = inputFor(saved, evidence, { maxChars: 256 }),
    first = await f.read(input);
  for (const method of ["assertInvocationCurrent", "assertMemoryAudienceCurrent"]) {
    const revoked = {
      ...f.owner,
      tool: {
        ...f.owner.tool,
        [method]() {
          throw new Error("authority revoked");
        },
      },
    };
    await expect(f.read({ ...input, cursor: first.nextCursor! }, revoked)).rejects.toThrow(
      /revoked/,
    );
  }
  const next = await f.read({ ...input, cursor: first.nextCursor! });
  expect(next.offset).toBe(first.text.length);
});

it("withdrawal blocks new and continuing reads even after stale record restoration", async () => {
  const f = await fixture(),
    evidence = await upload(f, "withdraw me ".repeat(100)),
    saved = await publish(f, [evidence]);
  const before = (await f.service.record({ id: saved.id, view: "raw" }, f.owner)).record;
  const input = inputFor(saved, evidence, { maxChars: 256 }),
    first = await f.read(input);
  await f.service.withdraw({ ...fence(before), reason: "Synthetic withdrawal" }, f.owner);
  for (const cursor of [undefined, first.nextCursor]) {
    await expect(f.read({ ...input, ...(cursor ? { cursor } : {}) })).rejects.toThrow(
      /unavailable/i,
    );
  }
  // Durable tombstones must dominate an externally restored pre-withdrawal file.
  await writeFile(path.join(f.root, "private", before!.path), before!.raw!);
  const restarted = createKnowledgeService(f.api);
  await expect(
    restarted.evidence_read({ ...input, cursor: first.nextCursor! }, f.owner),
  ).rejects.toThrow(/unavailable/i);
});

it("source tampering beyond the requested range invalidates first and continuation pages", async () => {
  const f = await fixture(),
    original = "a".repeat(700) + "\nTAIL";
  const evidence = await upload(f, original),
    saved = await publish(f, [evidence]);
  const input = inputFor(saved, evidence, { startLine: 1, endLine: 1, maxChars: 256 });
  const first = await f.read(input),
    file = path.join(f.root, "private", evidence.path);
  await writeFile(file, original.slice(0, -4) + "FAIL");
  for (const extra of [{}, { cursor: first.nextCursor! }]) {
    await expect(f.read({ ...input, ...extra })).rejects.toThrow(/hash|unavailable/i);
  }
  await writeFile(file, original);
  expect((await f.read({ ...input, cursor: first.nextCursor! })).offset).toBe(256);
});

it("binary and malformed UTF-8 are rejected even beyond a selected passage", async () => {
  const f = await fixture();
  const cases = [
    [Buffer.from("%PDF-1.7 plain ASCII"), { filename: "scan.pdf", mediaType: "application/pdf" }],
    [Buffer.from("good first line\nrest\u0000binary"), {}],
    [Buffer.concat([Buffer.from("good first line\n"), Buffer.from([0xc0, 0xaf])]), {}],
    [Buffer.concat([Buffer.from("good first line\n"), Buffer.from([0xf0, 0x9f, 0x8c])]), {}],
  ];
  for (const [bytes, metadata] of cases) {
    const evidence = await upload(f, bytes, metadata),
      saved = await publish(f, [evidence]);
    await expect(f.read(inputFor(saved, evidence, { startLine: 1, endLine: 1 }))).rejects.toThrow(
      /text|binary|encoded|encoding|UTF-8/i,
    );
  }
});

// Final-file symlinks and hardlinks are rejected by the shared evidence-file opener,
// proven through attachment reads; a linked parent directory is the passage-specific case.
it("a linked parent directory cannot expose retained bytes", async () => {
  const f = await fixture(),
    evidence = await upload(f, "link isolation ".repeat(100)),
    saved = await publish(f, [evidence]);
  const directory = path.dirname(path.join(f.root, "private", evidence.path)),
    moved = path.join(f.base, "moved-artifacts");
  await rename(directory, moved);
  await symlink(moved, directory);
  await expect(f.read(inputFor(saved, evidence))).rejects.toThrow(/Unsafe|unavailable|link/i);
});

// Annotation sources remain scoped to the record that explicitly cites them.
it("annotation-only identity and attribution sources are readable", async () => {
  const f = await fixture(),
    evidence = await upload(f, "Annotation-only retained source.");
  const saved = await publish(f, []),
    candidate = await publish(f, []);
  for (const annotations of [
    {
      identity: {
        status: "partial",
        context: "Synthetic unresolved identity",
        candidates: [{ id: candidate.id, basis: "Synthetic candidate", evidence: [evidence] }],
      },
    },
    {
      attribution_confidence: {
        level: "medium",
        basis: "Synthetic attribution",
        evidence: [evidence],
      },
    },
  ] satisfies AnnotateInput["annotations"][]) {
    const before = (await f.service.record({ id: saved.id }, f.owner)).record;
    const input = { ...fence(before), reason: "Synthetic annotation coverage", annotations };
    await f.service.annotate(input, f.owner);
    const result = await f.read(inputFor(saved, evidence));
    checkPage(result);
    expect(result.text).toBe("Annotation-only retained source.");
  }
  await expect(f.read(inputFor(candidate, evidence))).rejects.toThrow(/unavailable/);
});
