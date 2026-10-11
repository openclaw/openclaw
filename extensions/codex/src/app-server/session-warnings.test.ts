import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as sessionStore from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  observeHostDataSql,
  useSessionStoreTempDirs,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { CodexServerNotification } from "./protocol.js";
import { projectCodexSessionWarning } from "./session-warnings.js";

const dirs = useSessionStoreTempDirs(afterAll, "codex-chat-warnings-");
const warning = {
  method: "configWarning",
  params: {
    summary:
      "Ignoring unknown `features` requirement `ultrafast_mode` from enterprise-managed requirements Example policy (example-policy)",
    details: null,
    path: null,
    range: null,
  },
};

afterEach(() => vi.restoreAllMocks());

async function createChat() {
  const session = {
    agentId: "main",
    sessionKey: "agent:main:warning-chat",
    sessionId: "chat-session",
    expectedLifecycleRevision: "generation-1",
    storePath: path.join(dirs.make(), "sessions.json"),
  };
  await sessionStore.upsertSessionEntry({
    ...session,
    entry: {
      sessionId: session.sessionId,
      lifecycleRevision: session.expectedLifecycleRevision,
      updatedAt: 1,
      pluginExtensions: { other: { retained: true }, codex: { unrelated: true } },
    },
  });
  return session;
}

type Session = Awaited<ReturnType<typeof createChat>>;
function deliver(
  session: Session,
  project: () => Promise<boolean>,
  notification: CodexServerNotification = warning,
  threadId = "thread-1",
) {
  return projectCodexSessionWarning({
    session,
    project,
    notification,
    threadId,
    assertCurrent: () => {},
  });
}

it("deduplicates separate receipts across native threads and reopened session storage", async () => {
  const session = await createChat();
  const project = vi.fn(async () => true);
  const before = sessionStore.getSessionEntry(session);
  await Promise.all(
    Array.from({ length: 4 }, () => deliver(session, project, structuredClone(warning))),
  );
  await deliver(session, project);
  expect(project).toHaveBeenCalledTimes(1);
  const persisted = sessionStore.getSessionEntry(session);
  expect(persisted).toMatchObject({
    updatedAt: before?.updatedAt,
    pluginExtensions: { other: { retained: true }, codex: { unrelated: true } },
  });
  expect(JSON.stringify(persisted?.pluginExtensions?.codex?.warningReceipts)).not.toContain(
    warning.params.summary,
  );
  await closeOpenClawAgentDatabasesAsync(path.dirname(session.storePath));
  await deliver(
    { ...session },
    project,
    {
      method: "warning",
      params: { threadId: "replacement-thread", message: warning.params.summary },
    },
    "replacement-thread",
  );
  expect(project).toHaveBeenCalledTimes(1);
});

it("keeps different warnings and diagnostic locations visible without deduplicating Guardian events", async () => {
  const session = await createChat();
  const project = vi.fn(async () => true);
  const distinct: CodexServerNotification[] = [
    warning,
    {
      method: "configWarning",
      params: { summary: warning.params.summary.replace("ultrafast_mode", "security_policy") },
    },
    { method: "warning", params: { message: "Conversation state could not be saved." } },
    {
      method: "configWarning",
      params: { summary: warning.params.summary, details: "Additional action required" },
    },
    {
      method: "configWarning",
      params: { summary: warning.params.summary, path: "/example/policy.toml" },
    },
  ];
  for (const notification of distinct) {
    await deliver(session, project, notification);
    await deliver(session, project, notification);
  }
  expect(project).toHaveBeenCalledTimes(distinct.length + 2);
  const guardian = {
    method: "guardianWarning",
    params: { threadId: "thread-1", message: warning.params.summary },
  };
  await deliver(session, project, guardian);
  await deliver(session, project, guardian);
  expect(project).toHaveBeenCalledTimes(distinct.length + 4);
});

it.each(["success", "throw", "unacknowledged"] as const)(
  "serializes overlapping chat projection and retries %s appropriately",
  async (outcome) => {
    const session = await createChat();
    const started = createDeferred<void>();
    const finish = createDeferred<boolean>();
    const first = deliver(session, async () => {
      started.resolve();
      return await finish.promise;
    });
    const settled = first.then(
      () => undefined,
      (error: unknown) => error,
    );
    await started.promise;
    const project = vi.fn(async () => true);
    const next = deliver({ ...session }, project, structuredClone(warning), "replacement-thread");
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
    await deliver(session, project);
    expect(project).toHaveBeenCalledTimes(outcome === "success" ? 0 : 1);
  },
);

it("allows independent chats and same-id reset generations their own first warning", async () => {
  const session = await createChat();
  const project = vi.fn(async () => true);
  await deliver(session, project);
  const child = { ...session, sessionKey: "agent:main:child", sessionId: "child-session" };
  const parentEntry = sessionStore.getSessionEntry(session);
  if (!parentEntry) {
    throw new Error("missing seeded parent session");
  }
  await sessionStore.upsertSessionEntry({
    ...child,
    entry: { ...parentEntry, sessionId: child.sessionId, updatedAt: 1 },
  });
  await deliver(child, project);
  expect(project).toHaveBeenCalledTimes(2);
  await sessionStore.patchSessionEntry({
    ...session,
    update: () => ({ lifecycleRevision: "generation-2" }),
    skipMaintenance: true,
  });
  // A stale attempt must not consume the successor's first notification.
  await deliver(session, project);
  expect(project).toHaveBeenCalledTimes(2);
  await deliver({ ...session, expectedLifecycleRevision: "generation-2" }, project);
  await deliver({ ...session, expectedLifecycleRevision: "generation-2" }, project);
  expect(project).toHaveBeenCalledTimes(3);
});

it("retains acknowledged receipts at capacity and fails open for new distinct warnings", async () => {
  const session = await createChat();
  const project = vi.fn(async () => true);
  await deliver(session, project);
  await sessionStore.patchSessionEntry({
    ...session,
    skipMaintenance: true,
    update: (entry) => {
      const state = entry.pluginExtensions?.codex?.warningReceipts;
      if (
        !state ||
        typeof state !== "object" ||
        Array.isArray(state) ||
        !Array.isArray(state.hashes)
      ) {
        throw new Error("missing persisted warning receipt");
      }
      return {
        pluginExtensions: {
          ...entry.pluginExtensions,
          codex: {
            ...entry.pluginExtensions?.codex,
            warningReceipts: {
              ...state,
              hashes: [
                ...state.hashes,
                ...Array.from({ length: 255 }, (_, index) => index.toString(16).padStart(64, "0")),
              ],
            },
          },
        },
      };
    },
  });
  const full = sessionStore.getSessionEntry(session)?.pluginExtensions?.codex?.warningReceipts;
  await deliver(session, project);
  const next = {
    method: "warning",
    params: { message: warning.params.summary + " (changed policy)" },
  };
  await deliver(session, project, next);
  await deliver(session, project, next);
  expect(project).toHaveBeenCalledTimes(3);
  expect(sessionStore.getSessionEntry(session)?.pluginExtensions?.codex?.warningReceipts).toEqual(
    full,
  );
});

it("projects without suppressing warnings when receipt storage is unavailable", async () => {
  const session = await createChat();
  const project = vi.fn(async () => true);
  const patch = vi
    .spyOn(sessionStore, "patchSessionEntry")
    .mockRejectedValueOnce(new Error("store unavailable"));
  await deliver(session, project);
  expect(patch).toHaveBeenCalledOnce();
  expect(project).toHaveBeenCalledOnce();
  patch.mockRestore();
  await deliver(session, project);
  await deliver(session, project);
  expect(project).toHaveBeenCalledTimes(2);
});

it("keeps warm session receipt reads and writes off the Gateway thread", async () => {
  const session = await createChat();
  const project = vi.fn(async () => true);
  await deliver(session, project);
  const sql = observeHostDataSql();
  try {
    await deliver(session, project);
    await deliver(session, project, {
      method: "warning",
      params: { message: warning.params.summary + " (new source)" },
    });
    expect(sql.queries).toEqual([]);
    expect(project).toHaveBeenCalledTimes(2);
  } finally {
    sql.restore();
  }
});
