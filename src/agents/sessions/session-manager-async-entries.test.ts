import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import * as hostTranscriptWriter from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { SessionManager } from "../../plugin-sdk/agent-sessions.js";
import { readGlobalSingleton } from "../../shared/global-singleton.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { SessionEntry } from "./session-manager-types.js";

afterEach(() => vi.restoreAllMocks());

async function openFixture(state: OpenClawTestState, name: string) {
  const target = {
    agentId: "main",
    sessionId: name,
    sessionKey: `agent:main:${name}`,
    storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
  };
  await replaceSessionEntry(target, { sessionId: name, updatedAt: 1 });
  return { target, manager: await SessionManager.openAsync(target, state.workspaceDir) };
}

function refuseHostWrites() {
  const refuse = () => {
    throw new Error("Transcript persistence ran on the host");
  };
  vi.spyOn(hostTranscriptWriter, "appendTranscriptEventSnapshotSync").mockImplementation(refuse);
  vi.spyOn(hostTranscriptWriter, "appendTranscriptMessageSnapshotSync").mockImplementation(refuse);
}

function entryCases(manager: SessionManager, seed: string) {
  return [
    { type: "custom", append: () => manager.appendCustomEntryAsync("plugin-state", { count: 1 }) },
    { type: "session_info", append: () => manager.appendSessionInfoAsync("  Name\ncontinued  ") },
    {
      type: "custom_message",
      append: () =>
        manager.appendCustomMessageEntryAsync("notice", "Visible custom entry", true, {
          source: "fixture",
        }),
    },
    { type: "reset", append: () => manager.appendResetBoundaryAsync("reset", seed) },
    {
      type: "compaction",
      append: () =>
        manager.appendCompactionAsync(
          "Summary",
          seed,
          120,
          { source: "fixture" },
          true,
          undefined,
          20,
        ),
    },
    { type: "label", append: () => manager.appendLabelChangeAsync(seed, "bookmark") },
  ];
}

it("commits every awaited entry family in call order with stable ids, ancestry, and reopened state", async () => {
  await withOpenClawTestState({ label: "async-entry-family" }, async (state) => {
    const { target, manager } = await openFixture(state, "family");
    refuseHostWrites();
    const seed = expectDefined(
      await manager.appendMessageAsync({ role: "user", content: "Seed", timestamp: 1 }),
      "committed seed entry id",
    );
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
    const reopened = await SessionManager.openAsync(target, state.workspaceDir);
    expect(reopened.getEntries()).toEqual(manager.getEntries());
    expect(reopened.getLeafId()).toBe(manager.getLeafId());
    expect(reopened.getLabel(seed)).toBe("bookmark");
  });
});

it("awaits leaf, branch, raw persistence, and static transcript operations without host writes", async () => {
  await withOpenClawTestState({ label: "async-entry-navigation" }, async (state) => {
    const { target, manager } = await openFixture(state, "navigation");
    refuseHostWrites();
    const seed = expectDefined(
      await manager.appendMessageAsync({ role: "user", content: "Seed", timestamp: 1 }),
      "committed seed entry id",
    );
    const tail = await manager.appendCustomEntryAsync("tail", { retained: true });
    const leaf = await manager.appendLeafControlAsync({
      targetId: seed,
      appendParentId: tail,
      appendMode: "side",
    });
    expect(leaf).toMatchObject({
      type: "leaf",
      targetId: seed,
      appendParentId: tail,
      appendMode: "side",
    });
    const leafReopened = await SessionManager.openAsync(target, state.workspaceDir);
    expect(leafReopened.getLeafId()).toBe(seed);
    expect(leafReopened.getAppendParentId()).toBe(tail);
    expect(leafReopened.getAppendMode()).toBe("side");

    const newerUser = expectDefined(
      await leafReopened.appendMessageAsync({ role: "user", content: "Newer turn", timestamp: 2 }),
      "committed newer user id",
    );
    const beforeStaleLeaf = await loadTranscriptEvents(target);
    await expect(
      manager.appendLeafControlAsync({ targetId: seed, appendParentId: tail, appendMode: "side" }),
    ).rejects.toThrow("SQLite transcript changed");
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
      const directReopened = await SessionManager.openAsync(target, state.workspaceDir);
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

    const raw: SessionEntry = {
      type: "custom",
      customType: "raw-entry",
      data: 7,
      id: "raw-entry-id",
      parentId: root,
      timestamp: new Date(0).toISOString(),
    };
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
    const reopened = await SessionManager.openAsync(target, state.workspaceDir);
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
  await withOpenClawTestState({ label: "async-entry-failure" }, async (state) => {
    const { target, manager } = await openFixture(state, "failure");
    refuseHostWrites();
    const seed = expectDefined(
      await manager.appendMessageAsync({ role: "user", content: "Seed", timestamp: 1 }),
      "committed seed entry id",
    );
    const before = await loadTranscriptEvents(target);
    const entries = manager.getEntries();
    const appenders: Array<() => Promise<unknown>> = [
      ...entryCases(manager, seed).map(({ append }) => append),
      () => manager.appendLeafControlAsync({ targetId: seed, appendParentId: seed }),
      () => manager.branchWithSummaryAsync(seed, "Refused branch"),
      () =>
        manager.persistAsync({
          type: "custom",
          customType: "refused-raw",
          id: "refused-raw",
          parentId: seed,
          timestamp: new Date(0).toISOString(),
        }),
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
      manager.persistAsync(
        {
          type: "custom",
          customType: "stale-write",
          id: "stale-write",
          parentId: seed,
          timestamp: new Date(0).toISOString(),
        },
        { expectedMutationAt: null },
      ),
    ).rejects.toThrow();
    expect(manager.getEntries()).toEqual(entries);
    expect(await loadTranscriptEvents(target)).toEqual(before);
    const recovered = await manager.appendCustomEntryAsync("after-failure");
    expect(manager.getEntry(recovered)?.parentId).toBe(seed);
  });
});

it("warns once per synchronous method across manager instances while preserving compatibility results", () => {
  const methods = [
    ["appendCustomEntry", "appendCustomEntryAsync"],
    ["appendSessionInfo", "appendSessionInfoAsync"],
  ] as const;
  const warned = readGlobalSingleton(Symbol.for("openclaw.sessionPersistenceDeprecations"));
  if (!(warned instanceof Set)) {
    throw new Error("Expected the process-wide session persistence warning registry");
  }
  // Shared Vitest workers retain earlier files' process-wide warning budgets.
  const priorWarnings = methods.map(([method]) => {
    const key = `SessionManager.${method}`;
    return { key, existed: warned.delete(key) };
  });
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  try {
    for (let index = 0; index < 2; index++) {
      const manager = SessionManager.inMemory();
      const id = manager.appendCustomEntry("legacy", { index });
      expect(manager.getEntry(id)).toMatchObject({ id, customType: "legacy", data: { index } });
      const info = manager.appendSessionInfo("Legacy name");
      expect(manager.getEntry(info)).toMatchObject({ id: info, type: "session_info" });
    }
    for (const [method, replacement] of methods) {
      const calls = warning.mock.calls.filter(([message]) =>
        String(message).startsWith(`SessionManager.${method} is deprecated;`),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toContain(replacement);
      expect(calls[0]?.[1]).toMatchObject({
        code: "DEP_SESSION_PERSISTENCE",
        type: "DeprecationWarning",
      });
    }
  } finally {
    warning.mockRestore();
    for (const { key, existed } of priorWarnings) {
      if (existed) {
        warned.add(key);
      } else {
        warned.delete(key);
      }
    }
  }
});
