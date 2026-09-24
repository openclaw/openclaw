import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createMemorySearchTool } from "../tools.js";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";
import { hasTrigramTokenizerForTests } from "./unicode-query.test-support.js";
import "./test-runtime-mocks.js";

const hasTrigram = hasTrigramTokenizerForTests();

const temporaryRoots = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeAllMemorySearchManagers();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    cleanup();
  }),
);

describe("memory manager Unicode query round trip", () => {
  it.for(
    (["unicode61", "trigram"] as const).flatMap((tokenizer) =>
      ["München", "한국어"].flatMap((word) =>
        (["NFC", "NFD"] as const).map((stored) => ({ tokenizer, word, stored })),
      ),
    ),
  )(
    "retrieves persisted $stored $word memories through the $tokenizer tool",
    async ({ tokenizer, word, stored }, context) => {
      if (tokenizer === "trigram" && !hasTrigram) {
        context.skip("SQLite does not provide the optional trigram tokenizer");
      }
      const workspace = temporaryRoots.make("openclaw-memory-unicode-");
      const storedText = `${word} weather report`.normalize(stored);
      await fs.mkdir(path.join(workspace, "memory"));
      await fs.writeFile(path.join(workspace, "memory", "travel.md"), storedText);
      await fs.writeFile(path.join(workspace, "memory", "control.md"), "quartz reference note");
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspace, "state"));
      const cfg = {
        plugins: { enabled: false },
        memory: {
          search: {
            provider: "none",
            store: { vector: { enabled: false }, fts: { tokenizer } },
            cache: { enabled: false },
          },
        },
        agents: { defaults: { workspace }, list: [{ id: "main", default: true }] },
      } satisfies OpenClawConfig;
      const result = await getMemorySearchManager({ cfg, agentId: "main" });
      const manager = result.manager;
      if (!manager?.sync || !manager.close) {
        throw new Error(result.error ?? "Memory manager is unavailable");
      }
      try {
        await manager.sync({ force: true });
        const db = new DatabaseSync(resolveOpenClawAgentSqlitePath({ agentId: "main" }), {
          readOnly: true,
        });
        try {
          expect(
            db
              .prepare("SELECT text FROM memory_index_chunks WHERE path = ?")
              .all("memory/travel.md"),
          ).toEqual([expect.objectContaining({ text: expect.stringContaining(storedText) })]);
        } finally {
          db.close();
        }
        const search = async (query: string) =>
          (await manager.search(query, { lexicalOnly: true })).map((hit) => hit.path);
        expect(await search("quartz")).toEqual(["memory/control.md"]);
        expect(await search("unrecordedword")).toEqual([]);
        const tool = createMemorySearchTool({
          config: cfg,
          agentId: "main",
          agentSessionKey: "agent:main:main",
        });
        if (!tool) {
          throw new Error("The configured memory_search tool is unavailable");
        }
        const control = await tool.execute("ascii-control", {
          query: "quartz",
          corpus: "memory",
        });
        expect(control.details).toMatchObject({
          results: [expect.objectContaining({ path: "memory/control.md" })],
        });
        for (const form of ["NFC", "NFD"] as const) {
          const query = word.normalize(form);
          const managerResults = await search(query);
          const toolResult = await tool.execute(`unicode-${form}`, { query, corpus: "memory" });
          console.log(
            JSON.stringify({
              tokenizer,
              word,
              stored,
              form,
              managerResults,
              tool: toolResult.details,
            }),
          );
          expect(toolResult.details).toMatchObject({
            results: [expect.objectContaining({ path: "memory/travel.md" })],
          });
          expect(managerResults).toEqual(["memory/travel.md"]);
        }
        expect(await fs.readFile(path.join(workspace, "memory", "travel.md"), "utf8")).toBe(
          storedText,
        );
      } finally {
        await manager.close();
        await closeAllMemorySearchManagers();
        vi.unstubAllEnvs();
      }
    },
  );
});
