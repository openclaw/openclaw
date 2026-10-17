import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as sessionStore from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  observeHostDataSql,
  useSessionStoreTempDirs,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { isJsonObject, type CodexServerNotification } from "./protocol.js";
import { projectCodexSessionWarning } from "./session-warnings.js";

const dirs = useSessionStoreTempDirs(afterAll, "codex-chat-warnings-");
const plugins = { other: { retained: true }, codex: { unrelated: true } };
const summary = "Ignoring unknown `features` requirement `ultrafast_mode` from Example policy";
const warning = { method: "configWarning", params: { summary } };
const sessionBase = {
  agentId: "main",
  sessionKey: "agent:main:warning-chat",
  sessionId: "chat-session",
  expectedLifecycleRevision: "generation-1",
};
let session = { ...sessionBase, storePath: "" };
type Session = typeof session;
const project = vi.fn(async () => true);

afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  session = { ...sessionBase, storePath: path.join(dirs.make(), "sessions.json") };
  project.mockClear();
  await sessionStore.upsertSessionEntry({
    ...session,
    entry: {
      sessionId: session.sessionId,
      lifecycleRevision: session.expectedLifecycleRevision,
      updatedAt: 1,
      pluginExtensions: plugins,
    },
  });
});

function deliver(
  notification: CodexServerNotification = warning,
  target: Session = session,
  threadId = "thread-1",
  projectWarning: () => Promise<boolean> = project,
) {
  return projectCodexSessionWarning({
    session: target,
    project: projectWarning,
    notification,
    threadId,
    assertCurrent: () => {},
  });
}

function receipt() {
  return sessionStore.getSessionEntry(session)?.pluginExtensions?.codex?.warningReceipts;
}

function configWarning(params: Record<string, unknown>): CodexServerNotification {
  return { method: "configWarning", params: { summary, ...params } };
}

it("deduplicates separate receipts across native threads and reopened session storage", async () => {
  const before = sessionStore.getSessionEntry(session);
  await Promise.all(Array.from({ length: 4 }, () => deliver(structuredClone(warning))));
  await deliver();
  expect(project).toHaveBeenCalledTimes(1);
  const persisted = sessionStore.getSessionEntry(session);
  expect(persisted).toMatchObject({ updatedAt: before?.updatedAt, pluginExtensions: plugins });
  expect(JSON.stringify(persisted?.pluginExtensions?.codex?.warningReceipts)).not.toContain(
    summary,
  );
  await closeOpenClawAgentDatabasesAsync(path.dirname(session.storePath));
  await deliver(
    { method: "warning", params: { threadId: "replacement-thread", message: summary } },
    { ...session },
    "replacement-thread",
  );
  expect(project).toHaveBeenCalledTimes(1);
});

it("projects distinct warnings off-thread without deduplicating Guardian events", async () => {
  await deliver();
  const sql = observeHostDataSql();
  onTestFinished(() => sql.restore());
  const distinct: CodexServerNotification[] = [
    warning,
    configWarning({ summary: summary.replace("ultrafast_mode", "security_policy") }),
    { method: "warning", params: { message: "Conversation state could not be saved." } },
    configWarning({ details: "Additional action required" }),
    configWarning({ path: "/example/policy.toml" }),
  ];
  for (const notification of distinct) {
    await deliver(notification);
    await deliver(notification);
  }
  expect(project).toHaveBeenCalledTimes(distinct.length + 2);
  const guardian = {
    method: "guardianWarning",
    params: { threadId: "thread-1", message: summary },
  };
  await deliver(guardian);
  await deliver(guardian);
  expect(project).toHaveBeenCalledTimes(distinct.length + 4);
  expect(sql.queries).toEqual([]);
});

it.each(["success", "throw", "unacknowledged"] as const)(
  "serializes overlapping chat projection and retries %s appropriately",
  async (outcome) => {
    const started = createDeferred<void>();
    const finish = createDeferred<boolean>();
    const first = deliver(warning, session, "thread-1", async () => {
      started.resolve();
      return await finish.promise;
    });
    const settled = first.then(
      () => undefined,
      (error: unknown) => error,
    );
    await started.promise;
    const next = deliver(structuredClone(warning), { ...session }, "replacement-thread");
    expect(project).not.toHaveBeenCalled();
    if (outcome === "throw") {
      finish.reject(new Error("projection failed"));
    } else {
      finish.resolve(outcome === "success");
    }
    const result = await settled;
    if (outcome === "throw") {
      expect(result).toMatchObject({ message: "projection failed" });
    }
    await next;
    await deliver();
    expect(project).toHaveBeenCalledTimes(outcome === "success" ? 0 : 1);
  },
);

it("allows independent chats and same-id reset generations their own first warning", async () => {
  await deliver();
  const child = { ...session, sessionKey: "agent:main:child", sessionId: "child-session" };
  const parentEntry = sessionStore.getSessionEntry(session);
  if (!parentEntry) {
    throw new Error("missing seeded parent session");
  }
  await sessionStore.upsertSessionEntry({
    ...child,
    entry: { ...parentEntry, sessionId: child.sessionId, updatedAt: 1 },
  });
  await deliver(warning, child);
  expect(project).toHaveBeenCalledTimes(2);
  await sessionStore.patchSessionEntry({
    ...session,
    update: () => ({ lifecycleRevision: "generation-2" }),
    skipMaintenance: true,
  });
  // A stale attempt must not consume the successor's first notification.
  await deliver();
  expect(project).toHaveBeenCalledTimes(2);
  const successor = { ...session, expectedLifecycleRevision: "generation-2" };
  await deliver(warning, successor);
  await deliver(warning, successor);
  expect(project).toHaveBeenCalledTimes(3);
});

it("retains acknowledged receipts at capacity and fails open for new distinct warnings", async () => {
  await deliver();
  await sessionStore.patchSessionEntry({
    ...session,
    skipMaintenance: true,
    update: (entry) => {
      const pluginExtensions = structuredClone(entry.pluginExtensions);
      const state = pluginExtensions?.codex?.warningReceipts;
      if (!isJsonObject(state) || !Array.isArray(state.hashes)) {
        throw new Error("missing persisted warning receipt");
      }
      state.hashes.push(
        ...Array.from({ length: 255 }, (_, index) => index.toString(16).padStart(64, "0")),
      );
      return { pluginExtensions };
    },
  });
  const full = receipt();
  await deliver();
  const next = { method: "warning", params: { message: summary + " (changed policy)" } };
  await deliver(next);
  await deliver(next);
  expect(project).toHaveBeenCalledTimes(3);
  expect(receipt()).toEqual(full);
});

it("projects without suppressing warnings when receipt storage is unavailable", async () => {
  const patch = vi
    .spyOn(sessionStore, "prepareSessionEntryPatch")
    .mockRejectedValueOnce(new Error("store unavailable"));
  await deliver();
  expect(patch).toHaveBeenCalledOnce();
  expect(project).toHaveBeenCalledOnce();
  patch.mockRestore();
  await deliver();
  await deliver();
  expect(project).toHaveBeenCalledTimes(2);
});
