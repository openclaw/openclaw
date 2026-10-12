import { expect, it, vi } from "vitest";
import * as configRuntime from "../../../config/config.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  captureRequesterSessionEntryCurrent,
  loadRequesterSessionEntry,
} from "./subagent-announce-delivery.runtime.js";

it("updates prepared requester guards after the session writer commits", async () => {
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
      await replaceSessionEntry(scope, {
        sessionId: "requester",
        lifecycleRevision: "replacement",
        updatedAt: 2,
      });
      expect(current.readCurrent()?.lifecycleRevision).toBe("replacement");
      expect((await loadRequesterSessionEntry(sessionKey, agentId)).entry?.lifecycleRevision).toBe(
        "replacement",
      );
    } finally {
      current?.release();
      config.mockRestore();
    }
  });
});
