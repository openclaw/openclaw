import "openclaw/plugin-sdk/compiled-subprocess-testing";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createWorkspaceMemoryFileClient,
  registerAgentWorkspaceAccess,
} from "openclaw/plugin-sdk/agent-workspace-runtime";
import { collectErrorGraphCandidates } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as sessionCorpus from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as diaries from "./dreaming-dreams-file.js";
import { writeDreamsFileAtomic } from "./dreaming-dreams-file.js";
import {
  DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
  SHORT_TERM_LOCK_MAX_ENTRIES,
  SHORT_TERM_LOCK_NAMESPACE,
  memoryCoreWorkspaceStateKey,
  openMemoryCoreStateStore,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntry,
} from "./dreaming-state.js";
import { listMemoryEntryOrigins, recordMemoryEntryOrigins } from "./memory-entry-origins.js";
import { withMemoryMutationAuthority } from "./memory-mutation-authority.js";
import { executeSessionBackfillBatch } from "./session-backfill.js";
import { appendSessionCorpusLines, appendSessionCorpusText } from "./session-ingestion.js";
import { seedCanonicalTranscript } from "./session-ingestion.test-support.js";
import * as promotion from "./short-term-promotion.js";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "./test-helpers.js";

const roots = useAutoCleanupTempDirTracker(afterAll);
let stateDir: string;
let workspace: string;
const namespace = DREAMING_SESSION_INGESTION_FILES_NAMESPACE;
const origin = (entryKey: string) => ({
  entryKey,
  agentId: "main",
  sessionId: "synthetic-session",
  sessionKey: "agent:main:synthetic-session",
  originClass: "owner" as const,
  observedAt: 1_000,
});

beforeAll(async () => {
  stateDir = await fs.realpath(roots.make("openclaw-memory-mutation-authority-"));
  workspace = path.join(stateDir, "workspace");
  await fs.mkdir(workspace);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  await fs.writeFile(path.join(stateDir, "openclaw.json"), "{}\n");
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  await configureMemoryCoreDreamingStateForTests();
  await fs.mkdir(path.dirname(resolveOpenClawAgentSqlitePath({ agentId: "main" })), {
    recursive: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  resetMemoryCoreDreamingStateForTests();
  await closeOpenClawAgentDatabasesAsync(stateDir);
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  vi.unstubAllEnvs();
});

describe("memory mutation authority at durable effects", () => {
  it.each(["diary", "corpus"] as const)(
    "carries the captured %s authority to remote dispatch",
    async (kind) => {
      let captured: (() => void) | undefined;
      const memoryFiles = createWorkspaceMemoryFileClient({
        workspaceDir: workspace,
        remoteWorkspaceDir: "/node",
        signal: new AbortController().signal,
        request: async (_request, _signal, assertCurrent) => {
          captured = assertCurrent;
          return JSON.stringify({ result: 0 });
        },
        subscribe: async () => {},
      });
      const unexpected = async (): Promise<never> => {
        throw new Error("unexpected bridge call");
      };
      const unregister = registerAgentWorkspaceAccess(workspace, {
        memoryFiles,
        bridge: { readFile: unexpected, writeFile: unexpected, stat: unexpected },
      });
      try {
        await withMemoryMutationAuthority(
          () => {},
          async () => {
            if (kind === "diary") {
              await writeDreamsFileAtomic(path.join(workspace, "DREAMS.md"), "entry\n", workspace);
            } else {
              await appendSessionCorpusLines({
                workspaceDir: workspace,
                day: "2026-01-02",
                lines: [
                  {
                    day: "2026-01-02",
                    snippet: "entry",
                    rendered: "entry",
                    provenance: {
                      originClass: "owner",
                      sessionKind: "interactive",
                      observedAt: 1_000,
                    },
                  },
                ],
              });
            }
            expect(captured).toBeTypeOf("function");
            expect(() => captured!()).not.toThrow();
          },
        );
        expect(() => captured!()).toThrow("Memory mutation authority is closed");
      } finally {
        unregister();
      }
    },
  );

  it("keeps a captured SQLite store bound to the invocation that opened it", async () => {
    const store = await withMemoryMutationAuthority(
      () => {},
      async () => {
        const current = openMemoryCoreStateStore<string>({
          namespace: "mutation-authority-fixture",
          maxEntries: 100,
        });
        await current.register("retained-store", "accepted");
        return current;
      },
    );
    await expect(store.register("retained-store", "escaped callback")).rejects.toThrow(
      "Memory mutation authority is closed",
    );
    const reader = openMemoryCoreStateStore<string>({
      namespace: "mutation-authority-fixture",
      maxEntries: 100,
    });
    expect(await reader.lookup("retained-store")).toBe("accepted");
  });

  it.each(["state", "diary", "corpus", "origin"] as const)(
    "rechecks authority after preparation before writing %s",
    async (kind) => {
      const file = path.join(workspace, `${kind}.txt`);
      const state = { namespace, workspaceDir: workspace, key: kind };
      if (kind === "state") {
        await writeMemoryCoreWorkspaceEntry({ ...state, value: "accepted" });
      } else if (kind === "origin") {
        await recordMemoryEntryOrigins({ agentId: "main", origins: [origin("accepted")] });
      } else {
        await fs.writeFile(file, "accepted\n");
      }
      let current = true;
      const failure = await withMemoryMutationAuthority(
        () => {
          if (!current) {
            throw new Error("fixture owner revoked");
          }
        },
        async () => {
          const writing =
            kind === "state"
              ? writeMemoryCoreWorkspaceEntry({ ...state, value: "revoked" })
              : kind === "diary"
                ? writeDreamsFileAtomic(file, "revoked\n")
                : kind === "corpus"
                  ? appendSessionCorpusText(file, "revoked\n")
                  : recordMemoryEntryOrigins({ agentId: "main", origins: [origin("revoked")] });
          current = false;
          await writing;
        },
      ).catch((error: unknown) => error);
      expect(collectErrorGraphCandidates(failure, (record) => [record.cause])).toContainEqual(
        expect.objectContaining({ message: "fixture owner revoked" }),
      );
      if (kind === "state") {
        expect(await readMemoryCoreWorkspaceEntries(state)).toEqual([
          { key: kind, value: "accepted" },
        ]);
      } else if (kind === "origin") {
        expect(
          await listMemoryEntryOrigins({ agentId: "main", entryKeys: ["accepted", "revoked"] }),
        ).toEqual([origin("accepted")]);
      } else {
        expect(await fs.readFile(file, "utf8")).toBe("accepted\n");
      }
    },
  );

  it("settles a revoked backfill and releases its workspace for the next owner", async () => {
    const backfillWorkspace = path.join(workspace, "backfill");
    await fs.mkdir(backfillWorkspace);
    await seedCanonicalTranscript("backfill-source", [
      {
        role: "user",
        content: "Always use green tea for the weekly review.",
        timestamp: "2026-01-02T12:00:00.000Z",
        owner: true,
      },
    ]);
    const list = sessionCorpus.listSessionTranscriptCorpusEntriesForAgent;
    let current = true;
    const discovery = vi
      .spyOn(sessionCorpus, "listSessionTranscriptCorpusEntriesForAgent")
      .mockImplementationOnce(async (...args) => {
        const entries = await list(...args);
        current = false;
        return entries;
      });
    const params = {
      agentId: "main",
      workspaceDir: backfillWorkspace,
      apply: true,
      timezone: "UTC",
      assertCurrent: () => {
        if (!current) {
          throw new Error("fixture owner revoked");
        }
      },
    };
    await expect(executeSessionBackfillBatch(params)).rejects.toThrow("fixture owner revoked");
    discovery.mockRestore();
    const locks = openMemoryCoreStateStore({
      namespace: SHORT_TERM_LOCK_NAMESPACE,
      maxEntries: SHORT_TERM_LOCK_MAX_ENTRIES,
    });
    expect(await locks.lookup(memoryCoreWorkspaceStateKey(backfillWorkspace))).toBeUndefined();
    await expect(
      fs.readFile(path.join(backfillWorkspace, "DREAMS.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await listMemoryEntryOrigins({ agentId: "main", sessionIds: ["backfill-source"] }),
    ).toEqual([]);
    current = true;
    const next = await executeSessionBackfillBatch(params);
    expect(next.result).toMatchObject({
      candidateCount: 1,
      writtenDiaryEntries: 1,
      stagedEntries: 1,
    });
    expect(await fs.readFile(path.join(backfillWorkspace, "DREAMS.md"), "utf8")).toContain(
      "Always use green tea for the weekly review.",
    );
    expect(
      await fs.readFile(
        path.join(backfillWorkspace, "memory", ".dreams", "session-corpus", "2026-01-02.txt"),
        "utf8",
      ),
    ).toContain("Always use green tea for the weekly review.");
    expect(
      await listMemoryEntryOrigins({ agentId: "main", sessionIds: ["backfill-source"] }),
    ).not.toHaveLength(0);
    expect(await locks.lookup(memoryCoreWorkspaceStateKey(backfillWorkspace))).toBeUndefined();
  });

  it("keeps rollback custody until its accepted sibling settles after partial failure", async () => {
    const rollbackWorkspace = path.join(workspace, "rollback");
    await fs.mkdir(rollbackWorkspace);
    const entered = createDeferred<void>();
    const failed = createDeferred<void>();
    const finish = createDeferred<void>();
    const siblingDone = createDeferred<void>();
    const events: string[] = [];
    let siblingEntered = false;
    const removeStaged = promotion.removeGroundedShortTermCandidates;
    vi.spyOn(diaries, "removeBackfillDiaryEntries").mockImplementationOnce(async () => {
      await entered.promise;
      failed.resolve();
      throw new Error("fixture diary removal failed");
    });
    vi.spyOn(promotion, "removeGroundedShortTermCandidates").mockImplementationOnce(
      async (...args) => {
        siblingEntered = true;
        entered.resolve();
        await finish.promise;
        try {
          return await removeStaged(...args);
        } finally {
          events.push("sibling settled");
          siblingDone.resolve();
        }
      },
    );
    let settled = false;
    const operation = executeSessionBackfillBatch({
      agentId: "main",
      workspaceDir: rollbackWorkspace,
      rollback: true,
      assertCurrent: () => {},
    }).then(
      () => {
        throw new Error("Rollback unexpectedly succeeded");
      },
      (error: unknown) => {
        settled = true;
        events.push("rollback rejected");
        return error;
      },
    );
    try {
      await awaitGateBeforeSettlement(
        failed.promise,
        operation,
        "Rollback never reached partial failure",
      );
      expect(settled).toBe(false);
    } finally {
      finish.resolve();
      await Promise.allSettled([operation, ...(siblingEntered ? [siblingDone.promise] : [])]);
    }
    expect(await operation).toMatchObject({ message: "fixture diary removal failed" });
    await siblingDone.promise;
    expect(events).toEqual(["sibling settled", "rollback rejected"]);
  });

  it.each(["hardlink", "parent symlink"] as const)(
    "refuses a guarded corpus append through a %s without changing its target",
    async (kind) => {
      const directory = path.join(workspace, `alias-${kind.replace(" ", "-")}`);
      await fs.mkdir(directory);
      const original = path.join(directory, "original.txt");
      await fs.writeFile(original, "accepted corpus\n");
      let alias: string;
      if (kind === "hardlink") {
        alias = path.join(directory, "alias.txt");
        await fs.link(original, alias);
      } else {
        const link = path.join(workspace, "linked-corpus-directory");
        await fs.symlink(directory, link, "junction");
        alias = path.join(link, "original.txt");
      }
      await expect(
        withMemoryMutationAuthority(
          () => {},
          () => appendSessionCorpusText(alias, "must not append\n"),
        ),
      ).rejects.toThrow();
      expect(await fs.readFile(original, "utf8")).toBe("accepted corpus\n");
    },
  );
});
