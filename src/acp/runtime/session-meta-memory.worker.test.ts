import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { failSessionActorMemoryPublication } from "../../config/sessions/session-actor-memory-publication.test-support.js";
import { acquireSessionActorStorage } from "../../config/sessions/session-actor-storage-binding.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
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
} satisfies InternalSessionEntry;

it("settles shared ACP metadata before reporting the committed entry publication failure", async () => {
  await withOpenClawTestState({ label: "acp-memory-publication" }, async (state) => {
    const scope = memoryScope(state.env, "agent:main:dashboard:incognito-acp-publication");
    await replaceSessionEntry(scope, { ...entry });
    const meta = createAcpMeta({ agent: "fixture", runtimeSessionName: "saved-runtime" });
    const stop = failSessionActorMemoryPublication(scope.sessionKey);
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
    const scope = memoryScope(state.env, "agent:main:dashboard:incognito-acp");
    const { cfg, sessionKey } = scope;
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
    const meta = createAcpMeta({ agent: "fixture", runtimeSessionName: "first-runtime" });
    const patchLabel = (label: string) =>
      actor.storage.mutate(
        {
          type: "session.entry.patch",
          input: { operation: { kind: "fields", patch: { label } } },
        },
        authority,
      );
    let control: Awaited<ReturnType<typeof prepareAcpSessionControlRead>> | undefined;
    let observe: ReturnType<typeof observeHostDataSql> | undefined;
    try {
      await upsertAcpSessionMeta({ ...scope, mutate: () => meta });
      observe = observeHostDataSql();
      expect(actor.snapshot(authority)?.entry?.acp).toBeUndefined();
      const alias = { ...scope, sessionKey: ` ${sessionKey.toUpperCase()} ` };
      expect((await readAcpSessionEntryAsync(alias))?.acp).toMatchObject(meta);
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
      observe?.restore();
      await actor.release();
      memorySessionActorOwners.closeDatabase(ownerScope);
    }
  });
});
