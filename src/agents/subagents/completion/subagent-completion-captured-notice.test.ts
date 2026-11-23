import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry-state.fixture.test-support.js";
import { useCompletionDatabase } from "./completion-database.test-support.js";
import {
  blockSubagentCompletionDelivery,
  recordRequiredCompletionNotice,
} from "./subagent-completion-admission.store.js";
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
        isRecord(event) && event.type === "custom_message" && event.display === true,
    );
    expect(notices).toHaveLength(1);
    const notice = notices[0]!;
    expect(typeof notice.content).toBe("string");
    return { ...notice, text: String(notice.content) };
  };
  return { batch, readNotice };
}

it.each(["permanent_failure", "expiry"] as const)(
  "shows captured results when completion delivery reaches %s",
  async (suspendedReason) => {
    const { batch, readNotice } = await fixture(16);
    const missing = batch[15]!;
    missing.completion!.resultText = null;
    missing.execution.outcome = { status: "error", error: "Gateway stopped" };
    await blockSubagentCompletionDelivery({
      subagent: batch[0]!,
      requesterBatch: batch.toReversed(),
      suspendedReason,
      reason: "Operator access was revoked; start a new user turn.",
      databaseOptions: { database: db.value },
    });
    const notice = await readNotice();
    expect(notice.text).toContain("answer-000");
    expect(notice.text).toContain("answer-014");
    expect(notice.text).toContain("Interrupted by Gateway restart; not resumed.");
    expect(notice.text).toContain("[result truncated");
    expect(notice.text).toContain("chat.history");
    expect(notice.text).toContain("chat.message.get");
    expect(notice.text.isWellFormed()).toBe(true);
    expect(notice.text).toContain("maxChars=500000");
    expect(notice.text.length).toBeLessThanOrEqual(32_000);
    for (let index = 0; index < 15; index++) {
      const id = String(index).padStart(3, "0");
      expect(notice.text).toContain(`answer-${id}`);
      expect(notice.text).not.toContain(`TAIL-${id}`);
      if (index > 0) {
        const previous = String(index - 1).padStart(3, "0");
        expect(notice.text.indexOf(`answer-${previous}`)).toBeLessThan(
          notice.text.indexOf(`answer-${id}`),
        );
      }
    }
    // Rendering must not shorten the durable result used by later recovery.
    expect(loadSubagentRegistryFromSqlite().get(batch[0]!.runId)?.completion?.resultText).toBe(
      batch[0]!.completion!.resultText,
    );
  },
);

it("bounds oversized failure batches and identifies omitted children", async () => {
  const { batch, readNotice } = await fixture(48);
  await recordRequiredCompletionNotice(batch[0]!, "delivery refused", batch.toReversed());
  const { text } = await readNotice();
  expect(text.length).toBeLessThanOrEqual(32_000);
  expect(text).toContain("answer-000");
  expect(text).toContain("additional child results omitted");
  expect(text).toContain("chat.history");
  expect(text).not.toContain("TAIL-000");
});

it.each(["permanent_failure", "expiry"] as const)(
  "keeps unconsumed private answers internal in a mixed %s notice",
  async (suspendedReason) => {
    const { batch, readNotice } = await fixture(4);
    batch[0]!.requesterSettleWake = {
      status: "dispatching",
      attemptCount: 1,
      privateInput: { runId: "public-wake", message: "public input", privateOnly: false },
    };
    batch[1]!.completionTarget = "parent";
    batch[2]!.requesterSettleWake = {
      status: "pending",
      attemptCount: 0,
      privateInput: { runId: "private-wake", message: "private input" },
    };
    batch[3]!.completionTarget = "parent";
    batch[3]!.requesterSettleWake = {
      status: "pending",
      attemptCount: 0,
      afterRequesterYield: true,
      yieldedFinalDeliverable: true,
    };
    await blockSubagentCompletionDelivery({
      subagent: batch[0]!,
      requesterBatch: batch,
      suspendedReason,
      reason: "Operator access was revoked; start a new user turn.",
      databaseOptions: { database: db.value },
    });
    const { text } = await readNotice();
    expect(text).toContain("answer-000");
    expect(text).not.toContain("answer-001");
    expect(text).not.toContain("answer-002");
    expect(text).toContain("answer-003");
    for (const child of batch) {
      expect(text).toContain(child.runId);
    }
  },
);

it.each(["failed", "result"] as const)("preserves the %s result-size contract", async (kind) => {
  const { batch, readNotice } = await fixture(1);
  const child = batch[0]!;
  await recordRequiredCompletionNotice(child, "delivery refused", batch, kind);
  const { text } = await readNotice();
  if (kind === "result") {
    expect(text).toBe(
      `Child ${child.childSessionKey} (run ${child.runId})\n\nok\n\n${child.completion!.resultText}`,
    );
  } else {
    const start = text.indexOf("answer-000");
    const end = text.indexOf("]", text.indexOf("[result truncated", start)) + 1;
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(end - start).toBeLessThanOrEqual(2_000);
    expect(text).not.toContain("TAIL-000");
  }
});
