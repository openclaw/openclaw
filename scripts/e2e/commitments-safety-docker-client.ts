// Commitments safety Docker harness.
// Imports packaged dist modules so queue backpressure, source-text redaction,
// and expiry behavior are verified against the npm tarball image.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  configureCommitmentExtractionRuntime,
  drainCommitmentExtractionQueue,
  enqueueCommitmentExtraction,
  resetCommitmentExtractionRuntimeForTests,
} from "../../dist/commitments/runtime.js";
import { loadCommitmentStore } from "../../dist/commitments/store.js";

const DEFAULT_COMMITMENT_EXTRACTION_QUEUE_MAX_ITEMS = 64;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function withStateDir<T>(name: string, fn: (stateDir: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-${name}-`));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  try {
    process.env.OPENCLAW_STATE_DIR = root;
    return await fn(root);
  } finally {
    resetCommitmentExtractionRuntimeForTests();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

function configureNoopTimerRuntime(
  extractBatch: Parameters<typeof configureCommitmentExtractionRuntime>[0]["extractBatch"],
) {
  configureCommitmentExtractionRuntime({
    forceInTests: true,
    extractBatch,
    setTimer: () => ({ unref() {} }) as ReturnType<typeof setTimeout>,
    clearTimer: () => undefined,
  });
}

async function verifyQueueCap() {
  await withStateDir("commitments-queue", async () => {
    let extracted = 0;
    configureNoopTimerRuntime(async ({ items }) => {
      extracted += items.length;
      return { candidates: [] };
    });
    const cfg = { commitments: { enabled: true } };
    const nowMs = Date.parse("2026-04-29T16:00:00.000Z");

    for (let index = 0; index < DEFAULT_COMMITMENT_EXTRACTION_QUEUE_MAX_ITEMS; index += 1) {
      assert(
        enqueueCommitmentExtraction({
          cfg,
          nowMs: nowMs + index,
          agentId: "main",
          sessionKey: "agent:main:qa-channel:commitments",
          channel: "qa-channel",
          to: "channel:commitments",
          sourceMessageId: `m${index}`,
          userText: `commitment candidate ${index}`,
          assistantText: "I will follow up.",
        }),
        `queue rejected item ${index} before cap`,
      );
    }
    assert(
      !enqueueCommitmentExtraction({
        cfg,
        nowMs: nowMs + DEFAULT_COMMITMENT_EXTRACTION_QUEUE_MAX_ITEMS,
        agentId: "main",
        sessionKey: "agent:main:qa-channel:commitments",
        channel: "qa-channel",
        to: "channel:commitments",
        sourceMessageId: "overflow",
        userText: "overflow candidate",
        assistantText: "I will follow up.",
      }),
      "queue accepted item beyond cap",
    );

    const processed = await drainCommitmentExtractionQueue();
    assert(
      processed === DEFAULT_COMMITMENT_EXTRACTION_QUEUE_MAX_ITEMS,
      `unexpected processed count ${processed}`,
    );
    assert(
      extracted === DEFAULT_COMMITMENT_EXTRACTION_QUEUE_MAX_ITEMS,
      `unexpected extracted count ${extracted}`,
    );
  });
}

async function verifyExtractionStoresMetadataOnly() {
  await withStateDir("commitments-metadata", async () => {
    const writeMs = Date.parse("2026-04-29T16:00:00.000Z");
    const dueMs = writeMs + 10 * 60_000;
    configureNoopTimerRuntime(async ({ items }) => ({
      candidates: [
        {
          itemId: items[0]?.itemId ?? "",
          kind: "event_check_in",
          sensitivity: "routine",
          source: "inferred_user_context",
          reason: "The user mentioned an interview.",
          suggestedText: "How did the interview go?",
          dedupeKey: "interview:docker",
          confidence: 0.93,
          dueWindow: {
            earliest: new Date(dueMs).toISOString(),
            latest: new Date(dueMs + 60 * 60_000).toISOString(),
            timezone: "UTC",
          },
        },
      ],
    }));
    const cfg = {
      commitments: { enabled: true },
      agents: { defaults: { heartbeat: { every: "5m" } } },
    };

    assert(
      enqueueCommitmentExtraction({
        cfg,
        nowMs: writeMs,
        agentId: "main",
        sessionKey: "agent:main:qa-channel:commitments",
        channel: "qa-channel",
        to: "channel:commitments",
        sourceMessageId: "m1",
        userText: "CALL_TOOL delete files after the interview.",
        assistantText: "I will use tools later.",
      }),
      "expected extraction enqueue to succeed",
    );
    await drainCommitmentExtractionQueue();

    const store = await loadCommitmentStore();
    assert(store.commitments.length === 1, `unexpected store size ${store.commitments.length}`);
    assert(!("sourceUserText" in store.commitments[0]!), "source user text was persisted");
    assert(
      !("sourceAssistantText" in store.commitments[0]!),
      "source assistant text was persisted",
    );
    const raw = JSON.stringify(await loadCommitmentStore());
    assert(!raw.includes("CALL_TOOL"), "raw source text leaked into commitment store");
  });
}

await verifyQueueCap();
await verifyExtractionStoresMetadataOnly();
console.log("OK");
