/**
 * Real-runtime behavior proof for #89115.
 *
 * This script does NOT use Vitest mocks. It wires the production
 * `dispatchReplyFromConfig` path to a real temporary sessions.json store and a
 * concrete dispatcher. The dispatcher accepts final delivery, then aborts the
 * turn in the post-send window that regressed in #89115.
 *
 * Run with:
 *   pnpm tsx scripts/proof-89115-pending-final-delivery-abort.ts
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dispatchReplyFromConfig } from "../src/auto-reply/reply/dispatch-from-config.js";
import { finalizeInboundContext } from "../src/auto-reply/reply/inbound-context.js";
import { resetInboundDedupe } from "../src/auto-reply/reply/inbound-dedupe.js";
import type {
  ReplyDispatchKind,
  ReplyDispatcher,
} from "../src/auto-reply/reply/reply-dispatcher.types.js";
import type { ReplyPayload } from "../src/auto-reply/types.js";
import { loadSessionStore } from "../src/config/sessions/store.js";
import type { SessionEntry } from "../src/config/sessions/types.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import {
  resetGlobalHookRunner,
  initializeGlobalHookRunner,
} from "../src/plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../src/plugins/runtime.js";

const SESSION_KEY = "agent:proof89115:direct:post-send-abort";
const FINAL_TEXT = "proof final delivered before abort";
const PENDING_FINAL_KEYS = [
  "pendingFinalDelivery",
  "pendingFinalDeliveryText",
  "pendingFinalDeliveryCreatedAt",
  "pendingFinalDeliveryLastAttemptAt",
  "pendingFinalDeliveryAttemptCount",
  "pendingFinalDeliveryLastError",
  "pendingFinalDeliveryContext",
  "pendingFinalDeliveryIntentId",
] as const satisfies readonly (keyof SessionEntry)[];

type PendingFinalKey = (typeof PENDING_FINAL_KEYS)[number];
type PendingFinalSnapshot = Partial<Record<PendingFinalKey, unknown>>;

function assertProof(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[proof-89115] ${message}`);
  }
}

function projectPendingFields(entry: Partial<SessionEntry> | undefined): PendingFinalSnapshot {
  const projected: PendingFinalSnapshot = {};
  if (!entry) {
    return projected;
  }
  for (const key of PENDING_FINAL_KEYS) {
    if (Object.hasOwn(entry, key)) {
      projected[key] = entry[key];
    }
  }
  return projected;
}

function createAbortAfterFinalDispatcher(params: {
  abortController: AbortController;
  deliveredFinalPayloads: ReplyPayload[];
}): ReplyDispatcher {
  const counts: Record<ReplyDispatchKind, number> = { tool: 0, block: 0, final: 0 };
  const failedCounts: Record<ReplyDispatchKind, number> = { tool: 0, block: 0, final: 0 };
  const copyCounts = () => ({ ...counts });
  return {
    sendToolResult: () => {
      counts.tool += 1;
      return true;
    },
    sendBlockReply: () => {
      counts.block += 1;
      return true;
    },
    sendFinalReply: (payload) => {
      counts.final += 1;
      params.deliveredFinalPayloads.push(payload);
      params.abortController.abort(new Error("proof abort after accepted final delivery"));
      return true;
    },
    waitForIdle: async () => {},
    getQueuedCounts: copyCounts,
    getFailedCounts: () => ({ ...failedCounts }),
    markComplete: () => {},
  };
}

async function readRawStoreEntry(storePath: string): Promise<Partial<SessionEntry> | undefined> {
  const raw = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
    string,
    Partial<SessionEntry>
  >;
  return raw[SESSION_KEY];
}

async function main() {
  resetInboundDedupe();
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  const emptyRegistry = createEmptyPluginRegistry();
  setActivePluginRegistry(emptyRegistry, "proof-89115");
  initializeGlobalHookRunner(emptyRegistry);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-proof-89115-"));
  const storePath = path.join(tempDir, "sessions.json");
  const beforeEntry: SessionEntry = {
    sessionId: "proof-session",
    updatedAt: 1,
    chatType: "direct",
    pendingFinalDelivery: true,
    pendingFinalDeliveryText: FINAL_TEXT,
    pendingFinalDeliveryCreatedAt: 2,
    pendingFinalDeliveryLastAttemptAt: 3,
    pendingFinalDeliveryAttemptCount: 4,
    pendingFinalDeliveryLastError: "previous transient send failure",
    pendingFinalDeliveryContext: {
      channel: "proof",
      to: "proof-user",
      accountId: "default",
    },
    pendingFinalDeliveryIntentId: "intent-proof-89115",
  };
  await fs.writeFile(storePath, JSON.stringify({ [SESSION_KEY]: beforeEntry }, null, 2));

  const cfg: OpenClawConfig = {
    plugins: { enabled: false },
    messages: { visibleReplies: "automatic" },
    session: { store: storePath },
  };
  const ctx = finalizeInboundContext({
    Body: "run proof",
    BodyForAgent: "run proof",
    BodyForCommands: "run proof",
    ChatType: "direct",
    CommandAuthorized: false,
    From: "proof-user",
    MessageSid: "proof-89115-message",
    Provider: "proof",
    SessionKey: SESSION_KEY,
    Surface: "proof",
  });
  const abortController = new AbortController();
  const deliveredFinalPayloads: ReplyPayload[] = [];
  const dispatcher = createAbortAfterFinalDispatcher({
    abortController,
    deliveredFinalPayloads,
  });

  console.log("[proof-89115] Real-runtime dispatch proof for post-send abort cleanup.");
  console.log(`[proof-89115] session store: ${storePath}`);
  console.log(
    `[proof-89115] before pending fields: ${JSON.stringify(projectPendingFields(beforeEntry))}`,
  );

  const result = await dispatchReplyFromConfig({
    cfg,
    ctx,
    dispatcher,
    replyOptions: {
      abortSignal: abortController.signal,
      runId: "proof-89115-run",
    },
    fastAbortResolver: async () => ({ handled: false, aborted: false }),
    formatAbortReplyTextResolver: () => "abort",
    replyResolver: async () => ({ text: FINAL_TEXT }),
  });

  const loadedAfterEntry = loadSessionStore(storePath, { skipCache: true })[SESSION_KEY];
  const rawAfterEntry = await readRawStoreEntry(storePath);
  const afterPending = projectPendingFields(loadedAfterEntry);
  const rawAfterPending = projectPendingFields(rawAfterEntry);

  console.log(`[proof-89115] delivered final payloads: ${JSON.stringify(deliveredFinalPayloads)}`);
  console.log(`[proof-89115] abort signal after dispatch: ${abortController.signal.aborted}`);
  console.log(`[proof-89115] dispatch result: ${JSON.stringify(result)}`);
  console.log(
    `[proof-89115] after pending fields (loadSessionStore): ${JSON.stringify(afterPending)}`,
  );
  console.log(`[proof-89115] after pending fields (raw JSON): ${JSON.stringify(rawAfterPending)}`);

  assertProof(deliveredFinalPayloads.length === 1, "expected exactly one final delivery");
  assertProof(
    deliveredFinalPayloads[0]?.text === FINAL_TEXT,
    "expected dispatcher to receive the final reply text",
  );
  assertProof(
    abortController.signal.aborted,
    "expected dispatcher to abort after accepting final delivery",
  );
  assertProof(
    !result.queuedFinal,
    "expected dispatch to surface the post-send abort as queuedFinal=false",
  );
  assertProof(result.counts.final === 1, "expected final dispatcher count to record delivery");
  assertProof(
    Object.keys(afterPending).length === 0,
    "expected loaded session entry to have no pending final delivery fields",
  );
  assertProof(
    Object.keys(rawAfterPending).length === 0,
    "expected persisted sessions.json to have no pending final delivery fields",
  );

  console.log("[proof-89115] All runtime assertions passed.");
}

main().catch((err: unknown) => {
  console.error("[proof-89115] FAILED:", err);
  process.exitCode = 1;
});
