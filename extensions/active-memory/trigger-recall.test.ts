import type { MemoryCallerContext, MemorySearchHit } from "openclaw/plugin-sdk/memory-host-search";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTriggerRecallContext,
  MAX_TRIGGER_CONTEXT_CHARS,
  resetTriggerRecallRunsForTests,
  resolveTriggerRecall,
  selectStrongTriggerMatches,
} from "./trigger-recall.js";

const hoisted = vi.hoisted(() => ({
  open: vi.fn(),
  search: vi.fn(),
  candidates: vi.fn(),
  close: vi.fn(),
  getManager: vi.fn(),
  managerSearch: vi.fn(),
  listTriggerCandidates: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/memory-host-search", () => ({
  getActiveMemoryProvider: (...args: unknown[]) => hoisted.open(...args),
  getActiveMemorySearchManager: (...args: unknown[]) => hoisted.getManager(...args),
}));
function result(overrides: Partial<MemorySearchHit> = {}): MemorySearchHit {
  return {
    reference: { providerId: "records", id: "travel" },
    excerpt: "User prefers aisle seats and extra connection time.",
    score: 0.8,
    automaticRecall: { eligible: true, triggers: "when booking a flight; seat preferences" },
    ...overrides,
  };
}
function context() {
  return {
    authority: { kind: "host", operation: "trigger-test" },
    assertCurrent: vi.fn(),
  } satisfies MemoryCallerContext;
}
function request() {
  const callerContext = context();
  return {
    cfg: {},
    agentId: "main",
    query: "flight booking",
    message: "Help when booking a flight",
    context: callerContext,
    source: { kind: "native" as const, context: callerContext },
  };
}
describe("active-memory provider-neutral trigger recall", () => {
  beforeEach(() => {
    resetTriggerRecallRunsForTests();
    hoisted.search.mockReset().mockResolvedValue({ hits: [] });
    hoisted.candidates.mockReset().mockResolvedValue({ hits: [result()] });
    hoisted.close.mockReset();
    hoisted.open.mockReset().mockResolvedValue({
      provider: {
        capabilities: {
          sources: ["memory"],
          pagination: false,
          candidates: ["trigger"],
          projectFilter: true,
        },
        search: hoisted.search,
        candidates: hoisted.candidates,
        close: hoisted.close,
      },
    });
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
    "preserves deterministic trigger scores for %s",
    (_label, message, triggers, score, expected) => {
      const selected = selectStrongTriggerMatches(message, [
        result({ score, automaticRecall: { eligible: true, triggers } }),
      ]);
      expect(selected).toHaveLength(1);
      expect(selected[0]?.matchScore).toBeCloseTo(expected);
    },
  );

  it.each([
    ["insufficient overlap", "booking", "booking flight", 1],
    ["whole words", "This party starts at eight", "art", 0.2],
    ["unrelated message", "Explain SQLite indexes", "flight booking", 0.8],
  ] as const)("rejects weak matches for %s", (_label, message, triggers, score) => {
    expect(
      selectStrongTriggerMatches(message, [
        result({ score, automaticRecall: { eligible: true, triggers } }),
      ]),
    ).toEqual([]);
  });

  it("prepares the message once across trigger candidates", () => {
    const phrases = [
      "flight booking; booking flight; flight flight booking; flight booking booking",
      "connection time; time connection; connection connection time; connection time time",
    ];
    const phraseValues = new Set(phrases.flatMap((value) => value.split("; ")));
    const entries = Array.from({ length: 512 }, (_, index) =>
      result({
        reference: { providerId: "records", id: "travel", fragment: String(index) },
        score: 1,
        excerpt: `Travel guidance ${String(index)}.`,
        automaticRecall: { eligible: true, triggers: phrases[index % 2] },
      }),
    );
    const before = structuredClone(entries);
    const padding = " filler".repeat(4094);
    const messages = [`flight booking${padding}`, `connection time${padding}`] as const;
    for (const group of [0, 1, 0] as const) {
      const message = messages[group];
      const spy = vi.spyOn(String.prototype, "toLowerCase");
      let selected: ReturnType<typeof selectStrongTriggerMatches>;
      let messagePreparations: number;
      let phrasePreparations: number;
      try {
        selected = selectStrongTriggerMatches(message, entries);
      } finally {
        messagePreparations = spy.mock.contexts.filter((receiver) => receiver === message).length;
        phrasePreparations = spy.mock.contexts.filter(
          (receiver) => typeof receiver === "string" && phraseValues.has(receiver),
        ).length;
        spy.mockRestore();
      }
      expect(selected).toEqual(
        [group, group + 2, group + 4].map((index) =>
          Object.assign({}, entries[index], { matchScore: 1 }),
        ),
      );
      const rendered = buildTriggerRecallContext(selected);
      expect(rendered).toContain(`Travel guidance ${String(group)}.`);
      expect(rendered?.length).toBeLessThanOrEqual(MAX_TRIGGER_CONTEXT_CHARS + 80);
      expect(messagePreparations).toBeLessThanOrEqual(1);
      expect(phrasePreparations).toBe(2048);
    }
    expect(entries).toEqual(before);
  });

  it.each([
    ["absent metadata", [result({ automaticRecall: undefined })]],
    [
      "ineligible entries",
      [result({ automaticRecall: { eligible: false, triggers: "flight booking" } })],
    ],
    ["empty phrases", [result({ automaticRecall: { eligible: true, triggers: "; |\n" } })]],
    ["no usable words", [result({ automaticRecall: { eligible: true, triggers: "a !; b ?" } })]],
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

  it("requires explicit provider eligibility and every project key to match", () => {
    const candidates = [
      result({ automaticRecall: undefined }),
      result({ automaticRecall: { eligible: false, triggers: "flight booking" } }),
      result({
        automaticRecall: {
          eligible: true,
          triggers: "flight booking",
          projectKeys: ["alpha", "beta"],
        },
      }),
    ];
    expect(selectStrongTriggerMatches("flight booking", candidates, ["alpha"])).toEqual([]);
    expect(
      selectStrongTriggerMatches("flight booking", candidates, ["alpha", "beta"]),
    ).toHaveLength(1);
  });

  it("injects pathless records with provider citations and stable ordering", () => {
    const matches = selectStrongTriggerMatches("when booking a flight", [
      result({ reference: { providerId: "records", id: "z" } }),
      result({
        reference: { providerId: "records", id: "a" },
        citations: [{ label: "Travel preference", url: "https://example.test/record/a" }],
      }),
    ]);
    expect(matches.map((hit) => hit.reference.id)).toEqual(["a", "z"]);
    const rendered = buildTriggerRecallContext(matches);
    expect(rendered).toContain("(Source: Travel preference)");
    expect(rendered).toContain("(Source: records:z)");
  });

  it("searches locally without embeddings, deduplicates references, and closes its lease", async () => {
    hoisted.search.mockResolvedValue({ hits: [result()] });
    const recalled = await resolveTriggerRecall({ ...request(), activeProjectKeys: ["alpha"] });
    expect(recalled.injectedCount).toBe(1);
    expect(hoisted.search).toHaveBeenCalledWith(
      expect.objectContaining({ query: "flight booking", lexicalOnly: true, sources: ["memory"] }),
    );
    expect(hoisted.candidates).toHaveBeenCalledWith({
      kind: "trigger",
      activeProjectKeys: ["alpha"],
    });
    expect(hoisted.close).toHaveBeenCalledOnce();
  });

  it("does not mix records from different providers or revisions", async () => {
    hoisted.search.mockResolvedValue({
      hits: [
        result({ reference: { providerId: "records", id: "travel", revision: "2" } }),
        result({ reference: { providerId: "other", id: "travel" } }),
      ],
    });
    expect((await resolveTriggerRecall(request())).injectedCount).toBe(3);
  });

  it("preserves eligible entries in distinct fragments of the same file", async () => {
    hoisted.candidates.mockResolvedValue({
      hits: [
        result({
          reference: { providerId: "memory-core", id: "MEMORY.md", fragment: "L1-L3" },
          excerpt: "Reserve an aisle seat.",
        }),
        result({
          reference: { providerId: "memory-core", id: "MEMORY.md", fragment: "L5-L7" },
          excerpt: "Allow extra connection time.",
        }),
      ],
    });

    const recalled = await resolveTriggerRecall(request());

    expect(recalled.injectedCount).toBe(2);
    expect(recalled.context).toContain("Reserve an aisle seat.");
    expect(recalled.context).toContain("Allow extra connection time.");
  });

  it.each(["search", "candidates"] as const)(
    "filters every project key from unfiltered %s results without requesting provider filtering",
    async (source) => {
      hoisted.open.mockResolvedValue({
        provider: {
          capabilities: {
            sources: ["memory"],
            pagination: false,
            candidates: ["trigger", "project"],
            projectFilter: false,
          },
          search: hoisted.search,
          candidates: hoisted.candidates,
          close: hoisted.close,
        },
      });
      hoisted.candidates.mockResolvedValue({ hits: [] });
      hoisted[source].mockResolvedValue({
        hits: [
          result({
            reference: { providerId: "records", id: "matching" },
            excerpt: "Matching project fact.",
            automaticRecall: {
              eligible: true,
              triggers: "booking a flight",
              projectKeys: ["alpha", "beta"],
            },
          }),
          result({
            reference: { providerId: "records", id: "partial" },
            excerpt: "Partially matching project fact.",
            automaticRecall: {
              eligible: true,
              triggers: "booking a flight",
              projectKeys: ["alpha", "inactive"],
            },
          }),
        ],
      });

      const recalled = await resolveTriggerRecall({
        ...request(),
        activeProjectKeys: ["alpha", "beta"],
      });

      expect(hoisted.search).toHaveBeenCalledOnce();
      expect(hoisted.search.mock.calls[0]?.[0]).not.toHaveProperty("activeProjectKeys");
      expect(hoisted.candidates).toHaveBeenCalledExactlyOnceWith({ kind: "trigger" });
      expect(recalled.injectedCount).toBe(1);
      expect(recalled.context).toContain("Matching project fact.");
      expect(recalled.context).not.toContain("Partially matching project fact.");
    },
  );

  it("prefers eligible candidate facts for the same provider, id, fragment, and revision", async () => {
    hoisted.search.mockResolvedValue({
      hits: [
        result({
          reference: { providerId: "records", id: "travel", revision: "1", fragment: "L1-L3" },
          excerpt: "untrusted search facts",
          automaticRecall: { eligible: false, triggers: "flight booking" },
        }),
      ],
    });
    hoisted.candidates.mockResolvedValue({
      hits: [
        result({
          reference: {
            providerId: "records",
            id: "travel",
            revision: "1",
            fragment: "L1-L3",
          },
          excerpt: "trusted candidate facts",
        }),
      ],
    });

    const recalled = await resolveTriggerRecall(request());

    expect(recalled.injectedCount).toBe(1);
    expect(recalled.context).toContain("trusted candidate facts");
    expect(recalled.context).not.toContain("untrusted search facts");
  });

  it("keeps relevance from the scored copy when both copies are eligible", async () => {
    const reference = { providerId: "records", id: "hall", fragment: "L4-L4" };
    const automaticRecall = { eligible: true, triggers: "riverside hall booking" };
    hoisted.search.mockResolvedValue({
      hits: [result({ reference, score: 0.5, automaticRecall })],
    });
    hoisted.candidates.mockResolvedValue({
      hits: [result({ reference, score: 0, automaticRecall })],
    });

    const recalled = await resolveTriggerRecall({
      ...request(),
      message: "Is the riverside hall confirmed yet?",
    });

    expect(recalled).toMatchObject({ hasStrongHit: true, injectedCount: 1 });
  });

  it("shares lookup only inside one request authority and active project set", async () => {
    const params = { ...request(), runId: "run", authorityFingerprint: "authority-a" };
    await Promise.all([resolveTriggerRecall(params), resolveTriggerRecall(params)]);
    expect(hoisted.search).toHaveBeenCalledTimes(1);
    await resolveTriggerRecall({ ...params, authorityFingerprint: "authority-b" });
    await resolveTriggerRecall({ ...params, activeProjectKeys: ["alpha"] });
    expect(hoisted.search).toHaveBeenCalledTimes(3);
  });

  it("does not share trigger candidates across conversation audience sessions", async () => {
    const params = { ...request(), runId: "run", authorityFingerprint: "authority-a" };
    const contextForSession = (sessionId: string): MemoryCallerContext => ({
      authority: {
        kind: "session",
        sessionKey: `agent:main:direct:${sessionId}`,
        sessionId,
        sandboxed: false,
        audience: {
          kind: "conversation",
          agentId: "main",
          sessionKey: `agent:main:direct:${sessionId}`,
          sessionId,
        },
      },
      assertCurrent: vi.fn(),
    });

    await resolveTriggerRecall({
      ...params,
      source: { kind: "native", context: contextForSession("session-a") },
    });
    await resolveTriggerRecall({
      ...params,
      source: { kind: "native", context: contextForSession("session-b") },
    });

    expect(hoisted.search).toHaveBeenCalledTimes(2);
  });

  it("revalidates authority before releasing cached results", async () => {
    const params = { ...request(), runId: "run", authorityFingerprint: "authority-a" };
    await resolveTriggerRecall(params);
    vi.mocked(params.context.assertCurrent).mockImplementation(() => {
      throw new Error("revoked");
    });
    await expect(resolveTriggerRecall(params)).rejects.toThrow("revoked");
    expect(hoisted.search).toHaveBeenCalledOnce();
  });

  it("does not publish results if authority expires during lookup", async () => {
    const params = request();
    hoisted.candidates.mockImplementation(async () => {
      vi.mocked(params.context.assertCurrent).mockImplementation(() => {
        throw new Error("revoked");
      });
      return { hits: [result()] };
    });
    await expect(resolveTriggerRecall(params)).rejects.toThrow("revoked");
    expect(hoisted.close).toHaveBeenCalledOnce();
  });

  it("skips providers without candidates instead of inventing automatic eligibility", async () => {
    hoisted.open.mockResolvedValue({ provider: { search: hoisted.search, close: hoisted.close } });
    expect(await resolveTriggerRecall(request())).toEqual({
      hasStrongHit: false,
      injectedCount: 0,
    });
    expect(hoisted.search).not.toHaveBeenCalled();
    expect(hoisted.close).toHaveBeenCalledOnce();
  });

  it("uses candidates when lexical retrieval fails", async () => {
    hoisted.search.mockRejectedValue(new Error("search unavailable"));
    expect((await resolveTriggerRecall(request())).hasStrongHit).toBe(true);
  });

  it("aborts when acquisition does not settle", async () => {
    hoisted.open.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const recalled = resolveTriggerRecall({ ...request(), signal: controller.signal });
    controller.abort(new Error("deadline reached"));
    await expect(recalled).rejects.toThrow("deadline reached");
    expect(hoisted.search).not.toHaveBeenCalled();
  });

  it("does not begin lookup after the request has expired", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already expired"));
    await expect(resolveTriggerRecall({ ...request(), signal: controller.signal })).rejects.toThrow(
      "already expired",
    );
    expect(hoisted.open).not.toHaveBeenCalled();
  });

  it("injects at most three matches inside the bounded wrapper", () => {
    const matches = selectStrongTriggerMatches(
      "when booking a flight",
      Array.from({ length: 5 }, (_, index) =>
        result({
          reference: { providerId: "records", id: String(index) },
          excerpt: `${index} ${"x".repeat(900)}`,
        }),
      ),
    );
    const rendered = buildTriggerRecallContext(matches);
    expect(matches).toHaveLength(3);
    expect(rendered).toContain("<active_memory_plugin>");
    expect(rendered).toContain("</active_memory_plugin>");
    expect(rendered?.length).toBeLessThanOrEqual(MAX_TRIGGER_CONTEXT_CHARS + 80);
    expect(rendered).not.toContain("3 x");
  });
});

describe("active-memory legacy trigger recall", () => {
  const hall = {
    path: "MEMORY.md",
    startLine: 4,
    endLine: 4,
    snippet:
      "- the riverside hall booking is pending a deposit. <!-- trigger: riverside hall booking -->",
    source: "memory" as const,
    triggers: "riverside hall booking",
    provenance: { originClass: "owner" as const, sessionKind: "interactive" as const },
  };
  const legacyRequest = (message: string, activeProjectKeys?: string[]) =>
    resolveTriggerRecall({
      cfg: {},
      agentId: "main",
      source: { kind: "legacy" },
      query: message,
      message,
      ...(activeProjectKeys ? { activeProjectKeys } : {}),
    });

  beforeEach(() => {
    resetTriggerRecallRunsForTests();
    hoisted.open.mockReset();
    hoisted.managerSearch.mockReset().mockResolvedValue([]);
    hoisted.listTriggerCandidates.mockReset().mockResolvedValue([]);
    hoisted.getManager.mockReset().mockResolvedValue({
      manager: {
        search: hoisted.managerSearch,
        listTriggerCandidates: hoisted.listTriggerCandidates,
      },
    });
  });

  it("keeps the manager calls and cites the chunk start line without annotations", async () => {
    hoisted.listTriggerCandidates.mockResolvedValue([{ ...hall, score: 0 }]);
    hoisted.managerSearch.mockResolvedValue([{ ...hall, score: 0.9 }]);

    const recalled = await legacyRequest("riverside hall booking status?", ["alpha"]);

    expect(hoisted.open).not.toHaveBeenCalled();
    expect(hoisted.getManager).toHaveBeenCalledWith({ cfg: {}, agentId: "main" });
    expect(hoisted.managerSearch).toHaveBeenCalledWith("riverside hall booking status?", {
      maxResults: 24,
      minScore: 0,
      sources: ["memory"],
      signal: undefined,
      lexicalOnly: true,
      activeProjectKeys: ["alpha"],
    });
    expect(hoisted.listTriggerCandidates).toHaveBeenCalledWith({ activeProjectKeys: ["alpha"] });
    expect(recalled.context).toContain(
      "- - the riverside hall booking is pending a deposit. (Source: MEMORY.md#L4)",
    );
  });

  it("scores a partial trigger match with the retrieved copy's relevance", async () => {
    hoisted.listTriggerCandidates.mockResolvedValue([{ ...hall, score: 0 }]);
    hoisted.managerSearch.mockResolvedValue([{ ...hall, score: 0.5 }]);

    const recalled = await legacyRequest("Is the riverside hall confirmed yet?");

    expect(recalled).toMatchObject({ hasStrongHit: true, injectedCount: 1 });
  });

  it.each([
    ["a separator-only project annotation", ";", ["alpha"]],
    ["a mixed chunk with an inactive project", "alpha;beta", ["alpha"]],
  ])("never injects %s", async (_label, projectKey, activeProjectKeys) => {
    hoisted.listTriggerCandidates.mockResolvedValue([{ ...hall, score: 1, projectKey }]);

    const recalled = await legacyRequest("riverside hall booking status?", activeProjectKeys);

    expect(recalled).toEqual({ hasStrongHit: false, injectedCount: 0 });
  });

  it("skips managers that cannot enumerate trigger candidates", async () => {
    hoisted.getManager.mockResolvedValue({ manager: { search: hoisted.managerSearch } });

    expect(await legacyRequest("riverside hall booking status?")).toEqual({
      hasStrongHit: false,
      injectedCount: 0,
    });
    expect(hoisted.managerSearch).not.toHaveBeenCalled();
  });
});
