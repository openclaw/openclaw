import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../memory-core/api.js", () => ({
  getMemoryManagerContext: vi.fn().mockResolvedValue({ error: "unavailable in test" }),
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-runtime-core", () => ({
  resolveSessionAgentIds: vi.fn().mockReturnValue({ sessionAgentId: "main" }),
}));

describe("memory-kb bridge", () => {
  const prevHome = process.env.HOME;

  const prevState = process.env.OPENCLAW_STATE_DIR;

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
    if (prevState === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = prevState;
    }
  });

  it("falls back to stub KB when memory-core is unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-mem-kb-"));
    delete process.env.OPENCLAW_STATE_DIR;
    process.env.HOME = dir;
    process.env.OPENCLAW_STATE_DIR = join(dir, ".claworks");

    const { createMemoryKnowledgeBase } = await import("./memory-kb.js");
    const api = {
      config: {},
      logger: { warn: vi.fn(), info: vi.fn() },
    };

    const kb = await createMemoryKnowledgeBase(api as never);
    await kb.ingest("hello kb", { namespace: "test", source: "unit" });
    const hits = await kb.search("hello");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.text).toContain("hello");

    const dropRoot = join(dir, ".claworks", "kb-drop", "test");
    expect(existsSync(dropRoot)).toBe(true);
    const mdFiles = readFileSync(join(dropRoot, readdirSync(dropRoot)[0]!), "utf8");
    expect(mdFiles).toContain("hello kb");
  });
});
