import { lstat } from "node:fs/promises";
import path from "node:path";
import { root } from "openclaw/plugin-sdk/file-access-runtime";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readTurnCompletion } from "./native-subagent-history-recovery.js";
import { readCodexNativeSubagentNotification } from "./native-subagent-notification.js";
import { isJsonObject, type JsonObject, type CodexServerNotification } from "./protocol.js";

export const NATIVE_RECEIPT_OBSERVATION_TIMEOUT_MS = 30_000;
const MAX_READ_BYTES = 16 * 1024 * 1024;
const MAX_META_BYTES = 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const resultKey = (value: string) => value.replace(/\s+/g, " ").trim();

type NativeCompletionFacts = {
  parentThreadId: string;
  turnId: string;
  intents: Array<{ ordinal: number; id: string; childThreadId: string; agentPath: string }>;
  receipts: Array<{ ordinal: number; item: JsonObject }>;
};
export type OwnedReceiptCandidate = {
  childThreadId: string;
  nativeTurnId: string;
  result: string;
  agentPaths: readonly string[];
  uniqueResultProven: boolean;
};

/** One canonical descriptor establishes provenance and a bounded, complete-LF snapshot. */
export async function readOwnedNativeCompletionFacts(params: {
  sessionsRoot: string;
  rolloutPath: string;
  parentThreadId: string;
  turnId: string;
  assertCurrent: () => void;
  deadlineAt: number;
}): Promise<NativeCompletionFacts | undefined> {
  const { sessionsRoot, rolloutPath, parentThreadId, turnId, deadlineAt } = params;
  const check = () => {
    params.assertCurrent();
    if (performance.now() >= deadlineAt) {
      throw new Error("Native receipt read deadline exceeded");
    }
  };
  check();
  if (
    !path.isAbsolute(sessionsRoot) ||
    !path.isAbsolute(rolloutPath) ||
    !rolloutPath.endsWith(".jsonl")
  ) {
    return undefined;
  }
  const stat = await lstat(sessionsRoot);
  check();
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return undefined;
  }
  const safeRoot = await root(sessionsRoot, {
    hardlinks: "reject",
    maxBytes: Number.MAX_SAFE_INTEGER,
    symlinks: "reject",
  });
  check();
  const opened = await safeRoot.open(path.relative(sessionsRoot, rolloutPath));
  try {
    check();
    const size = opened.stat.size;
    if (!Number.isSafeInteger(size) || size <= 0) {
      return undefined;
    }
    const chunks: Buffer[] = [];
    let prefixBytes = 0;
    let firstLine: string | undefined;
    while (prefixBytes < Math.min(size, MAX_META_BYTES)) {
      check();
      const buffer = Buffer.alloc(
        Math.min(CHUNK_BYTES, size - prefixBytes, MAX_META_BYTES - prefixBytes),
      );
      const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, prefixBytes);
      check();
      if (!bytesRead) {
        return undefined;
      }
      const chunk = buffer.subarray(0, bytesRead);
      const lf = chunk.indexOf(10);
      chunks.push(lf < 0 ? chunk : chunk.subarray(0, lf));
      prefixBytes += bytesRead;
      if (lf >= 0) {
        firstLine = decoder.decode(Buffer.concat(chunks));
        break;
      }
    }
    if (firstLine === undefined) {
      return undefined;
    }
    const metadata: unknown = JSON.parse(firstLine);
    if (
      !isJsonObject(metadata) ||
      metadata.type !== "session_meta" ||
      !isJsonObject(metadata.payload) ||
      metadata.payload.id !== parentThreadId
    ) {
      return undefined;
    }
    const count = Math.min(size, MAX_READ_BYTES - prefixBytes);
    if (count <= 0) {
      return undefined;
    }
    const start = size - count;
    const buffer = Buffer.alloc(count);
    let used = 0;
    while (used < count) {
      check();
      const { bytesRead } = await opened.handle.read(
        buffer,
        used,
        Math.min(CHUNK_BYTES, count - used),
        start + used,
      );
      check();
      if (!bytesRead) {
        return undefined;
      }
      used += bytesRead;
    }
    let complete = buffer.subarray(0);
    if (start > 0) {
      const lf = complete.indexOf(10);
      if (lf < 0) {
        return undefined;
      }
      complete = complete.subarray(lf + 1);
    }
    const finalLf = complete.lastIndexOf(10);
    if (finalLf < 0) {
      return undefined;
    }
    const records: JsonObject[] = [];
    for (const line of decoder.decode(complete.subarray(0, finalLf + 1)).split("\n")) {
      check();
      if (!line) {
        continue;
      }
      const record: unknown = JSON.parse(line);
      if (!isJsonObject(record)) {
        return undefined;
      }
      records.push(record);
    }
    const contexts = records.flatMap((record, index) =>
      record.type === "turn_context" &&
      isJsonObject(record.payload) &&
      record.payload.turn_id === turnId
        ? [index]
        : [],
    );
    if (contexts.length !== 1) {
      return undefined;
    }
    const facts: NativeCompletionFacts = { parentThreadId, turnId, intents: [], receipts: [] };
    for (let ordinal = contexts[0]! + 1; ordinal < records.length; ordinal++) {
      check();
      const record = records[ordinal]!;
      const payload = record.payload;
      if (!isJsonObject(payload)) {
        continue;
      }
      const item = payload.item;
      if (
        record.type === "event_msg" &&
        payload.turn_id === turnId &&
        payload.type === "item_completed" &&
        isJsonObject(item) &&
        item.type === "SubAgentActivity" &&
        item.kind === "completed" &&
        typeof item.id === "string" &&
        typeof item.agent_thread_id === "string" &&
        typeof item.agent_path === "string"
      ) {
        facts.intents.push({
          ordinal,
          id: item.id,
          childThreadId: item.agent_thread_id,
          agentPath: item.agent_path,
        });
      }
      if (
        record.type === "response_item" &&
        payload.type === "agent_message" &&
        isJsonObject(payload.internal_chat_message_metadata_passthrough) &&
        payload.internal_chat_message_metadata_passthrough.turn_id === turnId &&
        typeof payload.id === "string"
      ) {
        facts.receipts.push({ ordinal, item: payload });
      }
    }
    check();
    return facts;
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

/** Intent identifies the child turn; only a later exact consumed message acknowledges it. */
export function selectOwnedNativeCompletionReceipts<Candidate extends OwnedReceiptCandidate>(
  facts: NativeCompletionFacts | undefined,
  candidates: readonly Candidate[],
): Array<{ candidate: Candidate; notification: CodexServerNotification }> {
  if (!facts) {
    return [];
  }
  const selected: Array<{ candidate: Candidate; notification: CodexServerNotification }> = [];
  for (const candidate of candidates) {
    if (!candidate.uniqueResultProven) {
      continue;
    }
    const intents = facts.intents.filter(
      (intent) => intent.id === `subagent-completed-${candidate.nativeTurnId}`,
    );
    if (
      !intents.length ||
      intents.some(
        (intent) =>
          intent.childThreadId !== candidate.childThreadId ||
          !candidate.agentPaths.includes(intent.agentPath),
      ) ||
      new Set(intents.map((intent) => JSON.stringify([intent.childThreadId, intent.agentPath])))
        .size !== 1
    ) {
      continue;
    }
    const intent = intents[0]!;
    const frames = new Map<string, CodexServerNotification>();
    for (const receipt of facts.receipts) {
      const item = receipt.item;
      if (
        receipt.ordinal <= intent.ordinal ||
        item.type !== "agent_message" ||
        typeof item.id !== "string" ||
        !isJsonObject(item.internal_chat_message_metadata_passthrough) ||
        item.internal_chat_message_metadata_passthrough.turn_id !== facts.turnId
      ) {
        continue;
      }
      const notification: CodexServerNotification = {
        method: "rawResponseItem/completed",
        params: {
          threadId: facts.parentThreadId,
          turnId: facts.turnId,
          item,
        },
      };
      const receipts = readCodexNativeSubagentNotification(notification).receipts;
      const consumed = receipts.length === 1 ? receipts[0] : undefined;
      if (
        consumed?.agentPath === intent.agentPath &&
        consumed.result !== undefined &&
        resultKey(consumed.result) === resultKey(candidate.result)
      ) {
        frames.set(item.id, notification);
      }
    }
    if (frames.size === 1) {
      selected.push({ candidate, notification: [...frames.values()][0]! });
    }
  }

  return selected;
}

/** Complete canonical child history must prove every other turn has a distinct known result. */
export function hasUniqueOwnedChildResult(
  candidate: Pick<OwnedReceiptCandidate, "childThreadId" | "nativeTurnId" | "result">,
  response: unknown,
): boolean {
  if (
    !isJsonObject(response) ||
    !Array.isArray(response.data) ||
    response.data.length > 64 ||
    response.nextCursor != null
  ) {
    return false;
  }
  const turns = response.data;
  if (!turns.every(isJsonObject)) {
    return false;
  }
  const ids = turns.map((turn) => readString(turn, "id"));
  if (
    ids.some((id) => !id) ||
    new Set(ids).size !== ids.length ||
    !ids.includes(candidate.nativeTurnId)
  ) {
    return false;
  }
  for (const turn of turns) {
    const completion = readTurnCompletion(turn, candidate.childThreadId);
    if (!completion || completion.statusLabel === "completed_without_final_message") {
      return false;
    }
    const matches = resultKey(completion.result) === resultKey(candidate.result);
    if (matches !== (readString(turn, "id") === candidate.nativeTurnId)) {
      return false;
    }
  }
  return true;
}
