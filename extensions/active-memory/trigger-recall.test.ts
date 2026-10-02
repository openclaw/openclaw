import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTriggerRecallContext,
  MAX_TRIGGER_CONTEXT_CHARS,
  resolveTriggerRecall,
  selectStrongTriggerMatches,
} from "./trigger-recall.js";

const hoisted = vi.hoisted(() => ({
  getManager: vi.fn(),
  search: vi.fn(),
  listTriggerCandidates: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/memory-host-search", () => ({
  getActiveMemorySearchManager: (...args: unknown[]) => hoisted.getManager(...args),
}));

function result(overrides: Partial<MemorySearchResult> = {}): MemorySearchResult {
  return {
    path: "MEMORY.md",
    startLine: 1,
    endLine: 2,
    score: 0.8,
    snippet: "User prefers aisle seats and extra connection time.",
    source: "memory",
    triggers: "when booking a flight; seat preferences",
    provenance: { originClass: "owner", sessionKind: "interactive", observedAt: 1 },
    ...overrides,
  };
}

describe("active-memory trigger recall", () => {
  beforeEach(() => {
    hoisted.getManager.mockReset().mockResolvedValue({
      manager: { search: hoisted.search, listTriggerCandidates: hoisted.listTriggerCandidates },
    });
    hoisted.search.mockReset();
    hoisted.listTriggerCandidates.mockReset();
  });

  it.each([
    ["reordered words", "flight booking", "booking flight", 0.8, 0.96],
    ["repeated words", "booking a flight", "booking booking flight", 0.5, 0.9],
    ["Unicode and case", "CAFÉ 東京", "café 東京", 1, 1],
    ["single-word promotion", "Project status", "project", 0, 0.68],
    ["two of three words", "booking flight", "booking flight seat", 1, 0.7866666667],
    ["upper relevance clamp", "flight booking", "flight booking", 9, 1],
    ["lower relevance clamp", "flight booking", "flight booking", -1, 0.8],
  ] as const)(
    "selects deterministic trigger scores for %s",
    (_label, message, triggers, score, expected) => {
      const entry = result({ triggers, score });
      const selected = selectStrongTriggerMatches(message, [entry]);
      expect(selected).toHaveLength(1);
      expect(selected[0]).toMatchObject(entry);
      expect(selected[0]?.matchScore).toBeCloseTo(expected);
    },
  );

  it.each([
    ["insufficient overlap", "booking", "booking flight", 1],
    ["whole words", "This party starts at eight", "art", 0.2],
    ["unrelated message", "Explain SQLite indexes", "flight booking", 0.8],
  ] as const)("rejects weak trigger matches for %s", (_label, message, triggers, score) => {
    expect(selectStrongTriggerMatches(message, [result({ triggers, score })])).toEqual([]);
  });

  it("prepares the message once across trigger candidates without reusing another message", () => {
    const phrases = [
      "flight booking; booking flight; flight flight booking; flight booking booking",
      "connection time; time connection; connection connection time; connection time time",
    ];
    const phraseValues = new Set(phrases.flatMap((value) => value.split("; ")));
    const entries = Array.from({ length: 512 }, (_, index) =>
      result({
        path: `memory/${String(index).padStart(3, "0")}.md`,
        score: 1,
        triggers: phrases[index % 2],
        snippet: `Travel guidance ${String(index)}.`,
      }),
    );
    const before = structuredClone(entries);
    const padding = " filler".repeat(4094);
    const messages = [`flight booking${padding}`, `connection time${padding}`] as const;
    const work: Array<{ message: number; phrases: number }> = [];
    for (const group of [0, 1, 0] as const) {
      const message = messages[group];
      const spy = vi.spyOn(String.prototype, "toLowerCase");
      let selected: ReturnType<typeof selectStrongTriggerMatches>;
      try {
        selected = selectStrongTriggerMatches(message, entries);
      } finally {
        work.push({
          message: spy.mock.contexts.filter((receiver) => receiver === message).length,
          phrases: spy.mock.contexts.filter(
            (receiver) => typeof receiver === "string" && phraseValues.has(receiver),
          ).length,
        });
        spy.mockRestore();
      }
      expect(selected).toEqual(
        [group, group + 2, group + 4].map((index) =>
          Object.assign({}, entries[index], { matchScore: 1 }),
        ),
      );
      const context = buildTriggerRecallContext(selected);
      expect(context).toContain(`Travel guidance ${String(group)}.`);
      expect(context?.length).toBeLessThanOrEqual(MAX_TRIGGER_CONTEXT_CHARS + 80);
    }
    expect(entries).toEqual(before);
    for (const counts of work) {
      expect(counts.phrases).toBe(2048);
      expect(counts.message).toBeLessThanOrEqual(1);
    }
  });

  it.each([
    ["absent triggers", [result({ triggers: undefined })]],
    ["ineligible entries", [result({ source: "sessions" }), result({ provenance: undefined })]],
    ["empty phrases", [result({ triggers: "; |\n" })]],
    ["no usable words", [result({ triggers: "a !; b ?" })]],
  ] as const)("skips message preparation for %s", (_label, entries) => {
    const message = "Flight booking preferences";
    const spy = vi.spyOn(String.prototype, "toLowerCase");
    let selected: ReturnType<typeof selectStrongTriggerMatches>;
    let preparations: number;
    try {
      selected = selectStrongTriggerMatches(message, [...entries]);
    } finally {
      preparations = spy.mock.contexts.filter((receiver) => receiver === message).length;
      spy.mockRestore();
    }
    expect(selected).toEqual([]);
    expect(preparations).toBe(0);
  });

  it("limits automatic injection to curated or trusted-origin entries", () => {
    const matches = selectStrongTriggerMatches("when booking a flight", [
      result(),
      result({ path: "USER.md", startLine: 3 }),
      result({ path: "memory/2026-07-27.md", startLine: 4, provenance: undefined }),
      result({ source: "sessions", path: "session.jsonl", startLine: 5 }),
    ]);
    expect(matches.map((entry) => entry.path)).toEqual(["MEMORY.md", "USER.md"]);

    const provenanceMatches = selectStrongTriggerMatches("when booking a flight", [
      result({
        path: "memory/untrusted.md",
        provenance: { originClass: "untrusted", sessionKind: "interactive", observedAt: 1 },
        score: 1,
      }),
      result({ path: "memory/missing.md", provenance: undefined, score: 1 }),
      result({
        path: "memory/agent.md",
        provenance: { originClass: "agent", sessionKind: "interactive", observedAt: 1 },
        score: 1,
      }),
      result({
        path: "memory/owner.md",
        provenance: { originClass: "owner", sessionKind: "interactive", observedAt: 1 },
        score: 1,
      }),
    ]);
    expect(provenanceMatches.map((entry) => entry.path)).toEqual([
      "memory/agent.md",
      "memory/owner.md",
    ]);
  });

  it("gates tagged entries to the active project while leaving global entries unchanged", () => {
    const activeKey = "github.com/OpenClaw/OpenClaw";
    const sameProject = result({ projectKey: activeKey, startLine: 1 });
    const foreignProject = result({ projectKey: "github.com/example/other", startLine: 2 });
    const global = result({ startLine: 3 });

    expect(
      selectStrongTriggerMatches(
        "when booking a flight",
        [sameProject, foreignProject, global],
        [activeKey],
      ).map((entry) => entry.startLine),
    ).toEqual([1, 3]);
    expect(
      selectStrongTriggerMatches(
        "when booking a flight",
        [sameProject, foreignProject, global],
        [],
      ),
    ).toHaveLength(1);
  });

  it("excludes annotation carriers from injected trigger context", () => {
    const matches = selectStrongTriggerMatches(
      "Review the alpha deployment",
      [
        result({
          snippet:
            "Alpha-only deployment guidance. <!-- trigger: alpha deployment --> <!-- importance: 8 --> <!-- project: alpha-key -->",
          triggers: "alpha deployment",
          projectKey: "alpha-key",
        }),
      ],
      ["alpha-key"],
    );

    const context = buildTriggerRecallContext(matches);
    expect(context).toContain("Alpha-only deployment guidance.");
    expect(context).not.toContain("<!--");
  });

  it("honors every project retained in the session active set", () => {
    const entries = [
      result({ startLine: 1, triggers: "shared deploy", projectKey: "alpha-key" }),
      result({ startLine: 2, triggers: "shared deploy", projectKey: "beta-key" }),
      result({ startLine: 3, triggers: "shared deploy", projectKey: "gamma-key" }),
    ];
    expect(
      selectStrongTriggerMatches("shared deploy", entries, ["beta-key", "alpha-key"]).map(
        (entry) => entry.startLine,
      ),
    ).toEqual([1, 2]);
  });

  it("requires every project on a mixed chunk to be active before trigger injection", () => {
    const mixed = result({
      projectKey: "github.com/openclaw/openclaw; github.com/example/other",
    });
    expect(
      selectStrongTriggerMatches(
        "when booking a flight",
        [mixed],
        ["github.com/openclaw/openclaw"],
      ),
    ).toEqual([]);
    expect(
      selectStrongTriggerMatches(
        "when booking a flight",
        [mixed],
        ["github.com/openclaw/openclaw", "github.com/example/other"],
      ),
    ).toHaveLength(1);
  });

  it("searches lexical-only so the reply path never embeds the query", async () => {
    hoisted.search.mockResolvedValue([result()]);
    hoisted.listTriggerCandidates.mockResolvedValue([]);
    await resolveTriggerRecall({
      cfg: {} as never,
      agentId: "main",
      query: "flight booking",
      message: "Help when booking a flight",
      activeProjectKeys: ["github.com/openclaw/openclaw"],
    });
    expect(hoisted.search).toHaveBeenCalledWith(
      "flight booking",
      expect.objectContaining({ lexicalOnly: true }),
    );
    expect(hoisted.listTriggerCandidates).toHaveBeenCalledWith({
      activeProjectKeys: ["github.com/openclaw/openclaw"],
    });
  });

  it("shares one in-flight lane-1 lookup for the same run authority", async () => {
    let releaseLookup: () => void = () => {
      throw new Error("lookup gate was not initialized");
    };
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    hoisted.search.mockImplementation(async () => {
      await lookupGate;
      return [];
    });
    hoisted.listTriggerCandidates.mockImplementation(async () => {
      await lookupGate;
      return [result()];
    });
    const cfg = {} as never;

    const first = resolveTriggerRecall({
      cfg,
      agentId: "main",
      query: "flight booking",
      message: "Help when booking a flight",
      runId: "run-shared-lookup",
      authorityFingerprint: "authority-a",
    });
    const second = resolveTriggerRecall({
      cfg,
      agentId: "main",
      query: "flight booking",
      message: "Help when booking a flight",
      runId: "run-shared-lookup",
      authorityFingerprint: "authority-a",
    });
    await vi.waitFor(() => expect(hoisted.search).toHaveBeenCalledTimes(1));
    releaseLookup();

    await expect(first).resolves.toEqual(
      expect.objectContaining({ hasStrongHit: true, injectedCount: 1 }),
    );
    await expect(second).resolves.toEqual(
      expect.objectContaining({ hasStrongHit: true, injectedCount: 1 }),
    );
    expect(hoisted.search).toHaveBeenCalledTimes(1);
    expect(hoisted.listTriggerCandidates).toHaveBeenCalledTimes(1);
  });

  it("does not share lane-1 results across turn authorities", async () => {
    hoisted.search.mockResolvedValue([]);
    hoisted.listTriggerCandidates.mockResolvedValue([result()]);
    const params = {
      cfg: {} as never,
      agentId: "main",
      query: "flight booking",
      message: "Help when booking a flight",
      runId: "run-authority-scope",
    };

    await resolveTriggerRecall({ ...params, authorityFingerprint: "authority-a" });
    await resolveTriggerRecall({ ...params, authorityFingerprint: "authority-b" });

    expect(hoisted.search).toHaveBeenCalledTimes(2);
    expect(hoisted.listTriggerCandidates).toHaveBeenCalledTimes(2);
  });

  it("keeps each lane-1 abort deadline while shared lookup work continues", async () => {
    let releaseLookup: () => void = () => {
      throw new Error("lookup gate was not initialized");
    };
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    hoisted.search.mockImplementation(async () => {
      await lookupGate;
      return [];
    });
    hoisted.listTriggerCandidates.mockImplementation(async () => {
      await lookupGate;
      return [];
    });
    const first = resolveTriggerRecall({
      cfg: {} as never,
      agentId: "main",
      query: "flight booking",
      message: "Help when booking a flight",
      runId: "run-aborted-shared-lookup",
      authorityFingerprint: "authority-a",
    });
    const controller = new AbortController();
    const recall = resolveTriggerRecall({
      cfg: {} as never,
      agentId: "main",
      query: "flight booking",
      message: "Help when booking a flight",
      runId: "run-aborted-shared-lookup",
      authorityFingerprint: "authority-a",
      signal: controller.signal,
    });

    controller.abort(new Error("lane-1 budget expired"));
    await expect(recall).rejects.toThrow("lane-1 budget expired");
    releaseLookup();
    await expect(first).resolves.toEqual(
      expect.objectContaining({ hasStrongHit: false, injectedCount: 0 }),
    );
  });

  it("does not reuse an unscoped run lookup for a project-scoped lookup", async () => {
    const global = result({ startLine: 1 });
    const project = result({ startLine: 2, projectKey: "alpha-key" });
    hoisted.search.mockResolvedValue([]);
    hoisted.listTriggerCandidates
      .mockResolvedValueOnce([global])
      .mockResolvedValueOnce([global, project]);
    const cfg = {} as never;

    await resolveTriggerRecall({
      cfg,
      agentId: "main",
      query: "flight booking",
      message: "Help when booking a flight",
      runId: "run-project-scope",
      authorityFingerprint: "authority-a",
    });
    const recall = await resolveTriggerRecall({
      cfg,
      agentId: "main",
      query: "flight booking",
      message: "Help when booking a flight",
      activeProjectKeys: ["alpha-key"],
      runId: "run-project-scope",
      authorityFingerprint: "authority-a",
    });

    expect(hoisted.listTriggerCandidates).toHaveBeenCalledTimes(2);
    expect(recall.injectedCount).toBe(2);
  });

  it("skips backends that cannot enumerate curated trigger candidates", async () => {
    hoisted.getManager.mockResolvedValueOnce({ manager: { search: hoisted.search } });
    await expect(
      resolveTriggerRecall({
        cfg: {} as never,
        agentId: "main",
        query: "flight booking",
        message: "Help when booking a flight",
      }),
    ).resolves.toEqual({ hasStrongHit: false, injectedCount: 0 });
    expect(hoisted.search).not.toHaveBeenCalled();
  });

  it("matches curated trigger candidates even when text retrieval fails", async () => {
    hoisted.search.mockRejectedValue(new Error("embedding unavailable"));
    hoisted.listTriggerCandidates.mockResolvedValue([result({ score: 0 })]);
    const recalled = await resolveTriggerRecall({
      cfg: {} as never,
      agentId: "main",
      query: "flight booking",
      message: "Help when booking a flight",
    });
    expect(recalled.hasStrongHit).toBe(true);
    expect(recalled.injectedCount).toBe(1);
    expect(recalled.context).toContain("aisle seats");
  });

  it("aborts when trigger-candidate enumeration does not settle", async () => {
    hoisted.search.mockResolvedValue([]);
    hoisted.listTriggerCandidates.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const recalled = resolveTriggerRecall({
      cfg: {} as never,
      agentId: "main",
      query: "flight booking",
      message: "Help when booking a flight",
      signal: controller.signal,
    });

    controller.abort(new Error("deadline reached"));

    await expect(recalled).rejects.toThrow("deadline reached");
  });

  it("aborts when memory-manager acquisition does not settle", async () => {
    hoisted.getManager.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const recalled = resolveTriggerRecall({
      cfg: {} as never,
      agentId: "main",
      query: "flight booking",
      message: "Help when booking a flight",
      signal: controller.signal,
    });

    controller.abort(new Error("manager deadline reached"));

    await expect(recalled).rejects.toThrow("manager deadline reached");
    expect(hoisted.search).not.toHaveBeenCalled();
    expect(hoisted.listTriggerCandidates).not.toHaveBeenCalled();
  });

  it("does not start lookup work when the deadline already expired", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already expired"));

    await expect(
      resolveTriggerRecall({
        cfg: {} as never,
        agentId: "main",
        query: "flight booking",
        message: "Help when booking a flight",
        signal: controller.signal,
      }),
    ).rejects.toThrow("already expired");
    expect(hoisted.getManager).not.toHaveBeenCalled();
    expect(hoisted.search).not.toHaveBeenCalled();
    expect(hoisted.listTriggerCandidates).not.toHaveBeenCalled();
  });

  it("injects at most three matches inside the bounded active-memory wrapper", () => {
    const matches = selectStrongTriggerMatches(
      "when booking a flight",
      Array.from({ length: 5 }, (_, index) =>
        result({
          path: index % 2 === 0 ? "MEMORY.md" : "USER.md",
          startLine: index + 1,
          snippet: `${String(index)} ${"x".repeat(900)}`,
        }),
      ),
    );
    const context = buildTriggerRecallContext(matches);
    expect(matches).toHaveLength(3);
    expect(context).toContain("<active_memory_plugin>");
    expect(context).toContain("</active_memory_plugin>");
    expect(context?.length).toBeLessThanOrEqual(MAX_TRIGGER_CONTEXT_CHARS + 80);
    expect(context).not.toContain("3 x");
  });
});
