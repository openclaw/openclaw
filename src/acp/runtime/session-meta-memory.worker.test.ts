import { existsSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { acquireSessionActorStorage } from "../../config/sessions/session-actor-storage-binding.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareAcpSessionControlRead } from "./session-meta-control.js";
import { readAcpSessionEntryAsync } from "./session-meta-read.js";
import { upsertAcpSessionMeta } from "./session-meta-write.js";
import { readAcpSessionEntry } from "./session-meta.js";

afterEach(async () => {
  memorySessionActorOwners.reset();
  await closeOpenClawStateDatabaseAsync();
});

it("acquires unbound actor entries and joins shared ACP receipts at the control effect without host SQL", async () => {
  await withOpenClawTestState({ label: "acp-memory-control" }, async (state) => {
    const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
    const sessionKey = "agent:main:dashboard:incognito-acp";
    const scope = { cfg, env: state.env, agentId: "main", sessionKey };
    const actorPath = resolveIncognitoOpenClawAgentSqlitePath(scope);
    const ownerScope = { agentId: "main", path: actorPath };
    expect(() => readAcpSessionEntry(scope)).toThrow(/readAcpSessionEntryAsync/);
    expect(await readAcpSessionEntryAsync(scope)).toBeNull();
    expect(memorySessionActorOwners.read(ownerScope)).toBeUndefined();
    await replaceSessionEntry(scope, {
      sessionId: "session",
      lifecycleRevision: "lifecycle",
      spawnedBy: "agent:main:parent",
      updatedAt: 100,
      incognito: true,
    });
    const binding = await acquireSessionActorStorage(scope, {
      lifetime: { assertCurrent() {}, assertReadable() {} },
      authority: { assertCurrent() {}, authorize() {} },
    });
    if (!binding) {
      throw new Error("Expected the created memory actor");
    }
    const { actor, authority } = binding;
    const storage = actor.storage;
    const meta: SessionAcpMeta = {
      backend: "fixture",
      agent: "fixture",
      runtimeSessionName: "first-runtime",
      mode: "persistent",
      state: "idle",
      lastActivityAt: 100,
    };
    try {
      let control: Awaited<ReturnType<typeof prepareAcpSessionControlRead>> | undefined;
      await upsertAcpSessionMeta({ ...scope, mutate: () => meta });
      const observe = observeHostDataSql();
      try {
        expect(actor.snapshot(authority)?.entry?.acp).toBeUndefined();
        expect(
          (
            await readAcpSessionEntryAsync({
              ...scope,
              sessionKey: ` ${sessionKey.toUpperCase()} `,
            })
          )?.acp,
        ).toMatchObject(meta);
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
        control.assertAcpCurrent?.(cfg, meta);
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
          assertCommitAllowed: () => control?.assertAcpCurrent?.(cfg, meta),
          mutate: () => {
            void updateLabel();
            return nextMeta;
          },
        });
        expect(actor.snapshot(authority)?.entry?.label).toBe("concurrent-label");
        expect(() => control?.assertAcpCurrent?.(cfg, meta)).toThrow(/locator changed/);
        control.assertAcpCurrent?.(cfg, nextMeta);
        expect((await control.readCurrent(cfg)).session.acp).toMatchObject(nextMeta);
        await upsertAcpSessionMeta({
          ...scope,
          assertCommitAllowed: () => control?.assertAcpCurrent?.(cfg, nextMeta),
          mutate: () => null,
        });
        expect(() => control?.assertAcpCurrent?.(cfg, nextMeta)).toThrow(/locator changed/);
        expect((await readAcpSessionEntryAsync(scope))?.acp).toBeUndefined();
        memorySessionActorOwners.closeSession(ownerScope, sessionKey);
        expect(() => control?.assertCurrent(cfg)).toThrow();
        expect(observe.queries).toEqual([]);
        expect(existsSync(actorPath)).toBe(false);
      } finally {
        control?.release();
        observe.restore();
      }
    } finally {
      await actor.release();
      memorySessionActorOwners.closeDatabase(ownerScope);
    }
  });
});
