import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionActorAuthority } from "../../../config/sessions/session-actor-contract.js";
import { memorySessionActorOwners } from "../../../config/sessions/session-actor-memory-owner.js";
import { readSessionActorStorageResult } from "../../../config/sessions/session-actor-storage-result.js";
import { loadSessionTranscriptEvents } from "../../../config/sessions/session-transcript-events.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { appendDeniedSubagentRecoveryNotice } from "./subagent-registry-recovery-notice.js";
const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const scope = {
  agentId: "main",
  sessionKey: "agent:main:subagent:denied",
  storePath: resolveIncognitoOpenClawAgentSqlitePath({
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: "/synthetic/custody-denied" },
  }),
};
const original: InternalSessionEntry = {
  sessionId: "child-session",
  lifecycleRevision: "child-revision",
  status: "interrupted",
  lastRunId: "child-run",
  lifecycleRunId: "child-run",
  updatedAt: 1,
  incognito: true,
};
afterEach(() =>
  memorySessionActorOwners.closeDatabase({ agentId: scope.agentId, path: scope.storePath }),
);
async function fixture(entry = original) {
  const owner = memorySessionActorOwners.get({ agentId: scope.agentId, path: scope.storePath });
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey: scope.sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  readSessionActorStorageResult(
    await actor.storage!.mutate({ type: "session.entry.create", input: { entry } }, authority),
  );
  await actor.release();
}
const append = (entry = original, extra = {}) =>
  appendDeniedSubagentRecoveryNotice({
    ...scope,
    runId: "child-run",
    reason: "original grant revoked",
    entry,
    suppressSessionEffects: false,
    assertCurrent() {},
    ...extra,
  });
const messages = async () =>
  (await loadSessionTranscriptEvents({ ...scope, sessionId: original.sessionId })).filter(
    (event) => isRecord(event) && event.type === "message",
  );
describe("denied original source child-local interruption", () => {
  it("appends once across repeated recovery without delivering to the requester", async () => {
    await fixture();
    await append();
    await append();
    expect(await messages()).toHaveLength(1);
  });
  it.each(["session", "lifecycle", "state"])(
    "refuses a stale %s without recreating or mutating it",
    async (field) => {
      await fixture({
        ...original,
        ...(field === "session"
          ? { sessionId: "successor" }
          : field === "lifecycle"
            ? { lifecycleRevision: "successor" }
            : { status: "done" as const }),
      });
      await expect(append()).rejects.toThrow("notice was not saved");
      expect(await messages()).toHaveLength(0);
    },
  );
  it.each(["wrong-run", "wrong-lifecycle-run", "running", "suppressed"])(
    "does not append for %s",
    async (change) => {
      await fixture();
      await append(
        {
          ...original,
          ...(change === "wrong-run"
            ? { lastRunId: "other" }
            : change === "wrong-lifecycle-run"
              ? { lifecycleRunId: "other" }
              : change === "running"
                ? { status: "done" as const }
                : {}),
        },
        { suppressSessionEffects: change === "suppressed" },
      );
      expect(await messages()).toHaveLength(0);
    },
  );
  it("rejects a retired host before touching the child transcript", async () => {
    await fixture();
    await expect(
      append(original, {
        assertCurrent() {
          throw new Error("retired host");
        },
      }),
    ).rejects.toThrow("retired host");
    expect(await messages()).toHaveLength(0);
  });
});
