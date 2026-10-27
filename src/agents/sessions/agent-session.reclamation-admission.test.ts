import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { CliPluginInvocationResources } from "../../cli/plugin-invocation-resources.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { runWithAsyncWorkResources } from "../../shared/async-work-resources.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { createEnteredGate } from "../entered-gate.test-support.js";
import { extensionFixture, sessionTarget } from "./agent-session-boundary.test-support.js";
import {
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
} from "./agent-session-loop-correctness.test-support.js";
import { SessionManager } from "./session-manager.js";

const checkpoint = vi.hoisted(() => ({ startForeground: undefined as (() => void) | undefined }));

vi.mock(
  "../../config/sessions/session-accessor.sqlite-reclamation-worker.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../config/sessions/session-accessor.sqlite-reclamation-worker.js")
      >();
    return {
      ...actual,
      withSqliteReclamationWorker: ((options, claim, run, ...rest) =>
        actual.withSqliteReclamationWorker(
          options,
          claim,
          async (worker) => {
            const originalRun = worker.run.bind(worker);
            const spy = vi.spyOn(worker, "run").mockImplementation((params) => {
              let started = false;
              return originalRun({
                ...params,
                withWriteAdmission: (admit, diagnostics) =>
                  params.withWriteAdmission(async (refusal) => {
                    if (params.plan.kind === "entry" && !started) {
                      started = true;
                      checkpoint.startForeground?.();
                    }
                    return admit(refusal);
                  }, diagnostics),
              });
            });
            try {
              return await run(worker);
            } finally {
              spy.mockRestore();
            }
          },
          ...rest,
        )) satisfies typeof actual.withSqliteReclamationWorker,
    };
  },
);

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

let storePath: string;
const targetFor = (sessionId: string) => sessionTarget(storePath, sessionId);

beforeEach(() => {
  const root = tempDirs.make("openclaw-session-reclamation-transcript-");
  storePath = path.join(root, "agents", "main", "sessions", "sessions.json");
});

afterEach(async () => {
  checkpoint.startForeground = undefined;
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
});

registerAgentSessionLoopTestLifecycle();

it("retains a void extension message until its durable append and publication precede disposal", async () => {
  const target = targetFor("extension-custody");
  await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: Date.now() });
  const cwd = path.dirname(storePath);
  const events: string[] = [];
  const payload = { customType: "custody-proof", content: "durable message" };
  const { eventBus, resourceLoader } = await extensionFixture(cwd, (api) => {
    api.registerCommand("custody-send", {
      handler: async () => {
        api.sendMessage({ ...payload, display: true });
        events.push("command-returned");
      },
    });
  });
  const { session } = await createTestSession({
    sessionManager: SessionManager.open(target, cwd),
    resourceLoader,
  });
  session.subscribe((event) => {
    if (
      (event.type === "message_start" || event.type === "message_end") &&
      event.message.role === "custom"
    ) {
      events.push(event.type);
    }
  });
  const gate = createEnteredGate();
  // The blocker belongs to another writer, not the extension's managed work.
  const writer = runOpenClawAgentWorkerWrite(
    toDatabaseOptions(resolveSqliteReadScope(target)),
    gate.wait,
  );
  await gate.entered;
  const owner = new CliPluginInvocationResources();
  const readDurableMessages = () =>
    SessionManager.open(target, cwd)
      .getEntries()
      .filter((entry) => entry.type === "custom_message");
  let durableAtRelease: ReturnType<typeof readDurableMessages> | undefined;
  try {
    await owner.run(() =>
      runWithAsyncWorkResources(async (onAcquired) => {
        onAcquired({
          release: () => {
            durableAtRelease = readDurableMessages();
            events.push("resource-released");
            session.dispose();
          },
        });
        await session.prompt("/custody-send");
      }),
    );
    const closing = owner.release();
    await nextTurn();
    expect(events).toEqual(["command-returned"]);
    gate.release();
    await Promise.all([writer, closing]);
    expect(events).toEqual([
      "command-returned",
      "message_start",
      "message_end",
      "resource-released",
    ]);
    expect(durableAtRelease).toMatchObject([payload]);
  } finally {
    gate.release();
    await writer;
    await owner.release();
    eventBus.clear();
  }
});

it("queues an unrelated custom-message append behind reclamation writer admission", async () => {
  const sessionKey = "agent:main:reclamation-transcript";
  const sessionId = "reclamation-transcript";
  // Automatic retention remains enabled while the real archive Worker starts.
  const updatedAt = Date.now();
  const unrelated = targetFor("transcript-writer");
  await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt });
  await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [
    { type: "session", id: sessionId, content: "retire this session" },
  ]);
  await replaceSessionEntry(unrelated, { sessionId: unrelated.sessionId, updatedAt });
  const { session } = await createTestSession({
    sessionManager: SessionManager.open(unrelated, path.dirname(storePath)),
  });
  let write: Promise<void> | undefined;
  const published: string[] = [];
  const payload = { customType: "admission-proof", content: "durable message" };
  let publishedDuringCommitAuthorization: string[] | undefined;
  session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "custom") {
      published.push(event.message.customType);
    }
  });
  checkpoint.startForeground = vi.fn(() => {
    const message = { ...payload, display: true };
    write = session.sendCustomMessage(message);
    void write.catch(() => {});
    message.content = "Caller changed the input after submission.";
    // Publication must wait for this operation's writer admission to settle.
    publishedDuringCommitAuthorization = [...published];
  });
  const deletion = await deleteSessionEntryLifecycle({
    archiveTranscript: true,
    commitGuard: () => {},
    storePath,
    target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
  }).catch((error: unknown) => error);
  const outcomes = await Promise.allSettled(write ? [write] : []);
  expect(deletion).toMatchObject({ deleted: true });
  expect(outcomes).toEqual([{ status: "fulfilled", value: undefined }]);
  expect(publishedDuringCommitAuthorization).toEqual([]);
  expect(published).toEqual(["admission-proof"]);
  expect(await loadTranscriptEvents(unrelated)).toContainEqual(
    expect.objectContaining({ type: "custom_message", ...payload }),
  );
  expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
  expect(loadSessionEntry(unrelated)).toMatchObject({ sessionId: unrelated.sessionId });
});
