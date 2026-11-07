import { randomUUID } from "node:crypto";
import { writeFile, stat } from "node:fs/promises";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { capacityFixture } from "./capacity-test-support.js";
import { contract } from "./contract.js";
import { readText } from "./files.js";
import { inspectRecord } from "./inspection.js";
import { RECORD_MAX_BYTES } from "./limits.js";
import { PublicationFiles, type PublicationRole } from "./publication-files.js";
import { withinBudget } from "./response-budget.js";
import { useTestTempDirs } from "./test-support.js";
import { textWindow } from "./text-window.js";

const tempDirs = useTestTempDirs();

it("near-limit records scan, publish annotations, retain history and page recovery without large responses", async () => {
  const f = await capacityFixture(tempDirs, RECORD_MAX_BYTES - 2000);
  const before = await f.record();
  expect(before!.valid).toBeTruthy();
  expect(Buffer.byteLength(before!.raw) > 4900000).toBeTruthy();
  const changed = await f.storage.annotate(
    {
      requestId: randomUUID(),
      id: before!.id,
      expectedRevision: before!.revision,
      expectedHash: before!.hash,
      reason: "Classify synthetic fixture",
      annotations: { record_class: "fixture" },
    },
    f.access,
    "agent",
  );
  expect(changed.state).toBe("published");
  expect((await f.record())!.body).toBe(before!.body);
  const head = f.storage.history(f.access, { id: before!.id }).entries[0];
  let offset: number | null = 0,
    restored = "";
  do {
    const page = f.storage.revision(f.access, head!.sequence, { offset, maxChars: 65536 });
    expect(Check(contract.operations.revision.output, page)).toBeTruthy();
    expect(withinBudget(page)).toBeTruthy();
    restored += page.raw;
    offset = page.content!.nextOffset;
  } while (offset !== null);
  expect(restored).toBe((await f.record())!.raw);
  const detail = f.storage.mutation(f.access, changed.requestId);
  expect(Check(contract.operations.mutation.output, detail)).toBeTruthy();
  expect(withinBudget(detail)).toBeTruthy();
  expect(detail.files[0]!.content.proposed.nextOffset! > 0).toBeTruthy();
  const next = f.storage.mutation(f.access, changed.requestId, {
    charOffset: detail.files[0]!.content.proposed.nextOffset!,
  });
  expect(next.files[0]!.content.proposed.offset).toBe(detail.files[0]!.content.proposed.nextOffset);
  const content = await f.storage.run(f.access, (vault) =>
    inspectRecord(vault, { id: before!.id, metadataView: "none" }),
  );
  expect(Buffer.byteLength(JSON.stringify(content)) <= 24576).toBeTruthy();
  expect(content.content.nextOffset! > 0).toBeTruthy();
});

it("durable bytes accept exact boundary and reject one byte over independently of auxiliary reads", async () => {
  const f = await capacityFixture(tempDirs, 1000),
    previous = await f.record();
  const prefix = previous!.raw.slice(0, previous!.raw.length - previous!.body.length);
  const raw =
    prefix +
    "é".repeat(Math.floor((RECORD_MAX_BYTES - Buffer.byteLength(prefix)) / 2)) +
    "x".repeat((RECORD_MAX_BYTES - Buffer.byteLength(prefix)) % 2);
  expect(Buffer.byteLength(raw)).toBe(RECORD_MAX_BYTES);
  await writeFile(f.file, raw);
  const files = new PublicationFiles(f.root);
  expect(files.read("private/" + previous!.path)).toBe(raw);
  expect((await f.record())!.valid).toBe(true);
  await expect(readText(f.root, "private/" + previous!.path)).rejects.toThrow(
    /limit|large|size|bytes/i,
  );
  await writeFile(f.file, raw + "x");
  expect(() => files.read("private/" + previous!.path)).toThrow(/Unsafe/);
  expect(() => files.exclusive("private/oversized.md", raw + "x")).toThrow(/byte limit/);
  await expect(f.scan()).rejects.toThrow(/Unsafe|unavailable|malformed/); // Observation fails closed on unsafe external growth.
  expect((await stat(f.file)).size, "oversized original preserved").toBe(RECORD_MAX_BYTES + 1);
});

it("text windows preserve Unicode and bound JSON escapes", () => {
  const text = "😀\u0000".repeat(40000);
  let offset: number | null = 0,
    restored = "";
  do {
    const page = textWindow(text, offset, 65536);
    expect(Buffer.byteLength(JSON.stringify(page.text)) <= 24576).toBeTruthy();
    restored += page.text;
    offset = page.content.nextOffset;
  } while (offset !== null);
  expect(restored).toBe(text);
  expect(() => textWindow(text, 1)).toThrow(/Unicode/);
  expect(() => textWindow(text, 0, 1)).toThrow(/Invalid text window/);
});

it("large full-record keyword matches keep ranking and label non-localized previews", async () => {
  const f = await capacityFixture(tempDirs, 100000),
    current = await f.record();
  const prefix = current!.raw.slice(0, -current!.body.length);
  await writeFile(
    f.file,
    prefix + "Opening context.\n" + "filler ".repeat(14000) + "\nneedle café exact phrase",
  );
  const result = await f.storage.search({ query: "needle cafe", mode: "all" }, f.access);
  expect(result.index.state).toBe("ready");
  expect(result.hits.length).toBe(1);
  expect(result.hits[0]!.matches).toStrictEqual(["body"]);
  expect(result.hits[0]!.snippet.matchLocated).toBe(false);
  expect(result.hits[0]!.snippet.text).toMatch(/^Opening context/);
  expect(result.hits[0]!.snippet.text).not.toMatch(/needle/);
  expect(Number.isFinite(result.hits[0]!.score)).toBeTruthy();
  expect(
    (await f.storage.search({ query: "exact phrase", mode: "phrase" }, f.access)).hits.length,
  ).toBe(1);
  expect(
    (await f.storage.search({ query: "phrase exact", mode: "phrase" }, f.access)).hits.length,
  ).toBe(0);
  const mixed = await f.storage.search({ query: "Capacity needle" }, f.access);
  expect(mixed.hits[0]!.matches).toStrictEqual(["title", "body"]);
  // A NUL before repeated matches cannot bypass the bounded preview.
  await writeFile(f.file, prefix + "intro\0" + "needle ".repeat(12000));
  const nul = await f.storage.search({ query: "needle" }, f.access);
  expect(nul.index.state).toBe("ready");
  expect(nul.hits.length).toBe(1);
  expect(nul.hits[0]!.snippet.matchLocated).toBe(false);
  expect(nul.hits[0]!.matches).toStrictEqual(["body"]);
});

it("publication keeps auxiliary and descriptor limits through staging and retained copies", async () => {
  const f = await capacityFixture(tempDirs, 1000),
    files = new PublicationFiles(f.root);
  // Each role's limit, plus another canonical destination of the same role.
  const sources = "private/artifacts/sources/";
  const cases: [string, number, PublicationRole, string][] = [
    ["private/ontology.yaml", 65536, "auxiliary", "private/other.yaml"],
    ["private/artifacts/inline.md", 65536, "auxiliary", "private/artifacts/other.md"],
    [
      `${sources}${"a".repeat(64)}.json`,
      8192,
      "source-descriptor",
      `${sources}${"b".repeat(64)}.json`,
    ],
  ];
  for (const [target, limit, role, freshPath] of cases) {
    const before = "x".repeat(limit),
      after = "y".repeat(limit);
    files.exclusive(target, before);
    expect(files.read(target)).toBe(before);
    const change = {
      path: target,
      before,
      after,
      stage: target + ".stage",
      backup: target + ".before",
    };
    files.publish(change, () => {});
    expect(files.read(target)).toBe(after);
    expect(() => files.exclusive(target + ".other", before + "x", role)).toThrow(/byte limit/);
    await writeFile(pathFor(f, target), after + "x");
    expect(() => files.read(target)).toThrow(/Unsafe/);
    expect(() => files.publish(change, () => {})).toThrow(/Unsafe/);
    await writeFile(pathFor(f, target), after);
    await writeFile(pathFor(f, change.backup), before + "x");
    expect(() => files.publish(change, () => {})).toThrow(/Unsafe/);
    // A staged oversize payload for a new destination is refused too.
    const fresh = {
      ...change,
      path: freshPath,
      before: null,
      stage: target + ".fresh-stage",
      backup: target + ".fresh-before",
    };
    await writeFile(pathFor(f, fresh.stage), after + "x");
    expect(() => files.publish(fresh, () => {})).toThrow(/Unsafe/);
    await writeFile(pathFor(f, fresh.stage), after);
    files.publish(fresh, () => {});
    expect(files.read(fresh.path)).toBe(after);
  }
  // The root manifest has the auxiliary ceiling, despite being outside the scope.
  expect(() => files.exclusive("vault.json", "x".repeat(65537))).toThrow(/byte limit/);
});

/** Synthetic vault-relative path for direct adversarial fixture edits. */
function pathFor(f: any, relative: any) {
  return f.root + "/" + relative;
}
