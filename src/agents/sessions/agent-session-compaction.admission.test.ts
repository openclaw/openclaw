import { realpathSync } from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { agentSessionSetContextReplacementHook } from "./agent-session-compaction.js";
import {
  createAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import type { ExtensionEvent } from "./extensions/types.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawAgentDatabasesForTest());
registerAgentSessionLoopTestLifecycle();

type BeforeCompactionEvent = Extract<ExtensionEvent, { type: "session_before_compact" }>;

function seedHistory(manager: SessionManager): string {
  const firstUser = manager.appendMessage(makeUserMessage("old prompt", 1));
  manager.appendMessage(createAssistant(testModel, [{ type: "text", text: "old answer" }]));
  manager.appendMessage(makeUserMessage("recent prompt", 3));
  manager.appendMessage(createAssistant(testModel, [{ type: "text", text: "recent answer" }]));
  return firstUser;
}

function compactionResult(event: BeforeCompactionEvent) {
  return {
    compaction: {
      summary: "condensed history",
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    },
  };
}

const settings = () =>
  SettingsManager.inMemory({
    compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 1 },
    retry: { enabled: false },
  });

describe("context replacement after write admission", () => {
  it.each(["compaction", "tree"] as const)(
    "does not publish a cancelled %s while waiting for the writer",
    async (operation) => {
      const root = realpathSync(tempDirs.make("openclaw-context-admission-"));
      const target = {
        agentId: "main",
        sessionId: "context-admission",
        sessionKey: "agent:main:context-admission",
        storePath: path.join(root, "sessions.json"),
      };
      await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
      const manager = SessionManager.open(target, root);
      const firstUser = seedHistory(manager);
      const summaryReady = createDeferred();
      const published: string[] = [];
      const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
        [
          "session_before_compact",
          [
            async (event) => {
              summaryReady.resolve();
              return compactionResult(event as BeforeCompactionEvent);
            },
          ],
        ],
        [
          "session_before_tree",
          [
            async () => {
              summaryReady.resolve();
              return { summary: { summary: "abandoned branch" } };
            },
          ],
        ],
        [
          "session_compact",
          [
            async () => {
              published.push("compaction");
            },
          ],
        ],
        [
          "session_tree",
          [
            async () => {
              published.push("tree");
            },
          ],
        ],
      ]);
      const { session } = await createTestSession({
        sessionManager: manager,
        settingsManager: settings(),
        resourceLoader: createResourceLoader(handlers),
      });
      const before = await loadTranscriptEvents(target);
      const messagesBefore = [...session.messages];
      const release = createDeferred();
      const entered = createDeferred();
      const reservation = runOpenClawAgentWriteAdmission(
        toDatabaseOptions(resolveSqliteReadScope(target)),
        async () => {
          entered.resolve();
          await release.promise;
        },
      );
      await entered.promise;
      const work =
        operation === "compaction"
          ? session.compact()
          : session.navigateTree(firstUser, { summarize: true, label: "cancelled branch" });
      const outcome = work.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      try {
        await summaryReady.promise;
        // The summary continuations reach the held writer before cancellation.
        await nextTurn();
        if (operation === "compaction") {
          session.abortCompaction();
        } else {
          session.abortBranchSummary();
        }
        release.resolve();
        const result = await outcome;
        if (operation === "compaction") {
          expect(result).toMatchObject({
            status: "rejected",
            error: new Error("Compaction cancelled"),
          });
        } else {
          expect(result).toMatchObject({
            status: "fulfilled",
            value: { cancelled: true, aborted: true },
          });
        }
        expect(await loadTranscriptEvents(target)).toEqual(before);
        expect(session.messages).toEqual(messagesBefore);
        expect(published).toEqual([]);
      } finally {
        release.resolve();
        await Promise.allSettled([reservation, work]);
      }
    },
  );

  it("does not adopt a successor's context authority after in-memory summarization", async () => {
    const manager = SessionManager.inMemory();
    seedHistory(manager);
    const summaryReady = createDeferred();
    const release = createDeferred();
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      [
        "session_before_compact",
        [
          async (event) => {
            summaryReady.resolve();
            await release.promise;
            return compactionResult(event as BeforeCompactionEvent);
          },
        ],
      ],
    ]);
    const { session } = await createTestSession({
      sessionManager: manager,
      settingsManager: settings(),
      resourceLoader: createResourceLoader(handlers),
    });
    const before = manager.getEntries();
    const messagesBefore = [...session.messages];
    const accounted: string[] = [];
    session[agentSessionSetContextReplacementHook](
      () => accounted.push("original"),
      () => {},
    );
    const work = session.compact();
    const settled = work.catch((error: unknown) => error);
    try {
      await summaryReady.promise;
      session[agentSessionSetContextReplacementHook](
        () => accounted.push("successor"),
        () => {},
      );
      release.resolve();
      expect(await settled).toEqual(new Error("Compaction cancelled"));
      expect(manager.getEntries()).toEqual(before);
      expect(session.messages).toEqual(messagesBefore);
      expect(accounted).toEqual([]);
    } finally {
      release.resolve();
      await settled;
    }
  });
});
