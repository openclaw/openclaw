import "../../../config/sessions/session-accessor.sqlite-replacement-publication.test-support.js";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../../test/helpers/promise.js";
import * as configRuntime from "../../../config/config.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import { applySessionEntryExactReplacements } from "../../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createEnteredGate } from "../../entered-gate.test-support.js";
import {
  captureRequesterSessionEntryCurrent,
  loadRequesterSessionEntry,
} from "./subagent-announce-delivery.runtime.js";

const { getReplacementPublicationDelivery } =
  await import("../../../config/sessions/session-accessor.sqlite-replacement-publication.test-support.js");
const delivery = getReplacementPublicationDelivery();

it("keeps requester identity through metadata publication but retires it on lifecycle replacement", async ({
  signal,
}) => {
  await withOpenClawTestState({ label: "requester-current" }, async () => {
    const agentId = "main";
    const sessionKey = "agent:main:main";
    const storePath = resolveOpenClawAgentSqlitePath({ agentId });
    const scope = { agentId, sessionKey, storePath };
    const config = vi
      .spyOn(configRuntime, "getRuntimeConfig")
      .mockReturnValue({ session: { store: storePath } });
    let current: Awaited<ReturnType<typeof captureRequesterSessionEntryCurrent>> | undefined;
    let missing: Awaited<ReturnType<typeof captureRequesterSessionEntryCurrent>> | undefined;
    const publicationGate = createEnteredGate();
    const onAbort = () => publicationGate.release();
    signal.addEventListener("abort", onAbort, { once: true });
    let metadata: Promise<unknown> | undefined;
    try {
      missing = await captureRequesterSessionEntryCurrent(sessionKey, agentId);
      expect(missing.readCurrent()).toBeUndefined();
      await replaceSessionEntry(scope, {
        sessionId: "requester",
        lifecycleRevision: "first",
        updatedAt: 1,
      });
      current = await captureRequesterSessionEntryCurrent(sessionKey, agentId);
      expect(current.readCurrent()?.lifecycleRevision).toBe("first");
      expect(missing.readCurrent()).toBeUndefined();
      delivery.afterResult = publicationGate.wait;
      metadata = applySessionEntryExactReplacements({
        ...scope,
        sessionKeys: [sessionKey],
        requireWriteSuccess: true,
        update: () => ({
          result: undefined,
          replacements: [
            {
              sessionKey,
              entry: {
                sessionId: "requester",
                lifecycleRevision: "first",
                lifecycleRunId: "active-run",
                updatedAt: 2,
              },
            },
          ],
        }),
      });
      await withinTest(
        awaitGateBeforeSettlement(
          publicationGate.entered,
          metadata,
          "run metadata did not reach publication",
        ),
        signal,
      );
      expect(current.readCurrent()).toMatchObject({
        sessionId: "requester",
        lifecycleRevision: "first",
      });
      publicationGate.release();
      await withinTest(metadata, signal);
      delivery.afterResult = undefined;
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
      publicationGate.release();
      delivery.afterResult = undefined;
      await Promise.allSettled([metadata]);
      signal.removeEventListener("abort", onAbort);
      current?.release();
      missing?.release();
      config.mockRestore();
    }
  });
});
