import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.sqlite-entry.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../../config/sessions/session-accessor.sqlite-scope.js";
import { memorySessionActorOwners } from "../../../config/sessions/session-actor-memory-owner.js";
import * as sessionReads from "../../../config/sessions/session-entry-read-runtime.js";
import {
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  createNativeSessionBindingAuthority,
  readNativeSessionBindingEntries,
} from "./binding-authority.js";

afterEach(() => memorySessionActorOwners.reset());

it("admits incognito predecessor lineage without SQL and rejects changed lineage", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const scope = { agentId: "main", sessionKey: "agent:main:dashboard:incognito-lineage", env };
    const entry = { sessionId: "current", previousSessionId: "predecessor", updatedAt: 1 };
    await replaceSessionEntry(scope, entry);
    const storePath = resolveIncognitoOpenClawAgentSqlitePath(scope);
    const authority = createNativeSessionBindingAuthority(
      [
        {
          read: { ...scope, storePath },
          sessionId: entry.sessionId,
          previousSessionId: entry.previousSessionId,
          createSupersededError: () => new Error("native lineage superseded"),
        },
      ],
      () => {},
    );
    const queries = observeHostDataSql();
    let mutation: Awaited<ReturnType<typeof authority.prepareMutation>>;
    try {
      await expect(authority.withCurrent(() => "admitted")).resolves.toBe("admitted");
      mutation = await authority.prepareMutation();
      mutation.assertCurrent();
      expect(queries.queries).toEqual([]);
    } finally {
      queries.restore();
    }
    await replaceSessionEntry(scope, {
      ...entry,
      previousSessionId: "changed-predecessor",
      updatedAt: 2,
    });
    expect(mutation.assertCurrent).toThrow("native lineage superseded");
    await expect(authority.withCurrent(() => "stale")).rejects.toThrow("native lineage superseded");
    await expect(authority.prepareMutation()).rejects.toThrow("native lineage superseded");
  });
});

it("keeps the incognito source incarnation across a durable lineage wait", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const scope = { agentId: "main", sessionKey: "agent:main:dashboard:incognito-custody", env };
    const entry = { sessionId: "same-session", updatedAt: 1 };
    await replaceSessionEntry(scope, entry);
    const memory = { agentId: scope.agentId, path: resolveIncognitoOpenClawAgentSqlitePath(scope) };
    const durableScope = { agentId: "main", sessionKey: "agent:main:durable-custody", env };
    replaceSessionEntrySync(durableScope, { sessionId: "durable", updatedAt: 1 });
    const durable = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(durableScope)));
    const started = createDeferred();
    const proceed = createDeferred();
    const read = sessionReads.withSessionEntriesFromStoresInWorker;
    const delayed = vi
      .spyOn(sessionReads, "withSessionEntriesFromStoresInWorker")
      .mockImplementationOnce(async (inputs, consume, options) => {
        started.resolve();
        await proceed.promise;
        return read(inputs, consume, options);
      });
    const consume = vi.fn();
    const outcome = readNativeSessionBindingEntries(
      [
        { ...scope, storePath: memory.path },
        { ...durableScope, storePath: durable.path },
      ],
      consume,
    ).catch((error: unknown) => error);
    try {
      await started.promise;
      memorySessionActorOwners.closeDatabase(memory);
      await replaceSessionEntry(scope, entry);
      proceed.resolve();
      expect(await outcome).toMatchObject({ message: "Incognito session actor owner is closed" });
      expect(consume).not.toHaveBeenCalled();
    } finally {
      proceed.resolve();
      await outcome;
      delayed.mockRestore();
    }
  });
});
