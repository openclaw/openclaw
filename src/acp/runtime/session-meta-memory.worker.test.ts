import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { failSessionActorMemoryPublication } from "../../config/sessions/session-actor-memory-publication.test-support.js";
import { acquireSessionActorStorage } from "../../config/sessions/session-actor-storage-binding.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareAcpSessionControlRead } from "./session-meta-control.js";
import { createAcpMeta } from "./session-meta-lifecycle.test-support.js";
import { readAcpSessionEntryAsync } from "./session-meta-read.js";
import { upsertAcpSessionMeta } from "./session-meta-write.js";
import { readAcpSessionEntry } from "./session-meta.js";

function memoryScope(env: NodeJS.ProcessEnv, sessionKey: string) {
  const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
  return { cfg, env, agentId: "main", sessionKey };
}
const entry = {
  sessionId: "session",
  lifecycleRevision: "lifecycle",
  updatedAt: 100,
  incognito: true,
};

it("settles shared ACP metadata before reporting the committed entry publication failure", async () => {
  await withOpenClawTestState({ label: "acp-memory-publication" }, async (state) => {
    const sessionKey = "agent:main:dashboard:incognito-acp-publication";
    const scope = memoryScope(state.env, sessionKey);
    await replaceSessionEntry(scope, { ...entry });
    const meta = createAcpMeta({ agent: "fixture", runtimeSessionName: "saved-runtime" });
    const stop = failSessionActorMemoryPublication(sessionKey);
    try {
      await expect(upsertAcpSessionMeta({ ...scope, mutate: () => meta })).rejects.toMatchObject({
        name: "SessionActorStorageCommittedError",
      });
    } finally {
      stop();
    }
    expect((await readAcpSessionEntryAsync(scope))?.acp).toEqual(meta);
  });
});

it("acquires unbound actor entries and joins shared ACP receipts at the control effect without host SQL", async () => {
  await withOpenClawTestState({ label: "acp-memory-control" }, async (state) => {
    const sessionKey = "agent:main:dashboard:incognito-acp";
    const scope = memoryScope(state.env, sessionKey);
    const { cfg } = scope;
    const actorPath = resolveIncognitoOpenClawAgentSqlitePath(scope);
    const ownerScope = { agentId: "main", path: actorPath };
    expect(() => readAcpSessionEntry(scope)).toThrow(/readAcpSessionEntryAsync/);
    expect(await readAcpSessionEntryAsync(scope)).toBeNull();
    expect(memorySessionActorOwners.read(ownerScope)).toBeUndefined();
    await replaceSessionEntry(scope, { ...entry, spawnedBy: "agent:main:parent" });
    const binding = await acquireSessionActorStorage(scope, {
      lifetime: { assertCurrent() {}, assertReadable() {} },
      authority: { assertCurrent() {}, authorize() {} },
    });
    if (!binding) {
      throw new Error("Expected the created memory actor");
    }
    const { actor, authority } = binding;
    const storage = actor.storage;
    const meta = createAcpMeta({ agent: "fixture", runtimeSessionName: "first-runtime" });
    const patchLabel = (label: string) =>
      storage.mutate(
        {
          type: "session.entry.patch",
          input: { operation: { kind: "fields", patch: { label } } },
        },
        authority,
      );
    try {
      let control: Awaited<ReturnType<typeof prepareAcpSessionControlRead>> | undefined;
      await upsertAcpSessionMeta({ ...scope, mutate: () => meta });
      const observe = observeHostDataSql();
      try {
        expect(actor.snapshot(authority)?.entry?.acp).toBeUndefined();
        const read = await readAcpSessionEntryAsync({
          ...scope,
          sessionKey: ` ${sessionKey.toUpperCase()} `,
        });
        expect(read?.acp).toMatchObject(meta);
        expect((await patchLabel("retained-label")).kind).toBe("committed");
        control = await prepareAcpSessionControlRead(scope);
        control.initialRead.session.acp!.runtimeSessionName = "caller-edited-output";
        control.assertAcpCurrent?.(cfg, meta);
        const nextMeta = { ...meta, runtimeSessionName: "second-runtime" };
        await upsertAcpSessionMeta({
          ...scope,
          assertCommitAllowed: () => control?.assertAcpCurrent?.(cfg, meta),
          mutate: () => {
            void patchLabel("concurrent-label");
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
