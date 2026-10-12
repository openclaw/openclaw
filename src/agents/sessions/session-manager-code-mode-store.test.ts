import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  bindCodeModeSessionStore,
  createCodeModeSessionStoreAccess,
  disposeCodeModeSessionStore,
} from "../code-mode-session-store.js";
import type { ToolSearchCatalogRef } from "../tool-search-types.js";
import { SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const dir of tempDirs.dirs) {
      await closeOpenClawAgentDatabasesAsync(dir);
      closeOpenClawAgentDatabasesForTest(dir);
    }
    cleanup();
  }),
);

it("replays Code Mode store beyond bounded hydration at the admitted live leaf", async () => {
  const dir = tempDirs.make("openclaw-code-mode-store-");
  const sessionId = "code-mode-store";
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
  const owners: ToolSearchCatalogRef[] = [];
  const bind = (manager: SessionManager) => {
    const owner: ToolSearchCatalogRef = {
      current: {
        entries: [],
        counterScope: "store-test",
        searchCount: 0,
        describeCount: 0,
        callCount: 0,
      },
    };
    owners.push(owner);
    bindCodeModeSessionStore(owner, manager);
    return {
      owner,
      cell: () =>
        createCodeModeSessionStoreAccess(
          { catalogRef: owner, sessionId: manager.getSessionId(), runId: "store-run" },
          new AbortController().signal,
        ),
    };
  };
  const close = (owner: ToolSearchCatalogRef) => {
    owner.current = undefined;
    disposeCodeModeSessionStore(owner);
  };
  let restoreRead = () => {};
  try {
    const manager = await SessionManager.openAsync(scope, dir);
    const initial = bind(manager);
    const first = initial.cell();
    await first.save("old", { retained: true }, true);
    await first.commit();
    const old = manager.getLeafId()!;
    close(initial.owner);
    for (let index = 0; index < 5; index++) {
      await manager.appendMessageAsync({
        role: "user",
        content: `Later turn ${index}`,
        timestamp: index + 1,
      });
    }
    const selected = await SessionManager.openAsync(scope, dir, { maxEvents: 2, maxBytes: 4096 });
    expect(selected.getBranch().some((entry) => entry.id === old)).toBe(false);
    const reopen = vi.spyOn(SessionManager, "openAsync");
    restoreRead = () => reopen.mockRestore();
    const resumed = bind(selected);
    const entered = createDeferred();
    const release = createDeferred();
    let waitForAdmission = true;
    bindCodeModeSessionStore(resumed.owner, selected, async (operation) => {
      if (waitForAdmission) {
        waitForAdmission = false;
        entered.resolve();
        await release.promise;
      }
      return operation();
    });
    const read = resumed.cell().load("old");
    try {
      await awaitGateBeforeSettlement(entered.promise, read, "read missed transcript admission");
      await selected.appendMessageAsync({
        role: "user",
        content: "Already queued turn",
        timestamp: 10,
      });
    } finally {
      release.resolve();
    }
    await expect(read).resolves.toEqual({ value: { retained: true }, networkContent: true });
    const next = resumed.cell();
    await next.save("current", "visible", false);
    await next.commit();
    await expect(resumed.cell().load("current")).resolves.toMatchObject({ value: "visible" });
    await expect(resumed.cell().load("old")).resolves.toMatchObject({ value: { retained: true } });
    expect(reopen).toHaveBeenCalledTimes(1);
    close(resumed.owner);

    reopen.mockResolvedValueOnce(SessionManager.inMemory());
    await expect(bind(selected).cell().load("old")).rejects.toThrow(
      "could not match the active transcript branch",
    );
  } finally {
    restoreRead();
    owners.forEach(close);
  }
});
