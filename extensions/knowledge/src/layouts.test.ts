import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { contract } from "./contract.js";
import { createKnowledgeService } from "./service.js";
import { operatorContext, storeFixture, toolContext, useTestTempDirs } from "./test-support.js";

const tempDirs = useTestTempDirs();

async function fixture() {
  const f: any = await storeFixture(tempDirs.make("knowledge-layouts-"), {
    policy: { writesEnabled: true, operatorRead: true },
  });
  f.owner = toolContext(f.api);
  f.operator = operatorContext(f.api);
  f.service = createKnowledgeService(f.api);
  // The first agent write provisions the store, as in normal use.
  await f.service.save_page(
    { requestId: randomUUID(), title: "Seed", type: "note", body: "Seed.\n" },
    f.owner,
  );
  f.definition = async (name: string) => {
    const result = await f.service.ontology({ view: "definitions", name }, f.operator);
    return { fingerprint: result.fingerprint, ...result.definitions[0] };
  };
  f.layout = (input: object) =>
    f.service.ontology_layout({ requestId: randomUUID(), ...input }, f.operator);
  f.manifest = () => readFile(path.join(f.root, "private", "ontology.yaml"), "utf8");
  return f;
}
const edited = {
  question: "what is it for and what is due?",
  sections: [
    { heading: "Milestones", guidance: "dated outcomes and targets." },
    { heading: "Open questions", guidance: "what is unresolved, with its owner." },
  ],
};

it("saves, replays and resets one layout in the vault manifest without changing the fingerprint", async () => {
  const f = await fixture();
  const before = await f.definition("project");
  expect(before.layout.sections[0].heading).toBe("Key decisions");
  expect(before.layoutOverride).toBeUndefined();
  // An agent read the fingerprint before the layout edit and writes after it.
  const inFlight = before.fingerprint;

  const input = {
    requestId: randomUUID(),
    type: "project",
    expectedLayout: before.layout,
    layout: edited,
  };
  const snapshot = (await f.service.status({}, f.operator)).snapshot;
  const saved = await f.service.ontology_layout(input, f.operator);
  // Other open Vocabulary views refresh on a changed snapshot.
  expect((await f.service.status({}, f.operator)).snapshot).not.toBe(snapshot);
  expect(Check(contract.operations.ontology_layout.output, saved)).toBe(true);
  expect(saved).toMatchObject({ state: "published", operation: "layout", path: "ontology.yaml" });
  expect(await f.service.ontology_layout(input, f.operator)).toStrictEqual(saved);
  const manifest = parse(await f.manifest());
  expect(manifest).toMatchObject({
    name: "vault",
    extends: "knowledge-default",
    definitions: [],
    layouts: { project: edited },
  });
  const after = await f.definition("project");
  expect(after).toMatchObject({ layout: edited, layoutOverride: true, fingerprint: inFlight });
  // Other types keep their bundled definitions, layout included.
  expect((await f.definition("person")).layout.sections[0].heading).toBe("What They're Building");

  const write = await f.service.save_page(
    {
      requestId: randomUUID(),
      title: "Launch",
      type: "project",
      body: "Launch plan.\n",
      expectedOntologyFingerprint: inFlight,
    },
    f.owner,
  );
  expect(write.state).toBe("published");

  // The editor's starting point is the fence: a second editor with the old layout is refused.
  await expect(
    f.layout({ type: "project", expectedLayout: before.layout, layout: null }),
  ).rejects.toThrow(/changed since it was opened/);
  const history = await f.service.history({}, f.operator);
  expect(history.mutations.find((m: any) => m.requestId === input.requestId)).toMatchObject({
    operation: "layout",
    reason: "Saved the project page layout.",
  });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", f.root, ...args], { encoding: "utf8" }).trim();
  expect(parse(git("show", "HEAD:private/ontology.yaml"))).toMatchObject({
    layouts: { project: edited },
  });

  const reset = await f.layout({ type: "project", expectedLayout: edited, layout: null });
  expect(reset).toMatchObject({ state: "published", operation: "layout" });
  const restored = await f.definition("project");
  expect(restored.layout).toStrictEqual(before.layout);
  expect(restored.layoutOverride).toBeUndefined();
  expect(restored.fingerprint).toBe(inFlight);
  expect(parse(await f.manifest()).layouts).toBeUndefined();
  await expect(
    f.layout({ type: "project", expectedLayout: before.layout, layout: null }),
  ).rejects.toThrow(/already uses its default/);
});

it("adds a layout to a type without one and keeps layout editing out of agent tools", async () => {
  const f = await fixture();
  expect((await f.definition("note")).layout).toBeUndefined();
  const saved = await f.layout({ type: "note", expectedLayout: null, layout: edited });
  expect(saved.state).toBe("published");
  expect(await f.definition("note")).toMatchObject({ layout: edited, layoutOverride: true });
  await expect(
    f.service.ontology_layout(
      { requestId: randomUUID(), type: "note", expectedLayout: edited, layout: null },
      f.owner,
    ),
  ).rejects.toThrow(/Knowledge settings/);
  await expect(
    f.layout({ type: "discusses", expectedLayout: null, layout: edited }),
  ).rejects.toThrow(/Unknown page type/);
  // Agents read layouts only from definitions; the catalog stays lean.
  const catalog = await f.service.ontology({}, f.owner);
  expect(JSON.stringify(catalog)).not.toContain("guidance");
});

it("refuses a manifest publication could not write, leaving the store usable", async () => {
  const f = await fixture();
  const huge = {
    question: "what is it?",
    sections: Array.from({ length: 11 }, (_, i) => ({
      heading: `Section ${i}`,
      guidance: "界".repeat(2000),
    })),
  };
  await expect(f.layout({ type: "note", expectedLayout: null, layout: huge })).rejects.toThrow(
    /would exceed/,
  );
  const write = await f.service.save_page(
    { requestId: randomUUID(), title: "After", type: "note", body: "Still writable.\n" },
    f.owner,
  );
  expect(write.state).toBe("published");
});
