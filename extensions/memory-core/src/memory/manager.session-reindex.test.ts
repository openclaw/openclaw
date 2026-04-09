import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MemoryIndexManager } from "./index.js";
import { getRequiredMemoryIndexManager } from "./test-manager-helpers.js";

describe("memory manager session reindex gating", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-session-reindex-"));
  });

  beforeEach(async () => {
    workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Hello memory.");
    indexPath = path.join(workspaceDir, "index.sqlite");
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("keeps session syncing enabled for full reindexes triggered from session-start/watch", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: false } },
            cache: { enabled: false },
            query: { minScore: 0, hybrid: { enabled: false } },
            chunking: { tokens: 4000, overlap: 0 },
            experimental: { sessionMemory: true },
            sources: ["memory", "sessions"],
            sync: { watch: false, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    manager = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });

    const shouldSyncSessions = (
      manager as unknown as {
        shouldSyncSessions: (
          params?: { reason?: string; force?: boolean },
          needsFullReindex?: boolean,
        ) => boolean;
      }
    ).shouldSyncSessions.bind(manager);

    expect(shouldSyncSessions({ reason: "session-start" }, true)).toBe(true);
    expect(shouldSyncSessions({ reason: "watch" }, true)).toBe(true);
    expect(shouldSyncSessions({ reason: "session-start" }, false)).toBe(false);
    expect(shouldSyncSessions({ reason: "watch" }, false)).toBe(false);
  });
});
