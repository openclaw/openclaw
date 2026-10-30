import path from "node:path";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  bindCodeModeSessionStore,
  createCodeModeSessionStoreAccess,
  disposeCodeModeSessionStore,
} from "../code-mode-session-store.js";
import type { ToolSearchCatalogRef } from "../tool-search-types.js";
import { sessionScope } from "./session-manager-fixtures.test-support.js";
import { SessionManager } from "./session-manager.js";

it.each(["durable", "incognito"])(
  "replays %s Code Mode store beyond bounded hydration at the admitted live leaf",
  async (storage) => {
    await withOpenClawTestState({ label: "code-mode-store" }, async (state) => {
      const dir = state.root;
      const sessionId = "code-mode-store";
      const scope = sessionScope(path.join(dir, "sessions.json"), sessionId);
      if (storage === "incognito") {
        scope.sessionKey = `agent:main:dashboard:incognito-${sessionId}`;
      } else {
        await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
      }
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
      const expectValue = (binding: ReturnType<typeof bind>, key: string, value: unknown) =>
        expect(binding.cell().load(key)).resolves.toMatchObject({ value });
      const expectMissing = (binding: ReturnType<typeof bind>, key: string) =>
        expect(binding.cell().load(key)).resolves.toEqual({ networkContent: false });
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
          await manager.appendMessageAsync(makeUserMessage(`Later turn ${index}`, index + 1));
        }
        const selected = await SessionManager.openAsync(scope, dir, {
          maxEvents: 2,
          maxBytes: 4096,
        });
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
          await awaitGateBeforeSettlement(
            entered.promise,
            read,
            "read missed transcript admission",
          );
          await selected.appendMessageAsync(makeUserMessage("Already queued turn", 10));
        } finally {
          release.resolve();
        }
        await expect(read).resolves.toEqual({ value: { retained: true }, networkContent: true });
        const next = resumed.cell();
        await next.save("current", "visible", false);
        await next.commit();
        await expectValue(resumed, "current", "visible");
        await expectValue(resumed, "old", { retained: true });
        expect(reopen).not.toHaveBeenCalled();
        close(resumed.owner);

        await selected.branchAsync(old);
        const branched = bind(selected);
        await expectValue(branched, "old", { retained: true });
        await expectMissing(branched, "current");
        const branchCell = branched.cell();
        await branchCell.save("branch", "selected", false);
        await branchCell.commit();
        close(branched.owner);
        const kept = await selected.appendMessageAsync(makeUserMessage("Keep this turn", 11));
        await selected.appendCompactionAsync("Earlier turns summarized", kept!, 100);
        if (storage === "durable") {
          await waitForSessionTranscriptProjection(scope);
        }
        const compacted = bind(
          await SessionManager.openAsync(scope, dir, { maxEvents: 2, maxBytes: 4096 }),
        );
        await expectValue(compacted, "old", { retained: true });
        await expectValue(compacted, "branch", "selected");
        await expectMissing(compacted, "current");
        close(compacted.owner);

        const retired = bind(selected);
        await withOwnedSessionTranscriptWrites(
          {
            sessionTarget: scope,
            withTranscriptWrite: async (operation) => operation(),
            assertCommitAllowed: () => {
              throw new Error("retired transcript authority");
            },
          },
          async () => {
            await expect(retired.cell().load("old")).rejects.toThrow(
              "retired transcript authority",
            );
          },
        );
        close(retired.owner);

        const missingLeaf = vi.spyOn(selected, "getLeafId").mockReturnValue("missing-leaf");
        try {
          await expect(bind(selected).cell().load("old")).rejects.toThrow(
            "could not match the active transcript branch",
          );
        } finally {
          missingLeaf.mockRestore();
        }
      } finally {
        restoreRead();
        owners.forEach(close);
      }
    });
  },
);
