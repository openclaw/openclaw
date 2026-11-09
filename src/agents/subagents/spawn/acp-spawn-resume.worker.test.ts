import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { expectDefined } from "@openclaw/normalization-core";
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
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
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
    setRuntimeConfigSnapshot(cfg);
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
        now: () => 100,
      });
      return { sessionKey, meta, entry };
    };
    const owned = await seed("owned");
    const candidates: [string, boolean, Parameters<typeof seed>[1]?][] = [
      ["parent", true, { owner: "agent:other:main", parent: requester }],
      ["foreign", false, { owner: "agent:other:main" }],
      ["backend", false, { backend: "other" }],
      ["agent", false, { agentId: "other" }],
      ["runtime", false, { runtimeAgent: "cursor" }],
      ["stale", false, { binding: "old-revision" }],
      ["legacy", true, { binding: "session-legacy", startedAt: 90 }],
      ["reset", false, { binding: "session-reset", startedAt: 110 }],
      ["missing", false, { missing: true }],
      ["incognito-private", false],
      ["unqualified", false, { sessionKey: "agent:coder:main", metadataKey: "main" }],
      ["alias", false, { metadataKey: "agent:CODER:acp:alias" }],
      ["internal", false, { sessionKey: "agent:coder:internal-session-effects:fixture" }],
    ];
    for (const [name, , options] of candidates) {
      await seed(name, options);
    }
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
    const expectOwnership = async (
      resumeSessionId: string,
      allowed: boolean,
      overrides: Partial<typeof input> = {},
    ) => {
      expect(
        (await validateAcpResumeSessionOwnership({ ...input, ...overrides, resumeSessionId })).ok,
        `${resumeSessionId}: ${overrides.requesterSessionKey ?? requester}/${overrides.runtimeAgentId ?? "coder"}`,
      ).toBe(allowed);
    };
    for (const [requesterSessionKey, runtimeAgentId, allowed] of [
      [requester, "coder", true],
      ["agent:other:main", "coder", false],
      [requester, "cursor", false],
    ] as const) {
      await expectOwnership("owned", allowed, {
        ownerAgentId: "reviewer",
        runtimeAgentId,
        requesterSessionKey,
      });
    }
    const observe = observeHostDataSql();
    try {
      for (const [id, allowed] of [
        ["owned", true],
        ["acpx-owned", true],
        ...candidates,
        ["absent", false],
        ["trimmed", true],
        ["duplicate-live", true],
        ["duplicate-denied", false],
      ] as const) {
        await expectOwnership(id, allowed);
      }
      await expectOwnership("owned", true, { requesterSessionKey: owned.sessionKey });
      await expectOwnership("owned", false, { requesterSessionKey: undefined });
      expect(observe.queries).toEqual([]);
    } finally {
      observe.restore();
    }

    const read = entryReader.withSessionEntryReadOnlyInWorker;
    const writeMeta = (source: typeof owned, meta: SessionAcpMeta) =>
      writeAcpSessionMetaForMigration({
        sessionKey: buildAcpDatabaseSessionKey(source.sessionKey, "coder"),
        lifecycleRevision: source.entry?.lifecycleRevision,
        meta,
        env: state.env,
      });
    const changeOwnedMetaDuringRead = (meta: SessionAcpMeta) =>
      vi
        .spyOn(entryReader, "withSessionEntryReadOnlyInWorker")
        .mockImplementationOnce((scope, assertCurrent, consume) =>
          read(scope, assertCurrent, async (snapshot, owner) => {
            writeMeta(owned, meta);
            return consume(snapshot, owner);
          }),
        );
    const changedAgent = changeOwnedMetaDuringRead({ ...owned.meta, agent: "cursor" });
    await expectOwnership("owned", false).finally(() => {
      changedAgent.mockRestore();
      writeMeta(owned, owned.meta);
    });
    const changedIdentity = changeOwnedMetaDuringRead({
      ...owned.meta,
      identity: {
        state: "resolved",
        source: "ensure",
        lastUpdatedAt: 200,
        agentSessionId: "replacement",
      },
    });
    await expectOwnership("owned", false).finally(() => changedIdentity.mockRestore());
    let active = true;
    const intercept = vi
      .spyOn(entryReader, "withSessionEntryReadOnlyInWorker")
      .mockImplementation((...args) => {
        active = false;
        return read(...args);
      });
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
    )
      .rejects.toThrow("request retired")
      .finally(() => intercept.mockRestore());

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
      const sourceEntry = expectDefined(source.entry, "resume source fixture was not created");
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
        const reassign = () =>
          replaceSessionEntry(scope, {
            ...sourceEntry,
            spawnedBy: "agent:other:main",
            parentSessionKey: "agent:other:main",
          });
        if (mutation === "reassigned") {
          await reassign();
        } else if (mutation === "runtime") {
          writeMeta(source, { ...source.meta, agent: "cursor" });
        } else if (mutation === "deleted") {
          await expect(
            deleteSessionEntryLifecycle({
              ...scope,
              storePath: resolveSessionStorePathCore(cfg.session?.store, scope),
              target: { canonicalKey: source.sessionKey, storeKeys: [source.sessionKey] },
              archiveTranscript: false,
            }),
          ).resolves.toMatchObject({ deleted: true });
        } else if (mutation === "retired") {
          current = false;
        } else if (mutation === "snapshot-reassigned") {
          const changedOwner = vi
            .spyOn(entryReader, "withSessionEntryReadOnlyInWorker")
            .mockImplementationOnce((readScope, assertReadCurrent, consume) =>
              read(readScope, assertReadCurrent, async (snapshot, owner) => {
                expect(readScope.sessionKey).toBe(source.sessionKey);
                expect(snapshot).toMatchObject({ ok: true, value: { spawnedBy: requester } });
                await reassign();
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
      const revalidate = expectDefined(retained.revalidateResume, "resume authorization callback");
      await expect(revalidate()).rejects.toThrow(
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
