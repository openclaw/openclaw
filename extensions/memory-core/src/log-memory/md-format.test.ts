import { describe, expect, it } from "vitest";
import { parseBlocks, serializeEpisodicBlock, serializeSemanticBlock } from "./md-format.js";
import type { LogMemoryEntry } from "./types.js";

const ISO_TS = "2026-05-07T12:00:00.000Z";

function episodic(content: string, tags: string[], decay = 0.95, accessCount = 0): LogMemoryEntry {
  const ts = new Date(ISO_TS);
  return {
    id: "ignored-on-roundtrip",
    timestamp: ts,
    layer: "episodic",
    payload: {
      type: "raw_log",
      content,
      tags,
      source: "log_ingest",
      decayScore: decay,
      accessCount,
      lastAccessedAt: ts,
    },
  };
}

function semantic(opts: {
  title: string;
  pattern: string;
  rootCause: string;
  tags: string[];
  source: "dream_consolidation" | "engineer_teach";
}): LogMemoryEntry {
  const ts = new Date(ISO_TS);
  return {
    id: "ignored",
    timestamp: ts,
    layer: "semantic",
    payload: {
      type: opts.source === "engineer_teach" ? "engineer_knowledge" : "error_pattern",
      content: opts.pattern,
      tags: opts.tags,
      source: opts.source,
      decayScore: 0.9,
      accessCount: 0,
      lastAccessedAt: ts,
      title: opts.title,
      rootCause: opts.rootCause,
    },
  };
}

describe("md-format episodic", () => {
  it("serializes with the spec heading and trailing metadata", () => {
    const entry = episodic("probe disconnected after relay reset", [
      "level:ERROR",
      "service:diagfw",
      "host:dut-01",
    ]);
    const out = serializeEpisodicBlock(entry);
    expect(out).toBe(
      `## [${ISO_TS}] level:ERROR service:diagfw host:dut-01\nprobe disconnected after relay reset\ndecay: 0.95\naccessCount: 0\n`,
    );
  });

  it("round-trips through parseBlocks", () => {
    const original = episodic(
      "probe disconnected",
      ["level:ERROR", "service:diagfw", "host:dut-01"],
      0.7,
      3,
    );
    const text = serializeEpisodicBlock(original);
    const [parsed] = parseBlocks(text, { layer: "episodic" });
    expect(parsed.timestamp.toISOString()).toBe(ISO_TS);
    expect(parsed.payload.tags).toEqual(["level:ERROR", "service:diagfw", "host:dut-01"]);
    expect(parsed.payload.content).toBe("probe disconnected");
    expect(parsed.payload.decayScore).toBeCloseTo(0.7, 4);
    expect(parsed.payload.accessCount).toBe(3);
    expect(parsed.layer).toBe("episodic");
  });

  it("parses multiple blocks separated by blank lines", () => {
    const a = serializeEpisodicBlock(episodic("first", ["level:INFO"]));
    const b = serializeEpisodicBlock(episodic("second", ["level:ERROR"]));
    const blocks = parseBlocks(`${a}\n${b}`, { layer: "episodic" });
    expect(blocks).toHaveLength(2);
    expect(blocks[0].payload.content).toBe("first");
    expect(blocks[1].payload.content).toBe("second");
  });

  it("preserves multi-line bodies", () => {
    const entry = episodic("first line\nsecond line\nthird line", ["level:INFO"]);
    const text = serializeEpisodicBlock(entry);
    const [parsed] = parseBlocks(text, { layer: "episodic" });
    expect(parsed.payload.content).toBe("first line\nsecond line\nthird line");
  });

  it("round-trips an optional consolidatedAt timestamp", () => {
    const ts = new Date(ISO_TS);
    const entry: LogMemoryEntry = {
      id: "x",
      timestamp: ts,
      layer: "episodic",
      payload: {
        type: "raw_log",
        content: "consumed log",
        tags: ["level:ERROR"],
        source: "log_ingest",
        decayScore: 0.05,
        accessCount: 0,
        lastAccessedAt: ts,
        consolidatedAt: new Date("2026-05-08T03:00:00.000Z"),
      },
    };
    const text = serializeEpisodicBlock(entry);
    expect(text).toContain("consolidatedAt: 2026-05-08T03:00:00.000Z");
    const [parsed] = parseBlocks(text, { layer: "episodic" });
    expect(parsed.payload.consolidatedAt?.toISOString()).toBe("2026-05-08T03:00:00.000Z");
    expect(parsed.payload.content).toBe("consumed log");
  });

  it("omits consolidatedAt when absent", () => {
    const entry = episodic("untouched", ["level:INFO"]);
    const text = serializeEpisodicBlock(entry);
    expect(text).not.toContain("consolidatedAt");
    const [parsed] = parseBlocks(text, { layer: "episodic" });
    expect(parsed.payload.consolidatedAt).toBeUndefined();
  });
});

describe("md-format semantic", () => {
  it("serializes Pattern/Root cause/Tags/Source", () => {
    const entry = semantic({
      title: "Probe stuck pattern",
      pattern: "Repeated probe disconnects on diagfw.",
      rootCause: "Jig misalignment.",
      tags: ["service:diagfw", "level:ERROR"],
      source: "dream_consolidation",
    });
    const out = serializeSemanticBlock(entry);
    expect(out).toBe(
      `## [${ISO_TS}] Probe stuck pattern\nPattern: Repeated probe disconnects on diagfw.\nRoot cause: Jig misalignment.\nTags: service:diagfw, level:ERROR\nSource: dream_consolidation\n`,
    );
  });

  it("round-trips and infers payload type from source", () => {
    const teach = semantic({
      title: "humidity tip",
      pattern: "high humidity correlates with relay flutter",
      rootCause: "",
      tags: ["service:cooler"],
      source: "engineer_teach",
    });
    const [parsed] = parseBlocks(serializeSemanticBlock(teach), { layer: "semantic" });
    expect(parsed.layer).toBe("semantic");
    expect(parsed.payload.type).toBe("engineer_knowledge");
    expect(parsed.payload.source).toBe("engineer_teach");
    expect(parsed.payload.title).toBe("humidity tip");
    expect(parsed.payload.tags).toEqual(["service:cooler"]);
  });
});
