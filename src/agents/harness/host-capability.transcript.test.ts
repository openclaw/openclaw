import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  readActiveTranscriptEntryAnchor,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../../config/sessions/store-writer-state.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  closeAdmittedRunDelegatedAuthority,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import {
  bindCodeModeTranscriptAuthority,
  CodeModeTranscriptAuthority,
  type TranscriptPrefixEntry,
} from "../code-mode-transcript-authority.js";
import { SessionManager } from "../sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";
import {
  admittedAttempt,
  cleanupHostCapabilityTestAdmissions,
  policyRevocations,
} from "./host-capability.test-helpers.js";

async function withProviderMetadataCommit(
  run: (fixture: Awaited<ReturnType<typeof prepareProviderMetadataCommit>>) => Promise<void>,
  abortSignal?: AbortSignal,
) {
  await withOpenClawTestState({ label: "provider-metadata" }, async (state) => {
    const fixture = await prepareProviderMetadataCommit(state, abortSignal);
    try {
      await run(fixture);
    } finally {
      fixture.host.close();
      fixture.admission.close();
      resetGlobalHookRunner();
    }
  });
}

async function prepareProviderMetadataCommit(state: OpenClawTestState, abortSignal?: AbortSignal) {
  const runId = "provider-metadata";
  const scope = {
    agentId: "main",
    env: state.env,
    expectedLifecycleRevision: "provider-lifecycle",
    expectedWriterRunId: runId,
    sessionId: "provider-metadata",
    sessionKey: "agent:main:provider-metadata",
    storePath: path.join(state.sessionsDir(), "sessions.json"),
  };
  replaceSessionEntrySync(scope, {
    activeWriterRunId: runId,
    lifecycleRevision: scope.expectedLifecycleRevision,
    sessionId: scope.sessionId,
    updatedAt: 1,
  });
  const manager = SessionManager.open(scope, state.workspaceDir);
  const userId = manager.appendMessage({ role: "user", content: "read both", timestamp: 1 });
  const baseAnchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: userId });
  if (!baseAnchor) {
    throw new Error("user lacks its authoritative transcript anchor");
  }
  const { attempt, admission } = await admittedAttempt(runId, {
    sessionId: scope.sessionId,
    sessionKey: scope.sessionKey,
    config: { logging: { redactPatterns: ["producer-private-note"] } },
    trigger: "memory",
    cwd: state.workspaceDir,
    workspaceDir: state.workspaceDir,
    ...(abortSignal ? { abortSignal } : {}),
  });
  bindCodeModeTranscriptAuthority(attempt, new CodeModeTranscriptAuthority(scope));
  const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "copilot" });
  const commit = host.capabilities.commitProviderTranscriptPrefix;
  if (!commit) {
    throw new Error("host did not bind its private transcript commit");
  }
  const entries: TranscriptPrefixEntry[] = [
    {
      eventId: "provider-assistant",
      identity: "copilot:assistant",
      message: makeAgentAssistantMessage({
        content: [
          { type: "text", text: "reading" },
          { type: "toolCall", id: "call-first", name: "read", arguments: {} },
          { type: "toolCall", id: "call-second", name: "read", arguments: {} },
        ],
        stopReason: "toolUse",
      }),
    },
    ...["first", "second"].map((name): TranscriptPrefixEntry => ({
      eventId: `provider-${name}`,
      identity: `copilot:${name}`,
      message: {
        role: "toolResult",
        toolCallId: `call-${name}`,
        toolName: "read",
        content: [{ type: "text", text: `network ${name}` }],
        isError: false,
        timestamp: 1,
      },
    })),
  ];
  for (const { message } of entries) {
    Reflect.set(message, "__openclaw", {
      ...(message.role === "assistant"
        ? { turnTainted: true }
        : { resultContentSource: "network" }),
      producerOnly: "retained",
      nested: { origin: "network" },
      producerNote: "producer-private-note",
    });
  }
  const databaseOptions = toDatabaseOptions(resolveSqliteTranscriptScope(scope));
  const readState = () => {
    const { db } = openOpenClawAgentDatabase(databaseOptions);
    return {
      events: db
        .prepare("SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq")
        .all(scope.sessionId),
      identities: db
        .prepare("SELECT * FROM transcript_event_identities WHERE session_id = ? ORDER BY seq")
        .all(scope.sessionId),
      index: db
        .prepare("SELECT * FROM session_transcript_index_state WHERE session_id = ?")
        .get(scope.sessionId),
      node: db.prepare("SELECT * FROM session_nodes WHERE session_key = ?").get(scope.sessionKey),
      leaf: manager.getLeafId(),
      parent: manager.getAppendParentId(),
    };
  };
  return {
    scope,
    host,
    admission,
    attempt,
    entries,
    baseAnchor,
    readState,
    commit: () =>
      commit({ entries, baseAnchor, assertCurrent: () => host.capabilities.assertActive() }),
    reopen: () => {
      closeOpenClawAgentDatabaseByPath(openOpenClawAgentDatabase(databaseOptions).path);
      return SessionManager.open(scope, state.workspaceDir);
    },
  };
}

afterEach(() => {
  resetGlobalHookRunner();
  vi.unstubAllEnvs();
  cleanupHostCapabilityTestAdmissions();
});

describe("agent harness host transcript capability", () => {
  it.each([
    "replacement deletion",
    "replacement falsification",
    "in-place nested mutation",
    "array metadata",
    "null metadata",
    "string metadata",
    "numeric metadata",
  ])("preserves provider-owned metadata through %s and cold replay", async (mode) => {
    await withProviderMetadataCommit(async (fixture) => {
      const source = structuredClone(fixture.entries);
      const hook = vi.fn((event: unknown) => {
        const message = (event as { message: TranscriptPrefixEntry["message"] }).message;
        const metadata = asOptionalRecord(Reflect.get(message, "__openclaw"))!;
        const content = Reflect.get(message, "content") as Array<Record<string, unknown>>;
        for (const block of content) {
          if (block.type === "text") {
            block.text = "hook content";
          }
        }
        if (mode === "in-place nested mutation") {
          metadata.turnTainted = false;
          metadata.resultContentSource = "local";
          asOptionalRecord(metadata.nested)!.origin = "local";
          metadata.hookOnly = "added";
          return undefined;
        }
        const replacement = { ...message };
        if (mode === "replacement deletion") {
          Reflect.deleteProperty(replacement, "__openclaw");
        } else {
          const hookMetadata =
            mode === "replacement falsification"
              ? {
                  turnTainted: false,
                  resultContentSource: "local",
                  nested: { origin: "local" },
                  hookOnly: "added",
                }
              : mode === "array metadata"
                ? ["forged"]
                : mode === "null metadata"
                  ? null
                  : mode === "string metadata"
                    ? "forged"
                    : 7;
          Reflect.set(replacement, "__openclaw", hookMetadata);
        }
        return { message: replacement };
      });
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "before_message_write", handler: hook }]),
      );
      const before = fixture.readState();
      const receipt = await fixture.commit();
      expect(receipt.kind).toBe("committed");
      if (receipt.kind !== "committed") {
        throw new Error("expected a committed provider group");
      }
      expect(hook).toHaveBeenCalledTimes(3);
      expect(receipt.results.map((entry) => entry.identity)).toEqual(
        source.map((entry) => entry.identity),
      );
      expect(receipt.results.map((entry) => entry.anchor.entryId)).toEqual(
        source.map((entry) => entry.eventId),
      );
      expect(receipt.results.map((entry) => entry.anchor.effectiveParentId)).toEqual([
        fixture.baseAnchor.entryId,
        "provider-assistant",
        "provider-first",
      ]);
      expect(receipt.results.map((entry) => entry.message)).toMatchObject([
        { role: "assistant" },
        { role: "toolResult", toolCallId: "call-first", toolName: "read" },
        { role: "toolResult", toolCallId: "call-second", toolName: "read" },
      ]);
      for (const [index, result] of receipt.results.entries()) {
        expect(result.anchor.activeMessagePosition).toBe(
          fixture.baseAnchor.activeMessagePosition + index + 1,
        );
        expect(result.anchor).toEqual(
          readActiveTranscriptEntryAnchor({ ...fixture.scope, entryId: result.anchor.entryId }),
        );
        expect(result.message).toMatchObject({
          idempotencyKey: result.identity,
          display: false,
          __openclaw: {
            ...(index === 0 ? { turnTainted: true } : { resultContentSource: "network" }),
            nested: { origin: "network" },
            producerOnly: "retained",
            providerSourceFingerprint: expect.stringMatching(/^[a-f0-9]{32}$/),
          },
        });
        expect(JSON.stringify(result.message)).not.toContain("producer-private-note");
        expect(result.message).toHaveProperty("__openclaw.producerNote", expect.any(String));
        expect(result.message).toHaveProperty("content.0.text", "hook content");
        if (mode === "replacement falsification" || mode === "in-place nested mutation") {
          expect(result.message).toHaveProperty("__openclaw.hookOnly", "added");
        } else {
          expect(result.message).not.toHaveProperty("__openclaw.hookOnly");
          expect(result.message).not.toHaveProperty("__openclaw.0");
        }
      }
      expect(fixture.readState().events.slice(0, before.events.length)).toEqual(before.events);
      expect(fixture.readState().events).toHaveLength(before.events.length + 3);
      expect(fixture.readState().identities).toHaveLength(before.identities.length + 3);
      expect(fixture.readState().leaf).toBe(before.leaf);
      expect(fixture.readState().parent).toBe(before.parent);
      const persisted = fixture.readState();
      const reopened = fixture.reopen();
      for (const result of receipt.results) {
        expect(reopened.getEntry(result.anchor.entryId)).toMatchObject({ message: result.message });
      }
      expect(reopened.getLeafId()).toBe("provider-second");
      expect(reopened.getAppendParentId()).toBe("provider-second");
      expect(await fixture.commit()).toEqual({ ...receipt, kind: "replayed" });
      expect(fixture.readState()).toEqual(persisted);
      expect(hook).toHaveBeenCalledTimes(3);
      expect(fixture.entries).toEqual(source);
    });
  });

  it.each([
    { label: "missing", metadata: undefined },
    { label: "null", metadata: null },
    { label: "array", metadata: ["invalid"] },
    { label: "string", metadata: "invalid" },
  ])(
    "retains hook-only metadata when producer metadata is not a record: $label",
    async ({ metadata }) => {
      await withProviderMetadataCommit(async (fixture) => {
        for (const entry of fixture.entries) {
          Reflect.set(entry.message, "__openclaw", metadata);
        }
        const source = structuredClone(fixture.entries);
        initializeGlobalHookRunner(
          createMockPluginRegistry([
            {
              hookName: "before_message_write",
              handler: (event) => ({
                message: {
                  ...(event as { message: TranscriptPrefixEntry["message"] }).message,
                  __openclaw: { hookOnly: "added" },
                },
              }),
            },
          ]),
        );
        const receipt = await fixture.commit();
        expect(receipt.kind).toBe("committed");
        if (receipt.kind !== "committed") {
          throw new Error("expected a committed provider group");
        }
        for (const { message } of receipt.results) {
          expect(Reflect.get(message, "__openclaw")).toEqual({
            hookOnly: "added",
            providerSourceFingerprint: expect.stringMatching(/^[a-f0-9]{32}$/),
          });
        }
        expect(fixture.entries).toEqual(source);
      });
    },
  );

  it("suppresses the entire provider group when one message is blocked", async () => {
    await withProviderMetadataCommit(async (fixture) => {
      const source = structuredClone(fixture.entries);
      const hook = vi.fn((event: unknown) => {
        const message = (event as { message: TranscriptPrefixEntry["message"] }).message;
        asOptionalRecord(asOptionalRecord(Reflect.get(message, "__openclaw"))?.nested)!.origin =
          "local";
        return message.role === "toolResult" && message.toolCallId === "call-first"
          ? { block: true }
          : undefined;
      });
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "before_message_write", handler: hook }]),
      );
      const before = fixture.readState();
      expect(await fixture.commit()).toEqual({ kind: "suppressed" });
      expect(hook).toHaveBeenCalledTimes(3);
      expect(fixture.readState()).toEqual(before);
      expect(fixture.entries).toEqual(source);
      expect(fixture.reopen().getEntries()).toHaveLength(1);
      for (const entry of fixture.entries) {
        expect(
          readActiveTranscriptEntryAnchor({ ...fixture.scope, entryId: entry.eventId }),
        ).toBeUndefined();
      }
    });
  });

  it("rejects a pre-aborted provider transcript commit without changing SQLite or cursors", async () => {
    const controller = new AbortController();
    const reason = new Error("provider attempt aborted before commit");
    controller.abort(reason);

    await withProviderMetadataCommit(async (fixture) => {
      const before = fixture.readState();
      await expect(fixture.commit()).rejects.toBe(reason);
      expect(fixture.readState()).toEqual(before);
    }, controller.signal);
  });

  it("keeps the captured attempt abort signal authoritative after attempt mutation", async () => {
    const captured = new AbortController();

    await withProviderMetadataCommit(async (fixture) => {
      const replacement = new AbortController();
      fixture.attempt.abortSignal = replacement.signal;
      const before = fixture.readState();
      const reason = new Error("captured provider attempt aborted");
      captured.abort(reason);

      await expect(fixture.commit()).rejects.toBe(reason);
      expect(replacement.signal.aborted).toBe(false);
      expect(fixture.readState()).toEqual(before);
    }, captured.signal);
  });

  it("rejects an abort raised during provider transcript hooks before SQLite", async () => {
    const controller = new AbortController();
    const reason = new Error("provider attempt aborted during hook");
    const hook = vi.fn(() => {
      controller.abort(reason);
      return undefined;
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_message_write", handler: hook }]),
    );

    await withProviderMetadataCommit(async (fixture) => {
      const before = fixture.readState();
      await expect(fixture.commit()).rejects.toBe(reason);
      expect(hook).toHaveBeenCalledOnce();
      expect(fixture.readState()).toEqual(before);
    }, controller.signal);
  });

  it("rejects a provider transcript commit before its retained host owner can reach SQLite", async () => {
    const { attempt } = await admittedAttempt("run-provider-assertion");
    const authority = new CodeModeTranscriptAuthority({
      expectedWriterRunId: "writer",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      storePath: "/not-reached/sessions.json",
    });
    const commitPrefix = vi.spyOn(authority, "commitPrefix");
    bindCodeModeTranscriptAuthority(attempt, authority);
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    const commit = host.capabilities.commitProviderTranscriptPrefix;
    expect(commit).toEqual(expect.any(Function));

    await expect(
      commit?.({
        assertCurrent: () => {
          throw new Error("provider checkpoint replaced");
        },
        entries: [],
      }),
    ).rejects.toThrow("provider checkpoint replaced");
    expect(commitPrefix).not.toHaveBeenCalled();
    host.close();
  });

  it.each(policyRevocations)(
    "rejects a retained provider transcript commit before SQLite after $name",
    async ({ revoke }) => {
      const { attempt, admission } = await admittedAttempt("run-provider-retained");
      const authority = new CodeModeTranscriptAuthority({
        expectedWriterRunId: "writer",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        storePath: "/not-reached/sessions.json",
      });
      const commitPrefix = vi.spyOn(authority, "commitPrefix");
      bindCodeModeTranscriptAuthority(attempt, authority);
      const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
      const commit = host.capabilities.commitProviderTranscriptPrefix;
      if (!commit) {
        throw new Error("host did not bind its private transcript commit");
      }
      try {
        await revoke({ host, attempt, admission });
        await expect(commit({ assertCurrent: () => undefined, entries: [] })).rejects.toThrow();
        expect(commitPrefix).not.toHaveBeenCalled();
      } finally {
        host.close();
      }
    },
  );

  it.each([
    { mode: "allowed", error: undefined },
    { mode: "host closed", error: "code mode transcript authority is closed" },
    { mode: "authority released", error: "agent harness host capability is no longer active" },
    { mode: "owner replaced", error: "agent harness host capability is no longer active" },
    { mode: "attempt aborted", error: "queued provider attempt aborted" },
  ] as const)(
    "settles a queued provider transcript commit only with current host authority ($mode)",
    async ({ mode, error }) => {
      await withOpenClawTestState({ label: "host-provider-commit" }, async (state) => {
        const runId = "run-provider-queued";
        const scope = {
          agentId: "main",
          env: state.env,
          expectedLifecycleRevision: "provider-lifecycle",
          expectedWriterRunId: runId,
          sessionId: "provider-session",
          sessionKey: "agent:main:provider-session",
          storePath: path.join(state.sessionsDir(), "sessions.json"),
        };
        replaceSessionEntrySync(scope, {
          activeWriterRunId: scope.expectedWriterRunId,
          lifecycleRevision: scope.expectedLifecycleRevision,
          sessionId: scope.sessionId,
          updatedAt: 1,
        });
        const manager = SessionManager.open(scope, state.workspaceDir);
        const assistantId = manager.appendMessage(
          makeAgentAssistantMessage({
            content: [{ type: "toolCall", id: "provider-call", name: "read", arguments: {} }],
            stopReason: "toolUse",
          }),
        );
        const baseAnchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: assistantId });
        if (!baseAnchor) {
          throw new Error("assistant lacks its authoritative transcript anchor");
        }
        const resolved = resolveSqliteTranscriptScope(scope);
        const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
        const readState = () => ({
          events: database.db
            .prepare("SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq")
            .all(scope.sessionId),
          identities: database.db
            .prepare("SELECT * FROM transcript_event_identities WHERE session_id = ? ORDER BY seq")
            .all(scope.sessionId),
          index: database.db
            .prepare("SELECT * FROM session_transcript_index_state WHERE session_id = ?")
            .get(scope.sessionId),
          node: database.db
            .prepare("SELECT * FROM session_nodes WHERE session_key = ?")
            .get(scope.sessionKey),
          cursors: { leaf: manager.getLeafId(), parent: manager.getAppendParentId() },
        });
        const before = readState();
        const abortController = new AbortController();
        const { attempt, admission } = await admittedAttempt(runId, {
          abortSignal: abortController.signal,
          sessionId: scope.sessionId,
          sessionKey: scope.sessionKey,
          cwd: state.workspaceDir,
          workspaceDir: state.workspaceDir,
        });
        const authority = new CodeModeTranscriptAuthority(scope);
        bindCodeModeTranscriptAuthority(attempt, authority);
        const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "copilot" });
        const commit = host.capabilities.commitProviderTranscriptPrefix;
        const entered = createDeferred();
        const release = createDeferred();
        let blocker: Promise<void> | undefined;
        let pending: ReturnType<NonNullable<typeof commit>> | undefined;
        let replacement: PreparedAgentRunAdmission | undefined;
        let exactAbortReason: Error | undefined;
        try {
          if (!commit) {
            throw new Error("host did not bind its private transcript commit");
          }
          blocker = runExclusiveSqliteSessionWrite(
            resolved,
            async () => {
              entered.resolve();
              await release.promise;
            },
            "session.transcript.batch",
          );
          await entered.promise;
          pending = commit({
            assertCurrent: () => {
              if (manager.getAppendParentId() !== assistantId) {
                throw new Error("provider checkpoint replaced");
              }
            },
            baseAnchor,
            entries: [
              {
                eventId: "provider-result",
                identity: "copilot:provider-result",
                message: {
                  role: "toolResult",
                  toolCallId: "provider-call",
                  toolName: "read",
                  content: [{ type: "text", text: "read result" }],
                  isError: false,
                  timestamp: 1,
                },
              },
            ],
          });
          // Observe actual queue admission before revocation; otherwise an entry
          // guard failure could masquerade as the final SQLite authority fence.
          expect(SQLITE_SESSION_WRITER_QUEUES.get(database.path)?.pending).toHaveLength(1);
          expect(readState()).toEqual(before);
          if (mode === "host closed") {
            host.close();
          } else if (mode === "authority released") {
            expect(closeAdmittedRunDelegatedAuthority(attempt.admittedRunContext)).toBe(true);
          } else if (mode === "owner replaced") {
            replacement = (await admittedAttempt(runId)).admission;
          } else if (mode === "attempt aborted") {
            exactAbortReason = new Error(error);
            abortController.abort(exactAbortReason);
          }
          // Releasing or replacing admission must not change the SQLite writer
          // or lifecycle: the queued commit must fail on host authority itself.
          expect(readState()).toEqual(before);
          release.resolve();
          await blocker;
          if (error) {
            if (exactAbortReason) {
              await expect(pending).rejects.toBe(exactAbortReason);
            } else {
              await expect(pending).rejects.toEqual(new Error(error));
            }
            expect(readState()).toEqual(before);
            expect(
              readActiveTranscriptEntryAnchor({ ...scope, entryId: "provider-result" }),
            ).toBeUndefined();
          } else {
            const result = await pending;
            if (result.kind !== "committed") {
              throw new Error(`provider transcript was not committed: ${result.kind}`);
            }
            expect(result).toMatchObject({
              kind: "committed",
              results: [
                {
                  identity: "copilot:provider-result",
                  anchor: {
                    ...baseAnchor,
                    entryId: "provider-result",
                    effectiveParentId: assistantId,
                    rawSeq: baseAnchor.rawSeq + 1,
                    activeMessagePosition: baseAnchor.activeMessagePosition + 1,
                    idempotencyKey: "copilot:provider-result",
                  },
                  message: {
                    role: "toolResult",
                    toolCallId: "provider-call",
                    toolName: "read",
                    content: [{ type: "text", text: "read result" }],
                  },
                },
              ],
            });
            const after = readState();
            expect(after.events).toHaveLength(before.events.length + 1);
            expect(after.events.slice(0, -1)).toEqual(before.events);
            expect(after.identities).toHaveLength(before.identities.length + 1);
            expect(after.identities.slice(0, -1)).toEqual(before.identities);
            expect(after.cursors).toEqual(before.cursors);
            expect(result.results).toHaveLength(1);
            expect(result.results[0]?.anchor).toEqual(
              readActiveTranscriptEntryAnchor({ ...scope, entryId: "provider-result" }),
            );
          }
          manager.reloadPersistedTranscript();
          expect(manager.getLeafId()).toBe(error ? assistantId : "provider-result");
          expect(manager.getAppendParentId()).toBe(error ? assistantId : "provider-result");
        } finally {
          release.resolve();
          try {
            await Promise.allSettled([blocker, pending]);
            await SQLITE_SESSION_WRITER_QUEUES.get(database.path)?.drainPromise;
            expect(SQLITE_SESSION_WRITER_QUEUES.has(database.path)).toBe(false);
          } finally {
            host.close();
            replacement?.close();
            admission.close();
          }
        }
      });
    },
  );

  it("rejects an aborted queued persisted replay without changing SQLite or cursors", async () => {
    const abortController = new AbortController();

    await withProviderMetadataCommit(async (fixture) => {
      const committed = await fixture.commit();
      expect(committed.kind).toBe("committed");
      const before = fixture.readState();
      const resolved = resolveSqliteTranscriptScope(fixture.scope);
      const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
      const entered = createDeferred();
      const release = createDeferred();
      let blocker: Promise<void> | undefined;
      let pending: ReturnType<typeof fixture.commit> | undefined;
      try {
        blocker = runExclusiveSqliteSessionWrite(
          resolved,
          async () => {
            entered.resolve();
            await release.promise;
          },
          "session.transcript.batch",
        );
        await entered.promise;
        pending = fixture.commit();
        expect(SQLITE_SESSION_WRITER_QUEUES.get(database.path)?.pending).toHaveLength(1);
        expect(fixture.readState()).toEqual(before);

        const reason = new Error("queued provider replay aborted");
        abortController.abort(reason);
        release.resolve();
        await blocker;

        await expect(pending).rejects.toBe(reason);
        expect(fixture.readState()).toEqual(before);
        const reopened = fixture.reopen();
        expect(reopened.getLeafId()).toBe("provider-second");
        expect(reopened.getAppendParentId()).toBe("provider-second");
      } finally {
        release.resolve();
        await Promise.allSettled([blocker, pending]);
        await SQLITE_SESSION_WRITER_QUEUES.get(database.path)?.drainPromise;
        expect(SQLITE_SESSION_WRITER_QUEUES.has(database.path)).toBe(false);
      }
    }, abortController.signal);
  });
});
