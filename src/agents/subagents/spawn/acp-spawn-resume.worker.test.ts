import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { buildAcpDatabaseSessionKey } from "../../../acp/runtime/session-meta-keys.js";
import { writeAcpSessionMetaForMigration } from "../../../acp/runtime/session-meta.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import * as entryReader from "../../../config/sessions/session-entry-read-runtime.js";
import type { SessionAcpMeta } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { validateAcpResumeSessionOwnership } from "./acp-spawn-requester.js";

it("resolves resume ownership off-thread, preserving backend, order, and lifecycle fences", async () => {
  await withOpenClawTestState({ scenario: "minimal", label: "acp-resume" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {}, coder: {}, other: {} } },
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
        agent: agentId,
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
      targetAgentId: "coder",
      backendId: "fixture",
      requesterSessionKey: requester,
    };
    const cases = [
      ["owned", true],
      ["acpx-owned", true],
      ["parent", true],
      ["foreign", false],
      ["backend", false],
      ["agent", false],
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
  });
});
