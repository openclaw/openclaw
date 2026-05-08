import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectTeachingMoment, KnowledgeCapture } from "./knowledge-capture.js";
import { LogMemoryStore } from "./store.js";
import { makeFakeEmbedder, makeTempWorkspace } from "./test-helpers.js";

describe("detectTeachingMoment", () => {
  it.each([
    "TEACH: 校準失敗代表治具髒污",
    "FACT: probe must be calibrated daily",
    "RULE: never bypass safety interlocks",
    "the root cause is a stuck relay",
    "Note: keep an eye on humidity",
    "FYI: night shift saw the same fault",
    "這個錯誤是因為治具偏移",
    "原因是電源不穩",
    "下次遇到 abc 直接重置",
  ])("flags teaching message: %s", (msg) => {
    expect(detectTeachingMoment(msg)).toBe(true);
  });

  it.each(["just a normal log line", "", "ERROR: 0xDEADBEEF unrecognized opcode"])(
    "ignores non-teaching message: %s",
    (msg) => {
      expect(detectTeachingMoment(msg)).toBe(false);
    },
  );
});

describe("KnowledgeCapture (file-backed)", () => {
  const embed = makeFakeEmbedder(8);
  let workspace: ReturnType<typeof makeTempWorkspace>;
  let store: LogMemoryStore;

  beforeEach(() => {
    workspace = makeTempWorkspace();
    store = new LogMemoryStore({ workspaceDir: workspace.dir });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it("appends a semantic block to KNOWLEDGE.md and reports the path", async () => {
    const capture = new KnowledgeCapture({
      workspaceDir: workspace.dir,
      store,
      embed,
      now: () => new Date("2026-05-07T12:00:00Z"),
    });
    const result = await capture.maybeCapture({
      message: "TEACH: probe stuck means jig contamination",
      tags: ["service:diagfw"],
      title: "Probe stuck",
    });
    expect(result).not.toBeNull();
    expect(result!.knowledgeFilePath).toBe(store.semanticPath());
    expect(result!.entry.layer).toBe("semantic");
    expect(result!.entry.payload.type).toBe("engineer_knowledge");
    expect(result!.entry.payload.decayScore).toBe(0.95);
    const md = await fs.readFile(store.semanticPath(), "utf8");
    expect(md).toContain("## [2026-05-07T12:00:00.000Z] Probe stuck");
    expect(md).toContain("TEACH: probe stuck means jig contamination");
    expect(md).toContain("Source: engineer_teach");
    expect(md).toContain("source:engineer_teach");
  });

  it("returns null on non-teaching messages", async () => {
    const capture = new KnowledgeCapture({ workspaceDir: workspace.dir, store, embed });
    const result = await capture.maybeCapture({ message: "ordinary chat" });
    expect(result).toBeNull();
    expect(await store.countByLayer("semantic")).toBe(0);
  });
});
