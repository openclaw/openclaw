import { existsSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import type { SessionActorAuthority } from "../../config/sessions/session-actor-contract.js";
import { createMemorySessionActorOwner } from "../../config/sessions/session-actor-memory.js";
import { runWithSessionActorStorage } from "../../config/sessions/session-actor-storage-binding.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareAcpSessionControlRead } from "./session-meta-control.js";
import { readAcpSessionEntryAsync } from "./session-meta-read.js";
import { upsertAcpSessionMeta } from "./session-meta-write.js";

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
});

it("joins actor entries with shared ACP receipts at the control effect without host SQL", async () => {
  await withOpenClawTestState({ label: "acp-memory-control" }, async (state) => {
    const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
    const sessionKey = "agent:main:dashboard:incognito-acp";
    const scope = { cfg, agentId: "main", sessionKey };
    const actorPath = state.path("memory-owner");
    const owner = createMemorySessionActorOwner({ agentId: "main", path: actorPath });
    const actor = await owner.acquire(
      { database: owner.identity, sessionKey },
      { assertCurrent() {}, assertReadable() {} },
    );
    const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
    const storage = actor.storage!;
    expect(
      (
        await storage.mutate(
          {
            type: "session.entry.create",
            input: {
              entry: {
                sessionId: "session",
                lifecycleRevision: "lifecycle",
                spawnedBy: "agent:main:parent",
                updatedAt: 100,
                incognito: true,
              },
            },
          },
          authority,
        )
      ).kind,
    ).toBe("committed");
    const binding = { actor, authority, agentId: "main", path: actorPath };
    const meta: SessionAcpMeta = {
      backend: "fixture",
      agent: "fixture",
      runtimeSessionName: "first-runtime",
      mode: "persistent",
      state: "idle",
      lastActivityAt: 100,
    };
    try {
      await runWithSessionActorStorage(binding, async () => {
        let control: Awaited<ReturnType<typeof prepareAcpSessionControlRead>> | undefined;
        await upsertAcpSessionMeta({ ...scope, mutate: () => meta });
        const observe = observeHostDataSql();
        try {
          expect(actor.snapshot(authority)?.entry?.acp).toBeUndefined();
          expect((await readAcpSessionEntryAsync(scope))?.acp).toMatchObject(meta);
          expect(
            (
              await storage.mutate(
                {
                  type: "session.entry.patch",
                  input: { operation: { kind: "fields", patch: { label: "retained-label" } } },
                },
                authority,
              )
            ).kind,
          ).toBe("committed");
          control = await prepareAcpSessionControlRead(scope);
          control.initialRead.session.acp!.runtimeSessionName = "caller-edited-output";
          control.assertNativeAcpCurrent?.(cfg, meta);
          const nextMeta = { ...meta, runtimeSessionName: "second-runtime" };
          const updateLabel = () =>
            storage.mutate(
              {
                type: "session.entry.patch",
                input: { operation: { kind: "fields", patch: { label: "concurrent-label" } } },
              },
              authority,
            );
          await upsertAcpSessionMeta({
            ...scope,
            assertCommitAllowed: () => control?.assertNativeAcpCurrent?.(cfg, meta),
            mutate: () => {
              void updateLabel();
              return nextMeta;
            },
          });
          expect(actor.snapshot(authority)?.entry?.label).toBe("concurrent-label");
          expect(() => control?.assertNativeAcpCurrent?.(cfg, meta)).toThrow(/locator changed/);
          control.assertNativeAcpCurrent?.(cfg, nextMeta);
          expect((await control.readCurrent(cfg)).session.acp).toMatchObject(nextMeta);
          await upsertAcpSessionMeta({
            ...scope,
            assertCommitAllowed: () => control?.assertNativeAcpCurrent?.(cfg, nextMeta),
            mutate: () => null,
          });
          expect(() => control?.assertNativeAcpCurrent?.(cfg, nextMeta)).toThrow(/locator changed/);
          expect((await readAcpSessionEntryAsync(scope))?.acp).toBeUndefined();
          owner.closeSession(sessionKey);
          expect(() => control?.assertCurrent(cfg)).toThrow();
          expect(observe.queries).toEqual([]);
          expect(existsSync(actorPath)).toBe(false);
        } finally {
          control?.release();
          observe.restore();
        }
      });
    } finally {
      await actor.release();
      owner.close();
    }
  });
});
