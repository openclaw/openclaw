import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  describeSource,
  compactEvidence,
  expandEvidence,
  sourceDescriptorPath,
} from "./source-descriptors.js";

const origin = {
  path: "artifacts/meeting/transcript.txt",
  sha256: "a".repeat(64),
  filename: "transcript.txt",
  mediaType: "text/plain",
  size: 100,
  attribution: "Recorder original",
};
const retained = describeSource(origin);
const read = (path: any) => {
  expect(path).toBe(retained.path);
  return retained.raw;
};

it("source identity is canonical, passage-independent and origin-sensitive", () => {
  const passage = { ...origin, start_line: 2, end_line: 3, quote: "verbatim" };
  expect(describeSource(passage)).toStrictEqual(retained);
  expect(
    describeSource(Object.fromEntries(Object.entries(origin).toReversed()) as typeof origin).id,
  ).toBe(retained.id);
  for (const change of [
    { attribution: "Other origin" },
    { path: "artifacts/other.txt" },
    { sha256: "b".repeat(64) },
  ]) {
    expect(describeSource({ ...origin, ...change }).id).not.toBe(retained.id);
  }
  expect(describeSource({ ...origin, attribution: undefined }).id).not.toBe(
    describeSource({ ...origin, attribution: "" }).id,
  );
});

it("hydrate and edit preserve origin independently of citation attribution", () => {
  const evidence = { ...origin, start_line: 2, end_line: 3, attribution: "Speaker attribution" };
  const { citation } = compactEvidence(evidence, origin);
  expect(citation).toStrictEqual({
    source: retained.id,
    start_line: 2,
    end_line: 3,
    attribution: "Speaker attribution",
  });
  const expanded = expandEvidence(citation, read);
  expect(expanded).toStrictEqual({ ...evidence, source: retained.id });
  expect(
    compactEvidence(expanded, expandEvidence({ source: expanded.source }, read)).citation,
  ).toStrictEqual(citation);
  expect(expandEvidence(expanded, read)).toStrictEqual(expanded);
  expect(() => compactEvidence(expanded)).toThrow(/origin/);
  expect(() => expandEvidence({ ...expanded, path: "artifacts/forged.txt" }, read)).toThrow(
    /same retained source/,
  );
  expect(() => compactEvidence({ ...origin, attribution: undefined }, origin)).toThrow(/erase/);
  const empty = compactEvidence({ ...origin, attribution: "" }, origin);
  expect(expandEvidence(empty.citation, read).attribution).toBe("");
});

it("reject malformed ranges, IDs, corrupt or missing descriptors", () => {
  for (const range of [
    { start_line: 1 },
    { end_line: 1 },
    { start_line: 2, end_line: 1 },
    { start_line: 0, end_line: 1 },
  ]) {
    expect(() => compactEvidence({ ...origin, ...range })).toThrow();
    expect(() => expandEvidence({ source: retained.id, ...range }, read)).toThrow();
  }
  expect(() => sourceDescriptorPath("../private/foo")).toThrow();
  expect(() => expandEvidence({ source: retained.id }, () => retained.raw + " ")).toThrow();
  expect(() =>
    expandEvidence({ source: retained.id }, () => {
      throw new Error("missing");
    }),
  ).toThrow(/missing/);
  const noncanonical = JSON.stringify(JSON.parse(retained.raw));
  const id = createHash("sha256").update(noncanonical).digest("hex");
  expect(() => expandEvidence({ source: id }, () => noncanonical)).toThrow(/noncanonical/);
  expect(() => expandEvidence({ source: retained.id, unexpected: true }, read)).toThrow();
  expect(
    expandEvidence(origin, () => {
      throw new Error("legacy must not resolve");
    }),
  ).toStrictEqual(origin);
});
