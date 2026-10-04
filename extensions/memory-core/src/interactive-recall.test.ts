import fs from "node:fs/promises";
import path from "node:path";
import { chunkMarkdown } from "openclaw/plugin-sdk/memory-core-host-engine-indexing";
import type { MemoryRecallParams } from "openclaw/plugin-sdk/memory-recall";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordMemoryRecall } from "./interactive-recall.js";
import { projectMemorySearchRow } from "./memory/manager-search-shared.js";

const record = vi.hoisted(() => vi.fn(async (_params: unknown) => {}));
// mock-isolation: Test secure file admission without starting durable-store workers.
vi.mock("./short-term-promotion-record.js", () => ({ recordShortTermRecalls: record }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const snippet = "Use the verified backup before rollout.";
const hit: MemoryRecallParams["results"][number] = {
  source: "memory",
  path: "memory/2026-01-02.md",
  startLine: 1,
  endLine: 1,
  snippet,
  score: 0.9,
  provenance: { originClass: "untrusted", sessionKind: "unknown", observedAt: 1 },
};

async function fixture(): Promise<MemoryRecallParams> {
  const workspaceDir = tempDirs.make("interactive-recall-");
  await fs.mkdir(path.join(workspaceDir, "memory"));
  await fs.writeFile(path.join(workspaceDir, hit.path), `${snippet}\nsecond line\n`);
  return {
    workspaceDir,
    query: "rollout backup",
    sessionKey: "agent:fixture:main",
    runId: "run-fixture",
    config: {
      plugins: { entries: { "memory-core": { config: { dreaming: { enabled: true } } } } },
    },
    results: [hit],
    assertActive: vi.fn(),
  };
}
const claim = () => true;

describe("interactive memory recall admission", () => {
  beforeEach(() => record.mockClear());

  it("records only grounded literal excerpts with unchanged query and provenance", async () => {
    const params = await fixture();
    await recordMemoryRecall(params, claim);
    expect(record).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        workspaceDir: params.workspaceDir,
        query: params.query,
        results: [hit],
        assertCurrent: params.assertActive,
      }),
    );
  });

  it("accepts real native EOF chunks without admitting arbitrary extra lines", async () => {
    const params = await fixture();
    const content = `${snippet}\n`;
    await fs.writeFile(path.join(params.workspaceDir, hit.path), content);
    const chunk = chunkMarkdown(content, { tokens: 400, overlap: 80 })[0]!;
    expect(chunk.endLine).toBe(2);
    params.results = [
      { ...hit, startLine: chunk.startLine, endLine: chunk.endLine, snippet: chunk.text },
    ];
    await recordMemoryRecall(params, claim);
    expect(record).toHaveBeenCalledOnce();
    record.mockClear();
    await recordMemoryRecall(
      { ...params, results: [{ ...params.results[0]!, endLine: 3 }] },
      claim,
    );
    expect(record).not.toHaveBeenCalled();
  });

  it("accepts a native projected prefix of an EOF chunk without matching arbitrary substrings", async () => {
    const params = await fixture();
    const content = `${snippet}${"x".repeat(1000 - snippet.length)}\n`;
    await fs.writeFile(path.join(params.workspaceDir, hit.path), content);
    const chunk = chunkMarkdown(content, { tokens: 400, overlap: 80 })[0]!;
    const projected = projectMemorySearchRow(
      {
        id: "fixture-chunk",
        path: hit.path,
        source: "memory",
        start_line: chunk.startLine,
        end_line: chunk.endLine,
        text: chunk.text,
      },
      700,
      hit.score,
    );
    expect(content).toHaveLength(1001);
    expect(projected).toMatchObject({ startLine: 1, endLine: 2 });
    expect(projected.snippet).toHaveLength(700);
    params.results = [projected];
    await recordMemoryRecall(params, claim);
    expect(record).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ results: [projected] }),
    );
    record.mockClear();
    for (const override of [
      { endLine: 3 },
      { endLine: 99 },
      { snippet: chunk.text.slice(1, 701) },
    ]) {
      await recordMemoryRecall({ ...params, results: [{ ...projected, ...override }] }, claim);
    }
    expect(record).not.toHaveBeenCalled();
  });

  it.each([
    { source: "sessions" },
    { path: "lancedb:virtual-id" },
    { path: "MEMORY.md" },
    { path: "memory/dreaming/2026-01-02.md" },
    { path: "../memory/2026-01-02.md" },
    { path: "memory/../memory/2026-01-02.md" },
    { path: "memory/missing-2026-01-02.md" },
    { startLine: 0 },
    { endLine: 99 },
    { snippet: "Generated abstraction, not file evidence." },
    { snippet: "" },
    { score: Number.NaN },
  ])("rejects ineligible source %j", async (override) => {
    const params = await fixture();
    params.results = [{ ...hit, ...override } as typeof hit];
    await recordMemoryRecall(params, claim);
    expect(record).not.toHaveBeenCalled();
  });

  it("rejects a date-named symlink to a file outside the workspace", async () => {
    const params = await fixture();
    const outside = tempDirs.make("interactive-recall-outside-");
    await fs.writeFile(path.join(outside, "2026-01-03.md"), snippet);
    await fs.symlink(outside, path.join(params.workspaceDir, "memory", "linked"));
    params.results = [{ ...hit, path: "memory/linked/2026-01-03.md" }];
    await recordMemoryRecall(params, claim);
    expect(record).not.toHaveBeenCalled();
  });

  it("does nothing when disabled or empty", async () => {
    const params = await fixture();
    await recordMemoryRecall({ ...params, results: [] }, claim);
    params.config = {
      plugins: { entries: { "memory-core": { config: { dreaming: { enabled: false } } } } },
    };
    await recordMemoryRecall(params, claim);
    expect(record).not.toHaveBeenCalled();
  });

  it("rejects an invocation that expires during source admission", async () => {
    const params = await fixture();
    params.assertActive = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw new Error("closed");
      });
    await expect(recordMemoryRecall(params, claim)).rejects.toThrow("closed");
    expect(record).not.toHaveBeenCalled();
  });
});
