import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { deleteSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  observeHostDataSql,
  openIncognitoTestActor,
  withIncognitoSessionBinding,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { createHarness } from "./service-test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const authority = { assertCurrent() {} };
const sessionKey = "agent:main:dashboard:incognito-discussion";

it("opens, reads and detaches a bound discussion without native session reads", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("clickclack-bound-") };
  const actor = await openIncognitoTestActor(env, authority);
  const harness = createHarness(undefined);
  harness.runtime.agent.session.resolveStorePath = () => actor.path;
  const nativeRead = vi.fn(() => {
    throw new Error("Bound discussion entered native session storage");
  });
  harness.runtime.agent.session.getSessionEntry = nativeRead;
  harness.runtime.agent.session.getSessionEntryAsync = nativeRead;
  try {
    await actor.sessions.create(authority, {
      sessionKey,
      entry: {
        sessionId: "discussion-source",
        updatedAt: 1,
        label: "Private discussion",
        incognito: true,
      },
    });
    await withIncognitoSessionBinding({ actor }, async () => {
      const sql = observeHostDataSql();
      try {
        await expect(harness.service.open(sessionKey)).resolves.toMatchObject({ state: "open" });
        await expect(harness.service.readLatestMessages(sessionKey, 5)).resolves.toMatchObject({
          binding: { sessionId: "discussion-source" },
          text: "The bound discussion has no messages yet.",
        });
        await deleteSessionEntry({ agentId: "main", storePath: actor.path, sessionKey });
        await harness.service.reconcile(sessionKey);
        expect(harness.store.lookup(sessionKey)).toMatchObject({ detachedAt: expect.any(Number) });
        expect(nativeRead).not.toHaveBeenCalled();
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
    });
  } finally {
    await harness.service.cleanup();
    await actor.close();
  }
});

it("refuses a retired actor after workspace discovery before publishing a discussion", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("clickclack-revoked-") };
  const actor = await openIncognitoTestActor(env, authority);
  const harness = createHarness(undefined);
  harness.runtime.agent.session.resolveStorePath = () => actor.path;
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const workspaces = harness.client.workspaces;
  harness.client.workspaces = async () => {
    entered.resolve();
    await release.promise;
    return await workspaces();
  };
  await actor.sessions.create(authority, {
    sessionKey,
    entry: {
      sessionId: "discussion-source",
      updatedAt: 1,
      label: "Private discussion",
      incognito: true,
    },
  });
  const opening = withIncognitoSessionBinding({ actor }, () => harness.service.open(sessionKey));
  const rejected = expect(opening).rejects.toMatchObject({ code: "INCOGNITO_SESSION_ENDED" });
  try {
    await entered.promise;
    await actor.close();
    release.resolve();
    await rejected;
    expect(harness.createChannel).not.toHaveBeenCalled();
    expect(harness.store.lookup(sessionKey)).toBeUndefined();
  } finally {
    release.resolve();
    await Promise.allSettled([opening, harness.service.cleanup(), actor.close()]);
  }
});
