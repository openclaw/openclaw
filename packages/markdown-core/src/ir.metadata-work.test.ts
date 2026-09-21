import { expect, it } from "vitest";
import { chunkText } from "./chunk-text.js";
import { isAutoLinkedMarkdownLink } from "./ir-spans.js";
import { chunkMarkdownIR, markdownToIR, sliceMarkdownIR, type MarkdownIR } from "./ir.js";
import { renderMarkdownIRChunksWithinLimit } from "./render-aware-chunking.js";

const metadataKeys = ["styles", "links", "annotations", "listItems", "blocks", "htmlTags"] as const;

function longDocument(): MarkdownIR {
  const source = Array.from(
    { length: 128 },
    (_, index) =>
      `## heading ${index}\n\n- **bold ${index}** [label ${index}](https://example.com/${index}) ` +
      `<span title="item">tail ${index}</span> https://example.net/${index}\n\n` +
      `[2026-07-02] assistant: note ${index}\n`,
  ).join("\n");
  return markdownToIR(source, {
    headingStyle: "rich",
    linkify: true,
    assistantTranscriptRoleHeaders: true,
  });
}

function countMetadataReads(ir: MarkdownIR) {
  let reads = 0;
  let entries = 0;
  for (const key of metadataKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(ir, key);
    const value: unknown = descriptor?.value;
    if (!Array.isArray(value)) {
      continue;
    }
    entries += value.length;
    Object.defineProperty(ir, key, {
      ...descriptor,
      value: new Proxy(value, {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/.test(property)) {
            reads += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    });
  }
  return { entries, reads: () => reads };
}

function projectMetadata(ir: MarkdownIR) {
  return {
    ...ir,
    links: ir.links.map((link) => ({ ...link, autoLinked: isAutoLinkedMarkdownLink(link) })),
    listItems: ir.listItems?.map((item) => Object.getOwnPropertyDescriptors(item)),
    blocks: Object.getOwnPropertyDescriptor(ir, "blocks"),
    htmlTags: Object.getOwnPropertyDescriptor(ir, "htmlTags"),
  };
}

it.each(["plain", "rendered"] as const)(
  "partitions a long parsed document without rescanning unrelated metadata (%s)",
  (mode) => {
    const reference = longDocument();
    const input = longDocument();
    expect(
      metadataKeys.map((key) => {
        const value: unknown = Object.getOwnPropertyDescriptor(reference, key)?.value;
        return Array.isArray(value) && value.length > 0;
      }),
    ).toEqual(metadataKeys.map(() => true));
    const count = countMetadataReads(input);
    const limit = 96;
    const chunks =
      mode === "plain"
        ? chunkMarkdownIR(input, limit)
        : renderMarkdownIRChunksWithinLimit({
            ir: input,
            limit,
            renderChunk: (chunk) => chunk.text,
            measureRendered: (rendered) => rendered.length,
          }).map((chunk) => chunk.source);
    const metadataReads = count.reads();

    expect(chunks.length).toBeGreaterThan(128);
    expect(chunks.every((chunk) => chunk.text.length <= limit)).toBe(true);
    if (mode === "plain") {
      expect(chunks.map((chunk) => chunk.text)).toEqual(chunkText(reference.text, limit));
    } else {
      expect(chunks.map((chunk) => chunk.text).join("")).toBe(reference.text);
    }
    let cursor = 0;
    const expected = chunks.map((chunk) => {
      const start = reference.text.indexOf(chunk.text, cursor);
      expect(start).toBeGreaterThanOrEqual(cursor);
      cursor = start + chunk.text.length;
      return sliceMarkdownIR(reference, start, cursor);
    });
    expect(chunks.map(projectMetadata)).toEqual(expected.map(projectMetadata));
    expect(projectMetadata(input)).toEqual(projectMetadata(reference));
    expect(metadataReads).toBeLessThanOrEqual(count.entries * 4 + chunks.length * 12);
  },
);

it.each(["plain", "rendered"] as const)(
  "keeps unsorted and duplicated metadata independent across chunks (%s)",
  (mode) => {
    const input = longDocument();
    for (const key of metadataKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      const value: unknown = descriptor?.value;
      if (Array.isArray(value)) {
        const reversed = value.toReversed();
        Object.defineProperty(input, key, {
          ...descriptor,
          value: [...reversed, ...reversed.slice(0, 1)],
        });
      }
    }
    const before = structuredClone(projectMetadata(input));
    const chunks =
      mode === "plain"
        ? chunkMarkdownIR(input, 96)
        : renderMarkdownIRChunksWithinLimit({
            ir: input,
            limit: 96,
            renderChunk: (chunk) => chunk.text,
            measureRendered: (rendered) => rendered.length,
          }).map((chunk) => chunk.source);
    let cursor = 0;
    const expected = chunks.map((chunk) => {
      const start = input.text.indexOf(chunk.text, cursor);
      expect(start).toBeGreaterThanOrEqual(cursor);
      cursor = start + chunk.text.length;
      return sliceMarkdownIR(input, start, cursor);
    });
    expect(chunks.length).toBeGreaterThan(128);
    expect(chunks.map(projectMetadata)).toEqual(expected.map(projectMetadata));
    const links = chunks.flatMap((chunk) => chunk.links);
    expect(new Set(links).size).toBe(links.length);
    expect(links.every((link) => !input.links.includes(link))).toBe(true);
    const first = links[0];
    expect(first).toBeDefined();
    if (first) {
      first.href = "https://example.org/changed";
    }
    expect(projectMetadata(input)).toEqual(before);
  },
);
