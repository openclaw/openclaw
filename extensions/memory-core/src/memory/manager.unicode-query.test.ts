import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createMemorySearchTool } from "../tools.js";
import { runInMemoryTestBackgroundContext } from "./background-context.test-support.js";
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
  it.for(["unicode61", "trigram"] as const)(
    "retrieves decomposed queries through the %s tool",
    async (tokenizer, context) => {
      if (tokenizer === "trigram" && !hasTrigram) {
        context.skip("SQLite does not provide the optional trigram tokenizer");
      }
      const workspace = temporaryRoots.make("openclaw-memory-unicode-");
      const storedText = "München fe\u0301";
      const note = path.join(workspace, "memory", "travel.md");
      await fs.mkdir(path.dirname(note));
      await fs.writeFile(note, storedText);
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
        agents: { defaults: { workspace }, entries: { main: {} } },
      } satisfies OpenClawConfig;
      const result = await getMemorySearchManager({
        cfg,
        agentId: "main",
        runInBackgroundContext: runInMemoryTestBackgroundContext,
      });
      const manager = result.manager;
      if (!manager?.sync || !manager.close) {
        throw new Error(result.error ?? "Memory manager is unavailable");
      }
      try {
        await manager.sync({ force: true });
        const tool = createMemorySearchTool({
          config: cfg,
          agentId: "main",
          agentSessionKey: "agent:main:main",
          runInBackgroundContext: runInMemoryTestBackgroundContext,
        });
        if (!tool) {
          throw new Error("The configured memory_search tool is unavailable");
        }
        const response = await tool.execute("unicode", {
          query: "Mu\u0308nchen",
          corpus: "memory",
        });
        expect(response.details).toMatchObject({
          results: [
            expect.objectContaining({
              path: "memory/travel.md",
              snippet: expect.stringContaining(storedText),
            }),
          ],
        });
        expect(await fs.readFile(note, "utf8")).toBe(storedText);
      } finally {
        await manager.close();
        await closeAllMemorySearchManagers();
        vi.unstubAllEnvs();
      }
    },
  );
});
