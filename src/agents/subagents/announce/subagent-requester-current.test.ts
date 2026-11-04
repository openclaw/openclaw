import { expect, it, vi } from "vitest";
import * as configRuntime from "../../../config/config.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  captureRequesterSessionEntryCurrent,
  loadRequesterSessionEntry,
} from "./subagent-announce-delivery.runtime.js";

it("keeps requester identity through metadata updates but retires it on lifecycle replacement", async () => {
  await withOpenClawTestState({ label: "requester-current" }, async () => {
    const agentId = "main";
    const sessionKey = "agent:main:main";
    const storePath = resolveOpenClawAgentSqlitePath({ agentId });
    const scope = { agentId, sessionKey, storePath };
    const entry = (lifecycleRevision: string, updatedAt = 2) => ({
      sessionId: "requester",
      lifecycleRevision,
      updatedAt,
    });
    const config = vi
      .spyOn(configRuntime, "getRuntimeConfig")
      .mockReturnValue({ session: { store: storePath } });
    let current: Awaited<ReturnType<typeof captureRequesterSessionEntryCurrent>> | undefined;
    let missing: Awaited<ReturnType<typeof captureRequesterSessionEntryCurrent>> | undefined;
    try {
      missing = await captureRequesterSessionEntryCurrent(sessionKey, agentId);
      expect(missing.readCurrent()).toBeUndefined();
      await replaceSessionEntry(scope, entry("first", 1));
      current = await captureRequesterSessionEntryCurrent(sessionKey, agentId);
      expect(current.readCurrent()?.lifecycleRevision).toBe("first");
      expect(missing.readCurrent()).toBeUndefined();
      await replaceSessionEntry(scope, { ...entry("first"), lifecycleRunId: "active-run" });
      expect(current.readCurrent()).toMatchObject({
        sessionId: "requester",
        lifecycleRevision: "first",
      });
      await replaceSessionEntry(scope, entry("replacement"));
      expect(current.readCurrent()).toBeUndefined();
      expect((await loadRequesterSessionEntry(sessionKey, agentId)).entry?.lifecycleRevision).toBe(
        "replacement",
      );
    } finally {
      current?.release();
      missing?.release();
      config.mockRestore();
    }
  });
});
