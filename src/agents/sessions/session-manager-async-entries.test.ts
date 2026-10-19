import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { persistCompactionBoundaryWithSessionEntryAsync } from "../../config/sessions/session-accessor.sqlite-compaction-runtime.js";
import * as hostTranscriptWriter from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import { SessionManager } from "../../plugin-sdk/agent-sessions.js";
import { withPluginRuntimePluginScope } from "../../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withSessionCompactionPersistenceAsync } from "./session-compaction-persistence.js";
import { sessionManagerOpenCompaction } from "./session-manager-core.js";
import { sessionScope } from "./session-manager-fixtures.test-support.js";
import type { SessionEntry } from "./session-manager-types.js";

afterEach(() => vi.restoreAllMocks());

async function withFixture(
  name: string,
  run: (fixture: {
    target: Parameters<typeof SessionManager.openAsync>[0];
    manager: SessionManager;
    seed: string;
    reopen: () => Promise<SessionManager>;
  }) => Promise<void>,
  guardHostWrites = true,
) {
  await withOpenClawTestState({ label: `async-entry-${name}` }, async (state) => {
    const target = sessionScope(path.join(state.agentDir("main"), "openclaw-agent.sqlite"), name);
    await replaceSessionEntry(target, { sessionId: name, updatedAt: 1 });
    const reopen = () => SessionManager.openAsync(target, state.workspaceDir);
    const manager = await reopen();
    if (guardHostWrites) {
      refuseHostWrites();
    }
    const seed = expectDefined(
      await manager.appendMessageAsync({ role: "user", content: "Seed", timestamp: 1 }),
      "committed seed entry id",
    );
    await run({ target, manager, seed, reopen });
  });
}

const rawEntry = (id: string, parentId: string): Extract<SessionEntry, { type: "custom" }> => ({
  type: "custom",
  customType: id,
  id,
  parentId,
  timestamp: new Date(0).toISOString(),
});
function refuseHostWrites() {
  const refuse = () => {
    throw new Error("Transcript persistence ran on the host");
  };
  vi.spyOn(hostTranscriptWriter, "appendTranscriptEventSnapshotSync").mockImplementation(refuse);
  vi.spyOn(hostTranscriptWriter, "appendTranscriptMessageSnapshotSync").mockImplementation(refuse);
}

function entryCases(manager: SessionManager, seed: string) {
  const data = () => ({ source: "fixture" });
  return Object.entries({
    custom: () => manager.appendCustomEntryAsync("plugin-state", { count: 1 }),
    session_info: () => manager.appendSessionInfoAsync("  Name\ncontinued  "),
    custom_message: () =>
      manager.appendCustomMessageEntryAsync("notice", "Visible custom entry", true, data()),
    reset: () => manager.appendResetBoundaryAsync("reset", seed),
    compaction: () =>
      manager.appendCompactionAsync("Summary", seed, 120, data(), true, undefined, 20),
    label: () => manager.appendLabelChangeAsync(seed, "bookmark"),
  }).map(([type, append]) => ({ type, append }));
}

it("commits every awaited entry family in call order with stable ids, ancestry, and reopened state", async () => {
  await withFixture("family", async ({ manager, seed, reopen }) => {
    const cases = entryCases(manager, seed);
    const settled: string[] = [];
    const ids = await Promise.all(
      cases.map(({ type, append }) =>
        append().then((id) => {
          expect(manager.getEntry(id)).toMatchObject({ id, type });
          settled.push(type);
          return id;
        }),
      ),
    );
    expect(settled).toEqual(cases.map(({ type }) => type));
    expect(new Set(ids).size).toBe(cases.length);
    expect(manager.getEntries().map(({ id, parentId, type }) => ({ id, parentId, type }))).toEqual([
      { id: seed, parentId: null, type: "message" },
      ...ids.map((id, index) => ({
        id,
        parentId: index === 0 ? seed : ids[index - 1],
        type: cases[index]!.type,
      })),
    ]);
    expect(manager.getLeafId()).toBe(ids.at(-1));
    expect(manager.getAppendParentId()).toBe(ids.at(-1));
    expect(manager.getSessionName()).toBe("Name continued");
    expect(manager.getLabel(seed)).toBe("bookmark");
    expect(manager.getBoundaryCount()).toBe(2);
    const reopened = await reopen();
    expect(reopened.getEntries()).toEqual(manager.getEntries());
    expect(reopened.getLeafId()).toBe(manager.getLeafId());
    expect(reopened.getLabel(seed)).toBe("bookmark");
  });
});

it("awaits leaf, branch, raw persistence, and static transcript operations without host writes", async () => {
  await withFixture("navigation", async ({ target, manager, seed, reopen }) => {
    const tail = await manager.appendCustomEntryAsync("tail", { retained: true });
    const selectedLeaf = {
      targetId: seed,
      appendParentId: tail,
      appendMode: "side" as const,
    };
    expect(await manager.appendLeafControlAsync(selectedLeaf)).toMatchObject({
      ...selectedLeaf,
      type: "leaf",
    });
    const leafReopened = await reopen();
    expect(leafReopened.getLeafId()).toBe(seed);
    expect(leafReopened.getAppendParentId()).toBe(tail);
    expect(leafReopened.getAppendMode()).toBe("side");

    const newerUser = expectDefined(
      await leafReopened.appendMessageAsync({ role: "user", content: "Newer turn", timestamp: 2 }),
      "committed newer user id",
    );
    const beforeStaleLeaf = await loadTranscriptEvents(target);
    await expect(manager.appendLeafControlAsync(selectedLeaf)).rejects.toThrow(
      "SQLite transcript changed",
    );
    expect(manager.getLeafId()).toBe(seed);
    expect(manager.getAppendParentId()).toBe(tail);
    expect(await loadTranscriptEvents(target)).toEqual(beforeStaleLeaf);
    await manager.reloadPersistedTranscriptAsync();
    expect(manager.getLeafId()).toBe(newerUser);

    for (const branchTarget of [seed, null]) {
      const directSummary = await manager.branchWithSummaryAsync(branchTarget, "Explicit branch");
      expect(manager.getEntry(directSummary)).toMatchObject({
        type: "branch_summary",
        parentId: branchTarget,
        fromId: branchTarget ?? "root",
      });
      expect(manager.getBranch().map((entry) => entry.id)).toEqual(
        branchTarget === null ? [directSummary] : [seed, directSummary],
      );
      const directReopened = await reopen();
      expect(directReopened.getBranch()).toEqual(manager.getBranch());
    }

    await manager.branchAsync(seed);
    const summary = await manager.branchWithSummaryAsync(
      seed,
      "Selected branch",
      { source: "fixture" },
      true,
    );
    expect(manager.getEntry(summary)).toMatchObject({
      type: "branch_summary",
      parentId: seed,
      fromId: seed,
    });
    expect(manager.getLeafId()).toBe(summary);
    await manager.resetLeafAsync();
    const root = await manager.appendCustomEntryAsync("new-root");
    expect(manager.getEntry(root)?.parentId).toBeNull();

    const raw = { ...rawEntry("raw-entry-id", root), customType: "raw-entry", data: 7 };
    expect(await manager.persistAsync(raw)).toBeUndefined();
    // Low-level persist retains its legacy contract: reload installs the recorded entry.
    await manager.reloadPersistedTranscriptAsync();
    expect(manager.getEntry(raw.id)).toEqual(raw);
    const staticId = await SessionManager.appendMessageToTranscriptAsync(target, {
      role: "custom",
      customType: "static-note",
      content: "Committed static note",
      display: true,
      timestamp: 2,
    });
    const reopened = await reopen();
    expect(reopened.getEntry(staticId)).toMatchObject({
      id: staticId,
      parentId: raw.id,
      type: "message",
      message: { content: "Committed static note" },
    });
    expect(reopened.getLeafId()).toBe(staticId);
  });
});

it("propagates queued write revocation and user/custom commit failures without publishing or falling back", async () => {
  await withFixture("failure", async ({ target, manager, seed }) => {
    const before = await loadTranscriptEvents(target);
    const entries = manager.getEntries();
    const appenders: Array<() => Promise<unknown>> = [
      ...entryCases(manager, seed).map(({ append }) => append),
      () => manager.appendLeafControlAsync({ targetId: seed, appendParentId: seed }),
      () => manager.branchWithSummaryAsync(seed, "Refused branch"),
      () => manager.persistAsync(rawEntry("refused-raw", seed)),
    ];
    for (const append of appenders) {
      let active = true;
      const pending = withSessionTranscriptWriteAssertion(
        target,
        () => {
          if (!active) {
            throw new Error("write owner revoked");
          }
        },
        append,
      );
      active = false;
      await expect(pending).rejects.toThrow("write owner revoked");
    }
    for (const message of [
      { role: "user" as const, content: "Refused user", timestamp: 2 },
      {
        role: "custom" as const,
        customType: "refused-note",
        content: "Refused custom",
        display: true,
        timestamp: 3,
      },
    ]) {
      const commit = vi.fn(() => {
        throw new Error("fresh commit refused");
      });
      await expect(
        manager.appendMessageAsync(message, { beforeFreshMessageCommit: commit }),
      ).rejects.toThrow("fresh commit refused");
      expect(commit).toHaveBeenCalledOnce();
    }
    await expect(
      manager.persistAsync(rawEntry("stale-write", seed), { expectedMutationAt: null }),
    ).rejects.toThrow();
    expect(manager.getEntries()).toEqual(entries);
    expect(await loadTranscriptEvents(target)).toEqual(before);
    const recovered = await manager.appendCustomEntryAsync("after-failure");
    expect(manager.getEntry(recovered)?.parentId).toBe(seed);
  });
});

it("prepares current compaction metadata and retained history in one worker read", async () => {
  await withOpenClawTestState({ label: "compaction-preparation" }, async (state) => {
    const target = sessionScope(
      path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      "compaction-preparation",
    );
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = await SessionManager.openAsync(target, state.workspaceDir);
    const retained = await manager.appendMessageAsync({
      role: "user",
      content: "Retained user content",
      timestamp: 1,
    });
    const opaque = await manager.appendCustomEntryAsync("retained-plugin-data", { value: 42 });
    await replaceSessionEntry(target, {
      sessionId: target.sessionId,
      updatedAt: 2,
      label: "Updated after opening",
      compactionCount: 3,
    });
    await waitForDiagnosticEventsDrained();
    const requests: string[] = [];
    const unsubscribe = onInternalDiagnosticEvent(
      (event) => {
        if (
          event.type === "worker.request" &&
          event.phase === "queued" &&
          event.kind === "sessionTranscript"
        ) {
          requests.push(event.requestClass);
        }
      },
      { include: ["worker.request"] },
    );
    const sql = observeHostDataSql();
    try {
      const prepared = await SessionManager[sessionManagerOpenCompaction](target);
      await waitForDiagnosticEventsDrained();
      expect(requests).toEqual(["task"]);
      expect(sql.queries).toEqual([]);
      expect(prepared.sessionTarget).toEqual(target);
      expect(prepared.entry).toMatchObject({
        sessionId: target.sessionId,
        label: "Updated after opening",
        compactionCount: 3,
      });
      expect(prepared.runtimeEntry).toEqual(prepared.entry);
      expect(prepared.sessionManager.getEntries()).toMatchObject([
        { id: retained, type: "message", message: { content: "Retained user content" } },
        { id: opaque, type: "custom", data: { value: 42 } },
      ]);
    } finally {
      sql.restore();
      unsubscribe();
    }
  });
});

it("keeps the requested entry separate from the persisted compaction window owner", async () => {
  await withOpenClawTestState({ label: "compaction-window-owner" }, async (state) => {
    const requested = {
      agentId: "main",
      sessionId: "window-owner",
      sessionKey: "agent:main:window-alias",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await replaceSessionEntry(requested, {
      sessionId: requested.sessionId,
      updatedAt: 2,
      label: "Alias metadata",
    });
    // A newly created entry claims the shared window, so create its intended owner last.
    const target = sessionScope(requested.storePath, requested.sessionId);
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = await SessionManager.openAsync(target, state.workspaceDir);
    const retained = await manager.appendMessageAsync({
      role: "user",
      content: "Window-owned content",
      timestamp: 1,
    });
    const prepared = await SessionManager[sessionManagerOpenCompaction](requested);
    expect(prepared.sessionTarget).toEqual(target);
    expect(prepared.entry).toMatchObject({ label: "Alias metadata" });
    expect(prepared.runtimeEntry?.label).toBeUndefined();
    expect(prepared.sessionManager.getEntry(retained!)).toMatchObject({
      type: "message",
      message: { content: "Window-owned content" },
    });
  });
});

it("adopts a compaction owner's canonical parent without a host reload", async () => {
  await withFixture(
    "compaction-parent",
    async ({ target, manager, seed: first, reopen }) => {
      const tail = await manager.appendCustomEntryAsync("side-history");
      const sql = observeHostDataSql();
      let boundary: string;
      try {
        boundary = await withSessionCompactionPersistenceAsync(
          manager,
          (prepared) =>
            persistCompactionBoundaryWithSessionEntryAsync(target, {
              prepared: {
                ...prepared,
                event: { ...prepared.event, parentId: first },
                appendIntent: undefined,
              },
              transcriptByteCompactionLatch: {
                activeBytes: 2048,
                sessionId: target.sessionId,
                maxBytes: 1024,
              },
            }),
          () => manager.appendCompactionAsync("Summary", first, 100),
        );
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
      expect(manager.getBranch().map(({ id }) => id)).toEqual([first, boundary]);
      expect(manager.getEntry(tail)).toMatchObject({ id: tail });
      expect(manager.getEntry(boundary)).toMatchObject({ parentId: first, type: "compaction" });
      const reopened = await reopen();
      expect(reopened.getEntries()).toEqual(manager.getEntries());
      expect(reopened.getBranch()).toEqual(manager.getBranch());
    },
    false,
  );
});

it("deduplicates legacy session methods across managers while preserving immediate results", () => {
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  withPluginRuntimePluginScope({ pluginId: "session-compat-family" }, () => {
    for (let index = 0; index < 2; index++) {
      const manager = SessionManager.inMemory();
      const id = manager.appendCustomEntry("legacy", { index });
      expect(manager.getEntry(id)).toMatchObject({ id, customType: "legacy", data: { index } });
      const info = manager.appendSessionInfo("Legacy name");
      expect(manager.getEntry(info)).toMatchObject({ id: info, type: "session_info" });
    }
  });
  expect(warning).toHaveBeenCalledTimes(2);
  for (const method of ["appendCustomEntry", "appendSessionInfo"]) {
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining(
        `Plugin session-compat-family: SessionManager.${method} is deprecated; use ${method}Async`,
      ),
      { code: "DEP_SESSION_PERSISTENCE", type: "DeprecationWarning" },
    );
  }
});
