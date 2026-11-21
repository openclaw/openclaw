import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";
import { readOwnedNativeCompletionFacts } from "./native-subagent-owned-receipts.js";
import type { JsonObject } from "./protocol.js";

export const candidate = (nativeTurnId = "child-turn", result = "Child result") => ({
  childThreadId: "child-thread",
  nativeTurnId,
  result,
  agentPaths: ["/root/worker"],
  uniqueResultProven: true,
});
export const childTurn = (
  id = "child-turn",
  text = "Child result",
  status = "completed",
): JsonObject => ({
  id,
  status,
  items: [{ type: "agentMessage", id: `final-${id}`, phase: "final_answer", text }],
});
export const metadata = (): JsonObject => ({
  type: "session_meta",
  payload: { id: "parent-thread" },
});
export const context = (): JsonObject => ({
  type: "turn_context",
  payload: { turn_id: "parent-turn" },
});
export const intent = (nativeTurnId = "child-turn"): JsonObject => ({
  type: "event_msg",
  payload: {
    type: "item_completed",
    turn_id: "parent-turn",
    item: {
      type: "SubAgentActivity",
      kind: "completed",
      id: `subagent-completed-${nativeTurnId}`,
      agent_thread_id: "child-thread",
      agent_path: "/root/worker",
    },
  },
});
export const consumed = (text = "Child result", id = "receipt"): JsonObject => ({
  type: "response_item",
  payload: {
    type: "agent_message",
    id,
    author: "/root/worker",
    recipient: "/root",
    content: [
      {
        type: "input_text",
        text: `Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/worker\nPayload:\n${text}`,
      },
    ],
    internal_chat_message_metadata_passthrough: { turn_id: "parent-turn" },
  },
});
export async function ownedReceiptFixture(records = [metadata(), context(), intent(), consumed()]) {
  const home = await mkdtemp(path.join(os.tmpdir(), "native-consumed-receipt-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const sessionsRoot = path.join(home, "sessions");
  await mkdir(sessionsRoot);
  const rolloutPath = path.join(sessionsRoot, "rollout-parent.jsonl");
  const content = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  await writeFile(rolloutPath, content);
  const params = {
    sessionsRoot,
    rolloutPath,
    parentThreadId: "parent-thread",
    turnId: "parent-turn",
    deadlineAt: performance.now() + 30_000,
    assertCurrent: () => {},
  };
  return { home, params, content, read: () => readOwnedNativeCompletionFacts(params) };
}
