import { expect, it, vi } from "vitest";
import * as configRuntime from "../../../config/config.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import { retainSessionEntryWorkerPublication } from "../../../config/sessions/session-accessor.sqlite-entry-worker-publication.js";
import { withSessionEntriesFromStoreInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  captureRequesterSessionEntryCurrent,
  loadRequesterSessionEntry,
} from "./subagent-announce-delivery.runtime.js";

it("keeps requester identity through metadata publication but retires it on lifecycle replacement", async () => {
  await withOpenClawTestState({ label: "requester-current" }, async () => {
    const agentId = "main";
    const sessionKey = "agent:main:main";
    const storePath = resolveOpenClawAgentSqlitePath({ agentId });
    const scope = { agentId, sessionKey, storePath };
    const config = vi
      .spyOn(configRuntime, "getRuntimeConfig")
      .mockReturnValue({ session: { store: storePath } });
    let current: Awaited<ReturnType<typeof captureRequesterSessionEntryCurrent>> | undefined;
    try {
      await replaceSessionEntry(scope, {
        sessionId: "requester",
        lifecycleRevision: "first",
        updatedAt: 1,
      });
      current = await captureRequesterSessionEntryCurrent(sessionKey, agentId);
      expect(current.readCurrent()?.lifecycleRevision).toBe("first");
      const databaseIdentity = await withSessionEntriesFromStoreInWorker(
        { agentId, storePath, sessionKeys: [sessionKey], snapshotFields: [] },
        async ({ result }) => result.databaseIdentity?.identity,
      );
      if (!databaseIdentity) {
        throw new Error("Expected durable requester fixture");
      }
      const publication = retainSessionEntryWorkerPublication({ ...scope, databaseIdentity });
      publication.beginChanges(
        [sessionKey],
        new Map(),
        [sessionKey],
        undefined,
        new Map([
          [sessionKey, { sessionId: "requester", lifecycleRevision: "first", updatedAt: 2 }],
        ]),
      );
      try {
        expect(current.readCurrent()).toMatchObject({
          sessionId: "requester",
          lifecycleRevision: "first",
        });
      } finally {
        publication.settle(undefined, false);
      }
      await replaceSessionEntry(scope, {
        sessionId: "requester",
        lifecycleRevision: "replacement",
        updatedAt: 2,
      });
      expect(current.readCurrent()).toBeUndefined();
      expect((await loadRequesterSessionEntry(sessionKey, agentId)).entry?.lifecycleRevision).toBe(
        "replacement",
      );
    } finally {
      current?.release();
      config.mockRestore();
    }
  });
});
