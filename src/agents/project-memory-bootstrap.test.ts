import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemorySearchResult } from "../memory-host-sdk/host/types.js";
import type { MemoryProviderHandle, MemorySearchHit } from "../plugins/memory-provider-types.js";
import {
  filterProjectScopedCuratedContextFiles,
  prepareProjectMemoryBootstrap,
} from "./project-memory-bootstrap.js";

const runtimeMocks = vi.hoisted(() => ({
  getManager: vi.fn(),
  getProvider: vi.fn(),
  listCurated: vi.fn(),
  search: vi.fn(),
  legacyRuntime: undefined as unknown,
  providerRuntime: undefined as unknown,
}));

const projectKeys = ["github.com/OpenClaw/OpenClaw"];
const bootstrap = (overrides: Partial<Parameters<typeof prepareProjectMemoryBootstrap>[0]> = {}) =>
  prepareProjectMemoryBootstrap({
    cfg: {},
    agentId: "main",
    activeProjectKeys: projectKeys,
    ...overrides,
  });

function expectProjectSelection(lines: string[]) {
  const rendered = lines.join("\n");
  expect(rendered).toContain("Use the release helper.");
  for (const excluded of [
    "Foreign fact",
    "Untrusted project instruction",
    "Missing-provenance project instruction",
    "<!--",
  ]) {
    expect(rendered).not.toContain(excluded);
  }
  expect(rendered.length).toBeLessThanOrEqual(2_000);
}

const logMocks = vi.hoisted(() => ({ debug: vi.fn() }));

vi.mock("../plugins/memory-state.js", () => ({
  getMemoryRuntime: () => runtimeMocks.legacyRuntime,
  resolveLoadedMemoryProviderKind: () =>
    runtimeMocks.providerRuntime ? "native" : runtimeMocks.legacyRuntime ? "legacy" : undefined,
}));
vi.mock("../plugins/memory-runtime.js", () => ({
  getActiveMemoryProviderCore: (...args: unknown[]) => runtimeMocks.getProvider(...args),
}));
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => logMocks }));

describe("project memory bootstrap", () => {
  beforeEach(() => {
    runtimeMocks.getManager.mockReset();
    runtimeMocks.getProvider.mockReset();
    runtimeMocks.listCurated.mockReset();
    runtimeMocks.search.mockReset();
    runtimeMocks.legacyRuntime = { getMemorySearchManager: runtimeMocks.getManager };
    runtimeMocks.providerRuntime = undefined;
  });

  const entry: MemorySearchResult = {
    path: "MEMORY.md",
    startLine: 2,
    endLine: 2,
    score: 0.8,
    snippet:
      "Use the release helper. <!-- trigger: release helper --> <!-- importance: 8 --> <!-- project: github.com/OpenClaw/OpenClaw -->",
    source: "memory",
    projectKey: projectKeys[0],
    importance: 8,
    provenance: { originClass: "owner", sessionKind: "interactive", observedAt: 1 },
  };
  const entries = [
    entry,
    {
      ...entry,
      startLine: 3,
      endLine: 3,
      score: 0.9,
      snippet: "Foreign fact.",
      projectKey: "github.com/example/other",
      importance: 10,
    },
  ];

  async function prepareEntries(
    candidates: typeof entries,
    activeProjectKeys: string[] = ["github.com/OpenClaw/OpenClaw"],
  ): Promise<string[]> {
    runtimeMocks.listCurated.mockResolvedValue(candidates);
    runtimeMocks.getManager.mockResolvedValue({
      manager: { listCuratedProjectCandidates: runtimeMocks.listCurated },
    });
    return bootstrap({ activeProjectKeys });
  }

  it("includes only active-project entries and stays inside its budget", async () => {
    const lines = await prepareEntries([
      ...entries,
      {
        ...entries[0]!,
        startLine: 4,
        snippet: "Untrusted project instruction.",
        provenance: {
          originClass: "untrusted",
          sessionKind: "interactive",
          observedAt: 1,
        },
      },
      {
        ...entries[0]!,
        startLine: 5,
        snippet: "Missing-provenance project instruction.",
        provenance: undefined,
      },
    ]);
    expectProjectSelection(lines);
  });

  it("includes entries from every project retained in the session active set", async () => {
    const rendered = (
      await prepareEntries(entries, ["github.com/example/other", "github.com/OpenClaw/OpenClaw"])
    ).join("\n");
    expect(rendered).toContain("Use the release helper.");
    expect(rendered).toContain("Foreign fact.");
  });

  it("never emits a partial entry or exceeds the hard budget", async () => {
    const crowded = Array.from({ length: 10 }, (_, index) => ({
      ...entries[0]!,
      startLine: index + 1,
      snippet: `${String(index)} ${"bounded entry ".repeat(50)}`,
    }));
    const lines = await prepareEntries(crowded);
    expect(lines.join("\n").length).toBeLessThanOrEqual(2_000);
    expect(lines.slice(2, -1).every((line) => /\(Source: MEMORY\.md#L\d+\)$/u.test(line))).toBe(
      true,
    );
  });

  it("truncates long entries before admission while preserving the hard cap", async () => {
    const rendered = (await prepareEntries([{ ...entries[0]!, snippet: "🧠".repeat(1_000) }])).join(
      "\n",
    );
    expect(rendered).toContain("…");
    expect(rendered.length).toBeLessThanOrEqual(2_000);
  });

  it("admits a later exact-fit entry after skipping an oversized entry", async () => {
    const first = Array.from({ length: 3 }, (_, index) => ({
      ...entries[0]!,
      startLine: index + 1,
      snippet: "a".repeat(550),
    }));
    const prefix = await prepareEntries(first);
    const sourceSuffix = " (Source: MEMORY.md#L5)";
    const remaining = 2_000 - prefix.join("\n").length;
    const lastSnippet = "z".repeat(remaining - "- ".length - sourceSuffix.length - 1);
    const lines = await prepareEntries([
      ...first,
      { ...entries[0]!, startLine: 4, snippet: "b".repeat(600) },
      { ...entries[0]!, startLine: 5, snippet: lastSnippet },
      { ...entries[0]!, startLine: 6, snippet: "Does not fit." },
    ]);

    expect(lines).toEqual([...prefix.slice(0, -1), `- ${lastSnippet}${sourceSuffix}`, ""]);
    expect(lines.join("\n")).toHaveLength(2_000);
  });

  it("keeps sessions without an active repository unchanged", async () => {
    await expect(prepareEntries(entries, [])).resolves.toEqual([]);
    expect(runtimeMocks.getManager).not.toHaveBeenCalled();
  });

  it("filters tagged raw entries fail-closed with the all-keys rule", () => {
    const contextFiles = [
      {
        path: "MEMORY.md",
        content: [
          "- Global fact.",
          "- Alpha fact. <!-- project: github.com/acme/Alpha -->",
          "- Shared fact. <!-- project: github.com/acme/Alpha; github.com/acme/Beta -->",
          "- Invalid fact. <!-- project: github.com/acme/Beta< -->",
          "- Mixed invalid fact. <!-- project: github.com/acme/Alpha; bad< -->",
          "- Unterminated fact. <!-- project: github.com/acme/Alpha",
        ].join("\n"),
      },
    ];
    const empty = filterProjectScopedCuratedContextFiles({ contextFiles });
    const alpha = filterProjectScopedCuratedContextFiles({
      contextFiles,
      activeProjectKeys: ["github.com/acme/Alpha"],
    });
    const both = filterProjectScopedCuratedContextFiles({
      contextFiles,
      activeProjectKeys: ["github.com/acme/Alpha", "github.com/acme/Beta"],
    });

    expect(empty[0]?.content).toBe("- Global fact.");
    expect(alpha[0]?.content).toContain("Alpha fact");
    expect(alpha[0]?.content).not.toContain("Shared fact");
    expect(alpha[0]?.content).not.toContain("Invalid fact");
    expect(alpha[0]?.content).not.toContain("Mixed invalid fact");
    expect(alpha[0]?.content).not.toContain("Unterminated fact");
    expect(both[0]?.content).toContain("Shared fact");
    expect(both[0]?.content).not.toContain("Invalid fact");
    expect(both[0]?.content).not.toContain("Mixed invalid fact");
    expect(both[0]?.content).not.toContain("Unterminated fact");
  });

  it("leaves context files with missing or blank paths for the prompt renderer to ignore", () => {
    const contextFiles = [
      { path: undefined as unknown as string, content: "Missing path" },
      { path: "   ", content: "Blank path" },
    ];

    expect(filterProjectScopedCuratedContextFiles({ contextFiles })).toEqual(contextFiles);
  });

  it("uses the dedicated curated listing instead of a daily-note-crowded search", async () => {
    runtimeMocks.search.mockResolvedValue(
      Array.from({ length: 100 }, (_, index) => ({
        ...entries[0]!,
        path: `memory/2026-07-${String(index + 1).padStart(2, "0")}.md`,
      })),
    );
    runtimeMocks.listCurated.mockResolvedValue([entries[0]]);
    runtimeMocks.getManager.mockResolvedValue({
      manager: {
        search: runtimeMocks.search,
        listCuratedProjectCandidates: runtimeMocks.listCurated,
      },
    });

    const rendered = (
      await prepareProjectMemoryBootstrap({
        cfg: {},
        agentId: "main",
        activeProjectKeys: ["github.com/OpenClaw/OpenClaw"],
      })
    ).join("\n");
    expect(rendered).toContain("Use the release helper.");
    expect(runtimeMocks.search).not.toHaveBeenCalled();
    expect(runtimeMocks.listCurated).toHaveBeenCalledWith({
      activeProjectKeys: ["github.com/OpenClaw/OpenClaw"],
      limit: 48,
    });
  });

  it("cites legacy chunks by start line from the already-loaded runtime", async () => {
    const lines = await prepareEntries([
      { ...entries[0]!, startLine: 5, endLine: 6, source: undefined as never },
    ]);

    expect(runtimeMocks.getManager).toHaveBeenCalledWith({
      cfg: {},
      agentId: "main",
      purpose: "default",
    });
    expect(runtimeMocks.getProvider).not.toHaveBeenCalled();
    expect(lines).toContain("- Use the release helper. (Source: MEMORY.md#L5)");
  });

  it("does not load the slot plugin when no memory runtime is active", async () => {
    runtimeMocks.legacyRuntime = undefined;

    await expect(prepareEntries([entries[0]!])).resolves.toEqual([]);
    expect(runtimeMocks.getManager).not.toHaveBeenCalled();
    expect(runtimeMocks.getProvider).not.toHaveBeenCalled();
  });
});

describe("native project memory bootstrap", () => {
  beforeEach(() => {
    runtimeMocks.getProvider.mockReset();
    runtimeMocks.listCurated.mockReset();
    runtimeMocks.search.mockReset();
    logMocks.debug.mockReset();
    runtimeMocks.legacyRuntime = undefined;
    runtimeMocks.providerRuntime = { open: vi.fn() };
  });

  const hit = (
    id: string,
    excerpt: string,
    score: number,
    projectKey: string,
    importance: number,
  ): MemorySearchHit => ({
    reference: { providerId: "records", id },
    excerpt,
    score,
    automaticRecall: { eligible: true, projectKeys: [projectKey], importance },
  });
  const entries = [
    hit("release", "Use the release helper.", 0.8, projectKeys[0]!, 8),
    hit("foreign", "Foreign fact.", 0.9, "github.com/example/other", 10),
  ];
  function setProvider(
    overrides: Partial<Omit<MemoryProviderHandle, "capabilities">> & {
      capabilities?: Pick<MemoryProviderHandle["capabilities"], "candidates"> &
        Partial<Pick<MemoryProviderHandle["capabilities"], "projectFilter">>;
    } = {},
  ) {
    const provider = {
      capabilities: { candidates: ["project"] },
      candidates: runtimeMocks.listCurated,
      close: vi.fn(),
      ...overrides,
    };
    runtimeMocks.getProvider.mockResolvedValue({ provider });
    return provider;
  }
  async function prepareEntries(
    candidates: MemorySearchHit[],
    activeProjectKeys = ["github.com/OpenClaw/OpenClaw"],
  ): Promise<string[]> {
    runtimeMocks.listCurated.mockResolvedValue({ hits: candidates });
    setProvider();
    return bootstrap({ activeProjectKeys });
  }

  it("includes only active-project entries and stays inside its budget", async () => {
    const lines = await prepareEntries([
      ...entries,
      {
        ...entries[0]!,
        excerpt: "Untrusted project instruction.",
        automaticRecall: { eligible: false, projectKeys: ["github.com/OpenClaw/OpenClaw"] },
      },
      {
        ...entries[0]!,
        excerpt: "Missing-provenance project instruction.",
        automaticRecall: undefined,
      },
    ]);
    expectProjectSelection(lines);
  });

  it("includes entries from every project retained in the session active set", async () => {
    const rendered = (
      await prepareEntries(entries, ["github.com/example/other", "github.com/OpenClaw/OpenClaw"])
    ).join("\n");
    expect(rendered).toContain("Use the release helper.");
    expect(rendered).toContain("Foreign fact.");
  });

  it("filters every project key without requesting unsupported provider filtering", async () => {
    setProvider({ capabilities: { candidates: ["trigger", "project"], projectFilter: false } });
    runtimeMocks.listCurated.mockResolvedValue({
      hits: [
        {
          ...entries[0]!,
          automaticRecall: { eligible: true, projectKeys: ["alpha", "beta"] },
        },
        {
          ...entries[1]!,
          automaticRecall: { eligible: true, projectKeys: ["alpha", "inactive"] },
        },
      ],
    });

    const rendered = (await bootstrap({ activeProjectKeys: ["alpha", "beta"] })).join("\n");

    expect(runtimeMocks.listCurated).toHaveBeenCalledExactlyOnceWith({
      kind: "project",
      limit: 48,
    });
    expect(rendered).toContain("Use the release helper.");
    expect(rendered).not.toContain("Foreign fact.");
  });

  it("uses the dedicated curated listing instead of a daily-note-crowded search", async () => {
    runtimeMocks.search.mockResolvedValue([]);
    runtimeMocks.listCurated.mockResolvedValue({ hits: [entries[0]] });
    setProvider({
      capabilities: { candidates: ["project"], projectFilter: true },
      search: runtimeMocks.search,
    });

    const rendered = (await bootstrap()).join("\n");
    expect(rendered).toContain("Use the release helper.");
    expect(runtimeMocks.search).not.toHaveBeenCalled();
    expect(runtimeMocks.listCurated).toHaveBeenCalledWith({
      kind: "project",
      activeProjectKeys: ["github.com/OpenClaw/OpenClaw"],
      limit: 48,
    });
  });

  it("skips undeclared project capability and releases its lease", async () => {
    const close = vi.fn();
    setProvider({ capabilities: { candidates: ["trigger"] }, close });
    expect(await bootstrap({ activeProjectKeys: ["alpha"] })).toEqual([]);
    expect(runtimeMocks.listCurated).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("omits optional project recall when provider cleanup rejects", async () => {
    const close = vi.fn().mockRejectedValue(new Error("provider cleanup failed"));
    setProvider({ close });
    runtimeMocks.listCurated.mockResolvedValue({ hits: entries });

    await expect(bootstrap()).resolves.toEqual([]);
    expect(runtimeMocks.listCurated).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(logMocks.debug).toHaveBeenCalledWith(
      expect.stringContaining(
        "project memory cleanup failed for memory-core: Error: provider cleanup failed",
      ),
    );
  });

  it.each(["selection", "close"])(
    "does not inject records after caller authority is revoked during %s",
    async (during) => {
      let active = true;
      const close = vi.fn(async () => {
        if (during === "close") {
          active = false;
        }
      });
      setProvider({ close });
      runtimeMocks.listCurated.mockImplementation(async () => {
        if (during === "selection") {
          active = false;
        }
        return { hits: entries };
      });
      expect(
        await bootstrap({
          context: {
            authority: { kind: "host", operation: "project-test" },
            assertCurrent() {
              if (!active) {
                throw new Error("revoked");
              }
            },
          },
        }),
      ).toEqual([]);
      expect(close).toHaveBeenCalledOnce();
    },
  );
});
