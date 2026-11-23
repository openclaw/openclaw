import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry-state.fixture.test-support.js";
import { useCompletionDatabase } from "./completion-database.test-support.js";
import { appendChildStatusToRequester } from "./subagent-completion-admission.store.js";
import {
  records,
  seedSubagentCompletionOwner,
} from "./subagent-completion-admission.test-helpers.js";

const db = useCompletionDatabase("openclaw-completion-failure-notice-");

async function fixture(count: number) {
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:main",
    storePath: path.join(process.env.OPENCLAW_STATE_DIR!, "sessions.json"),
    sessionId: "notice-requester",
  };
  await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
  const batch = Array.from({ length: count }, (_, index) => {
    const { subagent } = records();
    const id = String(index).padStart(3, "0");
    subagent.runId = `notice-run-${id}`;
    subagent.childSessionKey = `agent:main:subagent:notice-${id}`;
    subagent.requesterStorePath = scope.storePath;
    subagent.delivery = { status: "pending", generation: 1 };
    subagent.completion!.resultText = `answer-${id}\n${"🌊".repeat(3_000)}\nTAIL-${id}`;
    seedSubagentCompletionOwner({ subagent, databaseOptions: { database: db.value } });
    return subagent;
  });
  const readNotice = async () => {
    const notices = (await loadTranscriptEvents(scope)).filter(
      (event): event is Record<string, unknown> =>
        isRecord(event) &&
        event.type === "custom_message" &&
        event.customType === "subagent-completion",
    );
    expect(notices).toHaveLength(1);
    const notice = notices[0]!;
    expect(typeof notice.content).toBe("string");
    return { ...notice, text: String(notice.content) };
  };
  return { batch, readNotice };
}

it("preserves captured results in model-visible requester history", async () => {
  const { batch, readNotice } = await fixture(4);
  batch[1]!.completionTarget = "parent";
  batch[2]!.requesterSettleWake = {
    status: "pending",
    attemptCount: 0,
    privateInput: { runId: "private-wake", message: "private input" },
  };
  batch[3]!.completion!.resultText = null;
  batch[3]!.execution.outcome = { status: "error", error: "Gateway stopped" };
  await appendChildStatusToRequester(batch);
  const notice = await readNotice();
  expect(notice).toMatchObject({
    display: false,
    details: { childRunIds: batch.map((child) => child.runId) },
  });
  expect(notice).not.toHaveProperty("excludeFromContext");
  for (let index = 0; index < 3; index++) {
    const child = batch[index]!;
    expect(notice.text).toContain(
      `(session ${child.childSessionKey}, run ${child.runId}): completed`,
    );
    expect(notice.text).toContain(child.completion!.resultText);
  }
  expect(notice.text).toContain("interrupted by Gateway restart");
  expect(loadSubagentRegistryFromSqlite().get(batch[0]!.runId)?.completion?.resultText).toBe(
    batch[0]!.completion!.resultText,
  );
});
