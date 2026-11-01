// Memory Core tests cover manager keyword retrieval behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { encodeMemoryEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  requireNativeSqliteDatabase,
  openOpenClawAgentDatabase,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "./embeddings.js";
import * as memoryCpuWorkerRuntime from "./manager-cpu-worker-runtime.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory index", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { provider: providerFixture } = fixture;
  const {
    createConfig: createCfg,
    getFtsSessionManager,
    getPersistentManager,
    getPreparedPersistentManager,
    seedSessionTranscript: seedMemoryIndexSessionTranscript,
  } = fixture;

  async function writeFiles(files: Record<string, string>, root = fixture.paths.memory) {
    for (const [name, body] of Object.entries(files)) {
      const file = path.join(root, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, body);
    }
  }

  function keywordManager(options: Parameters<typeof createCfg>[0] = {}) {
    providerFixture.forceNoProvider = true;
    return getPreparedPersistentManager(createCfg({ provider: "none", minScore: 0, ...options }));
  }

  function modeManager(mode: string, minScore: number) {
    providerFixture.forceNoProvider = mode === "keyword-only";
    return getPersistentManager(
      createCfg({ provider: mode === "keyword-only" ? "none" : undefined, minScore }),
    );
  }

  it("scores a recovered keyword answer outside the top vector candidates", async () => {
    await fs.rename(
      path.join(fixture.paths.memory, "2026-01-12.md"),
      path.join(fixture.paths.memory, "answer.md"),
    );
    await writeFiles({
      "answer.md":
        "Alpha alpha alpha alpha beta. Tag v0.78.42.0 is an annotated tag object 0b1698f pointing at the release commit.",
    });
    const manager = await getPersistentManager(createCfg({ minScore: 0.35, vectorEnabled: false }));
    await manager.sync({ reason: "test" });
    // Seed the candidate boundary directly; indexing 201 files adds no coverage
    // of the score completion between keyword and vector retrieval.
    const db = requireNativeSqliteDatabase(openOpenClawAgentDatabase({ agentId: "main" }).db);
    const insert = db.prepare(
      "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, 'memory/noise.md', 'memory', ?, ?, ?, 'mock-embed', ?, ?, 1)",
    );
    runSqliteImmediateTransactionSync(db, () => {
      for (let index = 0; index < 201; index++) {
        insert.run(
          `noise-${index}`,
          index + 1,
          index + 1,
          `noise-${index}`,
          "Alpha annotated tag object hash created v0",
          encodeMemoryEmbedding([1, 0, 0, 0]),
        );
      }
    });
    const embeddingBatches = providerFixture.embedBatchCalls;
    const query = "Alpha: What is the annotated tag object hash created for v0.78.42.0?";
    const results = await manager.search(query);
    expect(results[0]?.path).toBe("memory/answer.md");
    expect(results[0]?.vectorScore).toBeGreaterThan(0.9);
    expect(results[0]?.textScore).toBeGreaterThan(0.5);
    expect(providerFixture.embedBatchCalls).toBe(embeddingBatches);
    const readVectors = memoryCpuWorkerRuntime.runMemoryVectorFallback;
    using vectorSpy = vi.spyOn(memoryCpuWorkerRuntime, "runMemoryVectorFallback");
    vectorSpy.mockImplementation((...args) =>
      args[1].candidateIds
        ? Promise.reject(new Error("candidate score read failed"))
        : readVectors(...args),
    );
    const degraded = await manager.search(query);
    expect(degraded.some((row) => row.path === "memory/noise.md" && row.vectorScore === 1)).toBe(
      true,
    );
  });

  it("builds FTS index and returns search results when no embedding provider is available", async () => {
    const manager = await keywordManager({ minScore: 0.35 });
    if (!manager.status().fts?.available) {
      return;
    }

    await writeFiles({ "2026-01-12.md": "# Log\nAlpha memory line.\nZebra memory line." });
    await manager.sync({ reason: "test" });

    const status = manager.status();
    expect(status.chunks).toBeGreaterThan(0);
    expect(providerFixture.embedBatchCalls).toBe(0);

    const results = await manager.search("Alpha");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.snippet).toMatch(/Alpha/i);

    const noResults = await manager.search("nonexistent_xyz_keyword");
    expect(noResults.length).toBe(0);
  });

  it.each(["keyword-only", "lexical-only", "hybrid"] as const)(
    "preserves relaxed global lexical recall with active projects in %s search",
    async (mode) => {
      const manager = await modeManager(mode, 0.35);
      expect(manager.status().fts?.available).toBe(true);
      await writeFiles({ "2000-01-01.md": "Quokka archive detail." });
      await manager.sync({ reason: "test" });

      for (const activeProjectKeys of [undefined, ["unrelated-project"]]) {
        const options = {
          maxResults: 1,
          activeProjectKeys,
          lexicalOnly: mode === "lexical-only",
        };
        await expect(manager.search("unfindabletermxyz", options)).resolves.toEqual([]);
        const partials: Array<Awaited<ReturnType<typeof manager.search>> | null> = [];
        const results = await manager.search("quokka", {
          ...options,
          onPartialResults: (snapshot) => partials.push(snapshot),
        });
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
          path: "memory/2000-01-01.md",
          source: "memory",
          snippet: expect.stringContaining("Quokka archive detail."),
        });
        expect(results[0]?.projectKey).toBeUndefined();
        expect(results[0]?.score).toBeGreaterThan(0);
        expect(results[0]?.score).toBeLessThan(0.35);
        if (mode === "hybrid") {
          expect(partials).toEqual([[expect.objectContaining({ path: "memory/2000-01-01.md" })]]);
        }
      }
    },
  );

  it("keeps lexical spare capacity behind strict hybrid hits with active projects", async () => {
    const manager = await getPersistentManager(createCfg({ minScore: 0.35 }));
    expect(manager.status().fts?.available).toBe(true);
    await writeFiles({
      "current.md": "Current quokka detail.",
      "2000-01-01.md": "Current archive detail.",
    });
    await manager.sync({ reason: "test" });

    for (const activeProjectKeys of [undefined, ["unrelated-project"]]) {
      const results = await manager.search("current", { maxResults: 2, activeProjectKeys });
      expect(results.map((entry) => entry.path)).toEqual([
        "memory/current.md",
        "memory/2000-01-01.md",
      ]);
      expect(results[0]?.score).toBeGreaterThanOrEqual(0.35);
      expect(results[1]?.score).toBeLessThan(0.35);
      expect(results[1]).toMatchObject({ vectorScore: 0 });
      const limited = await manager.search("current", { maxResults: 1, activeProjectKeys });
      expect(limited.map((entry) => entry.path)).toEqual(["memory/current.md"]);
    }
  });

  it("keeps the strict threshold for semantic-only hits with active projects", async () => {
    const manager = await getPersistentManager(createCfg({ minScore: 0.35 }));
    expect(manager.status().fts?.available).toBe(true);
    // Low relevance, not age, must keep this semantic match below the threshold.
    await writeFiles({
      "2026-01-12.md": "Beta unrelated detail.",
      "current.md": "Alpha current detail.",
      "2000-01-01.md": "Alpha beta beta beta beta archive detail.",
    });
    await manager.sync({ reason: "test" });

    // The fixture embeds the alpha substring, while FTS requires the complete alphabet token.
    for (const activeProjectKeys of [undefined, ["unrelated-project"]]) {
      const candidates = await manager.search("alphabet", {
        maxResults: 6,
        minScore: 0,
        activeProjectKeys,
      });
      expect(candidates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "memory/2000-01-01.md",
            vectorScore: expect.closeTo(1 / Math.sqrt(17), 5),
            textScore: 0,
          }),
        ]),
      );
      const partials: Array<Awaited<ReturnType<typeof manager.search>> | null> = [];
      const results = await manager.search("alphabet", {
        maxResults: 6,
        activeProjectKeys,
        onPartialResults: (snapshot) => partials.push(snapshot),
      });
      expect(results.map((entry) => entry.path)).toEqual(["memory/current.md"]);
      expect(results[0]?.score).toBeGreaterThanOrEqual(0.35);
      expect(partials).toEqual([]);
    }
  });

  it.each([
    ["project-lantern", "Project lantern project lantern project lantern."],
    ["2020-01-01", "2020 01 01 2020 01 01 2020 01 01"],
  ])("ranks exact stem %s ahead of a body match", async (query, body) => {
    const manager = await keywordManager({ minScore: 0.35 });
    if (!manager.status().fts?.available) {
      return;
    }

    await writeFiles({
      [`${query}.md`]: "Unrelated exact-path body.",
      "body-match.md": body,
    });
    await manager.sync({ reason: "test" });

    expect(await manager.search(query, { maxResults: 1 })).toMatchObject([
      { path: expect.stringContaining(`memory/${query}.md`), score: 1 },
    ]);
  });

  it.each(["keyword-only", "lexical-only", "hybrid"] as const)(
    "preserves exact-file precedence and project scores in %s search",
    async (mode) => {
      const manager = await modeManager(mode, 0);
      expect(manager.status().fts?.available).toBe(true);
      await writeFiles(
        {
          "MEMORY.md": "- Unrelated exact-path body. <!-- project: active-project -->",
          "USER.md":
            "- MEMORY.md reference MEMORY.md reference MEMORY.md reference. <!-- importance: 10 -->",
        },
        fixture.paths.workspace,
      );
      for (let index = 0; index < 20; index += 1) {
        await writeFiles({
          [`noise-${index}.md`]:
            "Unrelated daily record includes useful history and background context.",
        });
      }
      await manager.sync({ reason: "test" });

      for (const [activeProjectKeys, score] of [
        [undefined, 1],
        [["unrelated-project"], 0.9],
        [["active-project"], 1.15],
      ] as const) {
        const partials: Array<Awaited<ReturnType<typeof manager.search>> | null> = [];
        const results = await manager.search("MEMORY.md", {
          maxResults: 1,
          activeProjectKeys: activeProjectKeys ? [...activeProjectKeys] : undefined,
          lexicalOnly: mode === "lexical-only",
          onPartialResults: (snapshot) => partials.push(snapshot),
        });
        expect(results).toHaveLength(1);
        expect(results[0]?.path).toBe("MEMORY.md");
        expect(results[0]?.score).toBeCloseTo(score);
        if (mode === "hybrid") {
          expect(partials).toEqual([[expect.objectContaining({ path: "MEMORY.md", score })]]);
        }
      }
    },
  );

  it.each(["keyword-only", "hybrid"] as const)(
    "keeps qualifying project hits before truncating the %s search window",
    async (mode) => {
      const manager = await modeManager(mode, 1);
      await writeFiles(
        {
          "MEMORY.md": [
            ...Array.from(
              { length: 4 },
              (_, index) =>
                `- MEMORY.md MEMORY.md MEMORY.md reference ${index}. <!-- importance: 10 --> <!-- project: foreign-project -->`,
            ),
            "- MEMORY.md archive context includes history and preferences for the selected workspace. <!-- importance: 1 --> <!-- project: active-project -->",
          ].join("\n"),
        },
        fixture.paths.workspace,
      );
      await manager.sync({ reason: "test" });

      const partials: Array<Awaited<ReturnType<typeof manager.search>> | null> = [];
      const results = await manager.search("MEMORY.md", {
        maxResults: 1,
        activeProjectKeys: ["active-project"],
        onPartialResults: (snapshot) => partials.push(snapshot),
      });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ projectKey: "active-project", score: 1.15 });
      if (mode === "hybrid") {
        expect(partials).toEqual([
          [expect.objectContaining({ projectKey: "active-project", score: 1.15 })],
        ]);
      }
    },
  );

  it("does not let fallback-term filenames consume the candidate cap", async () => {
    const manager = await keywordManager();
    if (!manager.status().fts?.available) {
      return;
    }

    for (let index = 0; index < 5; index += 1) {
      await writeFiles({ [`alpha-${index}/alpha.md`]: "Unrelated path-only candidate." });
    }
    await writeFiles({
      "body-match.md": "Alpha alpha alpha alpha alpha strongest fallback body match.",
    });
    await manager.sync({ reason: "test" });

    const results = await manager.search("alpha gamma", { maxResults: 1, minScore: 0 });
    expect(results).toHaveLength(1);
    expect(results[0]?.path).toContain("memory/body-match.md");
  });

  it("bounds the relaxed keyword candidate set", async () => {
    const manager = await keywordManager();
    const terms = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
    for (const term of terms) {
      for (let index = 0; index < 5; index += 1) {
        await writeFiles({ [`${term}-${index}.md`]: `${term} body ${index}` });
      }
    }
    await manager.sync({ reason: "test" });

    const results = await manager.search(terms.join(" "), { maxResults: 4, minScore: 0 });

    expect(results).toHaveLength(4);
    expect(new Set(results.map((entry) => entry.path)).size).toBe(4);
  });

  it("counts exact candidate headroom by distinct path instead of chunk", async () => {
    const manager = await keywordManager();
    for (let index = 0; index < 200; index += 1) {
      await writeFiles({ [`${index.toString().padStart(3, "0")}/foo.md`]: `foo body ${index}` });
    }
    await manager.sync({ reason: "test" });

    const results = await manager.search("foo.md", { maxResults: 204, minScore: 0 });

    expect(results).toHaveLength(200);
    expect(new Set(results.map((entry) => entry.path)).size).toBe(200);
    expect(results.some((entry) => entry.path === "memory/199/foo.md")).toBe(true);
  });

  it("keeps fixed hybrid ranking when search degrades to keyword-only", async () => {
    const staleMtime = new Date(Date.now() - 90 * 24 * 60 * 60_000);
    const extraPaths: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const suffix = index === 4 ? "z-fresh" : `a-stale-${index}`;
      const dir = path.join(fixture.paths.root, `degraded-decay-cap-${suffix}`);
      await writeFiles({ "beta.md": "Beta equal content candidate." }, dir);
      if (index < 4) {
        await fs.utimes(path.join(dir, "beta.md"), staleMtime, staleMtime);
      }
      extraPaths.push(dir);
    }
    const manager = await getPersistentManager(
      createCfg({ extraPaths, fallback: "none", minScore: 0 }),
    );
    await manager.sync({ reason: "test" });
    const degraded = manager as unknown as {
      provider: EmbeddingProvider | null;
      markLocalEmbeddingProviderDegraded: (err: unknown) => void;
    };
    const provider = degraded.provider;
    if (!provider) {
      throw new Error("Expected a test embedding provider");
    }
    provider.embed = async () => {
      throw providerFixture.createLocalWorkerExitError();
    };
    degraded.markLocalEmbeddingProviderDegraded = () => {
      degraded.provider = null;
    };

    const results = await manager.search("beta.md", { maxResults: 1, minScore: 0 });
    expect(results).toHaveLength(1);
    expect(results[0]?.score).toBe(1);
  });

  it("keeps body relevance for an exact basename beyond the exact candidate cap", async () => {
    const manager = await keywordManager();
    if (!manager.status().fts?.available) {
      return;
    }

    for (let index = 0; index < 205; index += 1) {
      await writeFiles({
        [`readme-dupes/a-${index.toString().padStart(3, "0")}/README.md`]: "Unrelated weak body.",
      });
    }
    await writeFiles({
      "readme-dupes/z-strong/README.md": "README md README md README md strongest body match.",
      "readme-body-only.md": "README md body-only candidate.",
      "README.md.notes": "Unrelated partial path.",
    });
    await manager.sync({ reason: "test" });

    for (const activeProjectKeys of [undefined, ["unrelated-project"]]) {
      const results = await manager.search("README.md", {
        maxResults: 1,
        minScore: 0,
        activeProjectKeys,
      });
      expect(results).toHaveLength(1);
      expect(results[0]?.path).toContain("memory/readme-dupes/z-strong/README.md");
      expect(results[0]?.score).toBe(1);
    }
  });

  it("keeps boosted score ordering for non-exact FTS-only body matches", async () => {
    const manager = await keywordManager();
    if (!manager.status().fts?.available) {
      return;
    }

    await writeFiles({
      "project-memory-notes.md":
        "Project memory notes covering workspace context and retrieval behavior.",
      "notes.md": "Project memory context.",
    });
    await manager.sync({ reason: "test" });

    const results = await manager.search("project memory context", {
      maxResults: 1,
      minScore: 0,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.path).toContain("memory/project-memory-notes.md");
    expect(results[0]?.score).toBeLessThanOrEqual(1);
  });

  it("prefers exact session transcript hits in FTS-only mode", async () => {
    const manager = await getFtsSessionManager();
    if (!manager) {
      return;
    }

    const memoryPath = path.join(fixture.paths.workspace, "MEMORY.md");
    await fs.writeFile(memoryPath, "Project Nebula stale codename: ORBIT-9.\n", "utf8");
    const staleAt = new Date("2020-01-01T00:00:00.000Z");
    await fs.utimes(memoryPath, staleAt, staleAt);

    const now = Date.parse("2026-04-07T15:25:04.113Z");
    await seedMemoryIndexSessionTranscript({
      sessionId: "session-ranking",
      messages: [
        {
          role: "user",
          timestamp: new Date(now - 30_000).toISOString(),
          content: "What is the current Project Nebula codename?",
        },
        {
          role: "assistant",
          timestamp: new Date(now).toISOString(),
          content: "The current Project Nebula codename is ORBIT-10.",
        },
      ],
    });

    await manager.sync({ reason: "test", force: true });
    const results = await manager.search("current Project Nebula codename ORBIT-10", {
      minScore: 0,
      maxResults: 3,
    });

    expect(results[0]?.source).toBe("sessions");
    expect(results[0]?.snippet).toContain("ORBIT-10");
    expect(results[0]?.provenance).toMatchObject({
      originClass: "untrusted",
      sessionKind: "interactive",
    });
  });

  it.each([
    ["记忆", "记忆", false],
    ["UK", "uk", false],
    ["ΔΕ", "δε", false],
    ["ΟΣ", "οσ", false],
    ["记忆", "记忆", true],
  ] as const)("ranks trigram recall for %s/%s (exact hybrid: %s)", async (query, text, exact) => {
    const config = { ftsTokenizer: "trigram", minScore: 0 } as const;
    const manager = await (exact
      ? getPersistentManager(createCfg(config))
      : keywordManager(config));
    if (!manager.status().fts?.available) {
      return;
    }
    const weak = exact ? "a/记忆.md" : "a-weak.md";
    const strong = exact ? "z/记忆.md" : "z-strong.md";
    await writeFiles({ [weak]: `${text} alpha beta gamma`, [strong]: text });
    await manager.sync({ reason: "test" });
    const results = await manager.search(query, { maxResults: 2, minScore: 0 });
    expect(results.map((entry) => entry.path)).toEqual([`memory/${strong}`, `memory/${weak}`]);
    if (!exact) {
      expect(results.every((entry) => entry.score > 0 && entry.score < 1)).toBe(true);
      expect(results.every((entry) => !("hasBodyMatch" in entry))).toBe(true);
    }
  });

  it("recalls an ASCII term embedded in an unspaced Chinese query", async () => {
    const manager = await keywordManager({ ftsTokenizer: "trigram" });
    if (!manager.status().fts?.available) {
      return;
    }
    await writeFiles({
      "deploy.md": "上周我们决定用React部署前端服务",
      "other.md": "午饭吃了面条",
    });
    await manager.sync({ reason: "test" });
    expect(
      (await manager.search("用react部署方案", { maxResults: 5, minScore: 0 })).map(
        (entry) => entry.path,
      ),
    ).toEqual(["memory/deploy.md"]);
  });
});
