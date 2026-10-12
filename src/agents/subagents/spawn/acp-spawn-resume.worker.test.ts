import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { runManagerInitializeSession } from "../../../acp/control-plane/manager.initialize-session.js";
import { ManagerRuntimeHandleCache } from "../../../acp/control-plane/manager.runtime-handle-cache.js";
import { buildAcpDatabaseSessionKey } from "../../../acp/runtime/session-meta-keys.js";
import {
  validateAcpResumeSessionOwnership,
  withAcpResumeSessionAuthorization,
} from "../../../acp/runtime/session-meta-resume-authorization.js";
import {
  readAcpSessionEntryAsync,
  upsertAcpSessionMeta,
  writeAcpSessionMetaForMigration,
} from "../../../acp/runtime/session-meta.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import * as entryReader from "../../../config/sessions/session-entry-read-runtime.js";
import type { SessionAcpMeta } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";

it("resolves resume ownership off-thread, preserving backend, order, and lifecycle fences", async () => {
  await withOpenClawTestState({ scenario: "minimal", label: "acp-resume" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {}, coder: {}, other: {}, reviewer: {} } },
    };
    await state.writeConfig(cfg);
    const requester = "agent:main:main";
    const seed = async (
      name: string,
      options: {
        agentId?: string;
        sessionKey?: string;
        metadataKey?: string;
        backend?: string;
        owner?: string;
        parent?: string;
        runtimeAgent?: string;
        resume?: string;
        binding?: string;
        startedAt?: number;
        updatedAt?: number;
        missing?: boolean;
      } = {},
    ) => {
      const agentId = options.agentId ?? "coder";
      const sessionKey =
        options.sessionKey ??
        `agent:${agentId}:${name === "incognito-private" ? "dashboard" : "acp"}:${name}`;
      const scope = { agentId, sessionKey, env: state.env, skipMaintenance: true };
      const entry = options.missing
        ? undefined
        : await replaceSessionEntry(scope, {
            sessionId: `session-${name}`,
            lifecycleRevision: `revision-${name}`,
            updatedAt: 100,
            sessionStartedAt: options.startedAt,
            spawnedBy: options.owner ?? requester,
            parentSessionKey: options.parent,
          });
      const meta: SessionAcpMeta = {
        backend: options.backend ?? "fixture",
        agent: options.runtimeAgent ?? agentId,
        runtimeSessionName: name,
        mode: "persistent",
        state: "idle",
        lastActivityAt: 100,
        identity: {
          state: "resolved",
          source: "ensure",
          lastUpdatedAt: 100,
          agentSessionId: options.resume ?? name,
          acpxSessionId: `acpx-${name}`,
        },
      };
      writeAcpSessionMetaForMigration({
        sessionKey: buildAcpDatabaseSessionKey(options.metadataKey ?? sessionKey, agentId),
        lifecycleRevision: options.binding ?? entry?.lifecycleRevision ?? "deleted",
        meta,
        env: state.env,
        now: () => options.updatedAt ?? 100,
      });
      return { sessionKey, meta, entry };
    };
    const owned = await seed("owned");
    await seed("parent", { owner: "agent:other:main", parent: requester });
    await seed("foreign", { owner: "agent:other:main" });
    await seed("backend", { backend: "other" });
    await seed("agent", { agentId: "other" });
    await seed("runtime", { runtimeAgent: "cursor" });
    await seed("stale", { binding: "old-revision" });
    await seed("legacy", { binding: "session-legacy", startedAt: 90 });
    await seed("reset", { binding: "session-reset", startedAt: 110 });
    await seed("missing", { missing: true });
    await seed("incognito-private");
    await seed("unqualified", { sessionKey: "agent:coder:main", metadataKey: "main" });
    await seed("alias", { metadataKey: "agent:CODER:acp:alias" });
    await seed("internal", { sessionKey: "agent:coder:internal-session-effects:fixture" });
    await seed("whitespace", { resume: "\t\u00a0 trimmed \ufeff\n", backend: " FIXTURE " });
    await seed("a-stale", { resume: "duplicate-live", binding: "old" });
    await seed("b-live", { resume: "duplicate-live" });
    await seed("a-foreign", { resume: "duplicate-denied", owner: "agent:other:main" });
    await seed("b-owned", { resume: "duplicate-denied" });
    const input = {
      cfg,
      ownerAgentId: "coder",
      runtimeAgentId: "coder",
      backendId: "fixture",
      requesterSessionKey: requester,
    };
    for (const [requesterSessionKey, runtimeAgentId, allowed] of [
      [requester, "coder", true],
      ["agent:other:main", "coder", false],
      [requester, "cursor", false],
    ] as const) {
      expect(
        (
          await validateAcpResumeSessionOwnership({
            ...input,
            ownerAgentId: "reviewer",
            runtimeAgentId,
            requesterSessionKey,
            resumeSessionId: "owned",
          })
        ).ok,
        `historical harness-owned row: ${requesterSessionKey}/${runtimeAgentId}`,
      ).toBe(allowed);
    }
    const cases = [
      ["owned", true],
      ["acpx-owned", true],
      ["parent", true],
      ["foreign", false],
      ["backend", false],
      ["agent", false],
      ["runtime", false],
      ["stale", false],
      ["legacy", true],
      ["reset", false],
      ["missing", false],
      ["incognito-private", false],
      ["unqualified", false],
      ["alias", false],
      ["internal", false],
      ["absent", false],
      ["trimmed", true],
      ["duplicate-live", true],
      ["duplicate-denied", false],
    ] as const;
    const observe = observeHostDataSql();
    try {
      for (const [resumeSessionId, allowed] of cases) {
        expect(
          (await validateAcpResumeSessionOwnership({ ...input, resumeSessionId })).ok,
          resumeSessionId,
        ).toBe(allowed);
      }
      expect(
        (
          await validateAcpResumeSessionOwnership({
            ...input,
            requesterSessionKey: owned.sessionKey,
            resumeSessionId: "owned",
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await validateAcpResumeSessionOwnership({
            ...input,
            requesterSessionKey: undefined,
            resumeSessionId: "owned",
          })
        ).ok,
      ).toBe(false);
      expect(observe.queries).toEqual([]);
    } finally {
      observe.restore();
    }

    const read = entryReader.withSessionEntryReadOnlyInWorker;
    const changedAgent = vi
      .spyOn(entryReader, "withSessionEntryReadOnlyInWorker")
      .mockImplementationOnce((scope, assertCurrent, consume) =>
        read(scope, assertCurrent, async (snapshot, owner) => {
          writeAcpSessionMetaForMigration({
            sessionKey: buildAcpDatabaseSessionKey(owned.sessionKey, "coder"),
            lifecycleRevision: owned.entry?.lifecycleRevision,
            meta: { ...owned.meta, agent: "cursor" },
            env: state.env,
          });
          return consume(snapshot, owner);
        }),
      );
    try {
      expect(
        (await validateAcpResumeSessionOwnership({ ...input, resumeSessionId: "owned" })).ok,
      ).toBe(false);
    } finally {
      changedAgent.mockRestore();
      writeAcpSessionMetaForMigration({
        sessionKey: buildAcpDatabaseSessionKey(owned.sessionKey, "coder"),
        lifecycleRevision: owned.entry?.lifecycleRevision,
        meta: owned.meta,
        env: state.env,
      });
    }
    const changedIdentity = vi
      .spyOn(entryReader, "withSessionEntryReadOnlyInWorker")
      .mockImplementationOnce((scope, assertCurrent, consume) =>
        read(scope, assertCurrent, async (snapshot, owner) => {
          writeAcpSessionMetaForMigration({
            sessionKey: buildAcpDatabaseSessionKey(owned.sessionKey, "coder"),
            lifecycleRevision: owned.entry?.lifecycleRevision,
            meta: {
              ...owned.meta,
              identity: {
                state: "resolved",
                source: "ensure",
                lastUpdatedAt: 200,
                agentSessionId: "replacement",
              },
            },
            env: state.env,
          });
          return consume(snapshot, owner);
        }),
      );
    try {
      expect(
        (await validateAcpResumeSessionOwnership({ ...input, resumeSessionId: "owned" })).ok,
      ).toBe(false);
    } finally {
      changedIdentity.mockRestore();
    }
    let active = true;
    const intercept = vi
      .spyOn(entryReader, "withSessionEntryReadOnlyInWorker")
      .mockImplementation((...args) => {
        active = false;
        return read(...args);
      });
    try {
      await expect(
        validateAcpResumeSessionOwnership({
          ...input,
          resumeSessionId: "replacement",
          assertCurrent() {
            if (!active) {
              throw new Error("request retired");
            }
          },
        }),
      ).rejects.toThrow("request retired");
    } finally {
      intercept.mockRestore();
    }

    for (const mutation of [
      "unchanged",
      "reassigned",
      "runtime",
      "deleted",
      "retired",
      "snapshot-reassigned",
    ] as const) {
      const source = await seed(`final-effect-${mutation}`);
      const target = await seed(`target-${mutation}`, {
        agentId: "reviewer",
        runtimeAgent: "coder",
      });
      const sourceEntry = source.entry;
      if (!sourceEntry) {
        throw new Error("resume source fixture was not created");
      }
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("request retired");
        }
      };
      const authorization = {
        ...input,
        ownerAgentId: "reviewer",
        resumeSessionId: `final-effect-${mutation}`,
        assertCurrent,
      };
      expect((await validateAcpResumeSessionOwnership(authorization)).ok).toBe(true);
      const ensureSession = vi.fn<AcpRuntime["ensureSession"]>(async (request) => ({
        sessionKey: request.sessionKey,
        agentId: request.agentId,
        backend: "fixture",
        runtimeSessionName: request.sessionKey,
        agentSessionId: request.resumeSessionId,
      }));
      const runtime: AcpRuntime = {
        ensureSession,
        async *runTurn() {
          yield { type: "done" };
        },
        cancel: async () => {},
        close: async () => {},
      };
      const prepared = createDeferred();
      const release = createDeferred();
      const runtimeHandles = new ManagerRuntimeHandleCache();
      const retained: { revalidateResume?: () => Promise<() => void> } = {};
      const operation = withAcpResumeSessionAuthorization(authorization, (revalidateResume) => {
        retained.revalidateResume = revalidateResume;
        return runManagerInitializeSession({
          input: {
            cfg,
            sessionKey: target.sessionKey,
            agentId: "reviewer",
            agent: "coder",
            mode: "persistent",
            resumeSessionId: authorization.resumeSessionId,
            backendId: "fixture",
            assertActive: assertCurrent,
            revalidateResume,
          },
          sessionKey: target.sessionKey,
          agentId: "reviewer",
          deps: {
            requireRuntimeBackend: () => ({ id: "fixture", runtime }),
            loadSessionEntryAsync: async (params) => {
              const entry = await readAcpSessionEntryAsync(params);
              prepared.resolve();
              await release.promise;
              return entry;
            },
          },
          runtimeHandles,
          writeSessionMeta: upsertAcpSessionMeta,
        });
      });
      const outcome = operation.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      let restoreRead: (() => void) | undefined;
      try {
        await awaitGateBeforeSettlement(prepared.promise, operation, "manager did not prepare");
        const scope = { agentId: "coder", sessionKey: source.sessionKey, env: state.env };
        if (mutation === "reassigned") {
          await replaceSessionEntry(scope, {
            ...sourceEntry,
            spawnedBy: "agent:other:main",
            parentSessionKey: "agent:other:main",
          });
        } else if (mutation === "runtime") {
          writeAcpSessionMetaForMigration({
            sessionKey: buildAcpDatabaseSessionKey(source.sessionKey, "coder"),
            lifecycleRevision: sourceEntry.lifecycleRevision,
            meta: { ...source.meta, agent: "cursor" },
            env: state.env,
          });
        } else if (mutation === "deleted") {
          expect(
            (
              await deleteSessionEntryLifecycle({
                ...scope,
                storePath: resolveSessionStorePathCore(cfg.session?.store, scope),
                target: { canonicalKey: source.sessionKey, storeKeys: [source.sessionKey] },
                archiveTranscript: false,
              })
            ).deleted,
          ).toBe(true);
        } else if (mutation === "retired") {
          current = false;
        } else if (mutation === "snapshot-reassigned") {
          const changedOwner = vi
            .spyOn(entryReader, "withSessionEntryReadOnlyInWorker")
            .mockImplementationOnce((readScope, assertReadCurrent, consume) =>
              read(readScope, assertReadCurrent, async (snapshot, owner) => {
                expect(readScope.sessionKey).toBe(source.sessionKey);
                expect(snapshot).toMatchObject({ ok: true, value: { spawnedBy: requester } });
                await replaceSessionEntry(scope, {
                  ...sourceEntry,
                  spawnedBy: "agent:other:main",
                  parentSessionKey: "agent:other:main",
                });
                return consume(snapshot, owner);
              }),
            );
          restoreRead = () => changedOwner.mockRestore();
        }
      } finally {
        release.resolve();
      }
      const result = await outcome.finally(() => restoreRead?.());
      expect(result.ok, mutation).toBe(mutation === "unchanged");
      if (!retained.revalidateResume) {
        throw new Error("resume authorization callback was not provided");
      }
      await expect(retained.revalidateResume()).rejects.toThrow(
        mutation === "retired" ? "request retired" : "ACP resume source authority changed",
      );
      if (result.ok) {
        expect(ensureSession).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            agentId: "reviewer",
            agent: "coder",
            resumeSessionId: authorization.resumeSessionId,
          }),
        );
        expect(result.value.sessionEntry.acp?.identity?.agentSessionId).toBe(
          authorization.resumeSessionId,
        );
      } else {
        expect(String(result.error)).toContain(
          mutation === "retired"
            ? "request retired"
            : mutation === "snapshot-reassigned"
              ? "ACP resume source authority changed"
              : "previously recorded for this requester",
        );
        expect(ensureSession).not.toHaveBeenCalled();
        expect(
          runtimeHandles.get({ agentId: "reviewer", sessionKey: target.sessionKey }),
        ).toBeNull();
      }
    }
  });
});
