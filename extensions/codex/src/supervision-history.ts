import { sha256Hex } from "openclaw/plugin-sdk/node-crypto-runtime";
import { readStringParam } from "openclaw/plugin-sdk/param-readers";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { Type } from "typebox";

export const FinalAnswerParamsSchema = Type.Object(
  {
    turn_id: Type.Optional(Type.String()),
    turn_cursor: Type.Optional(Type.String()),
    item_cursor: Type.Optional(Type.String()),
    text_offset: Type.Optional(Type.Integer({ minimum: 0 })),
    text_sha256: Type.Optional(Type.String({ pattern: "^sha256:[a-f0-9]{64}$" })),
  },
  { additionalProperties: false },
);

const MAX_COMPAT_CURSOR_LENGTH = 4096;
const MAX_COMPAT_THREAD_ID_LENGTH = 4096;
const FINAL_ANSWER_PAGE_LIMIT = 100;
const FINAL_ANSWER_JSON_TEXT_CHARS = 4096;

function isCompatString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

export function readCompatNextCursor(value: unknown, method: string): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!isCompatString(value, MAX_COMPAT_CURSOR_LENGTH)) {
    throw new Error(`Codex ${method} returned an invalid nextCursor`);
  }
  return value;
}

export function readCompatThreadId(value: unknown, method: string, index: number): string {
  if (!isCompatString(value, MAX_COMPAT_THREAD_ID_LENGTH)) {
    throw new Error(`Codex ${method} returned an invalid thread id at data[${index}]`);
  }
  return value;
}

function readCompatInputCursor(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isCompatString(value, MAX_COMPAT_CURSOR_LENGTH)) {
    throw new Error(
      `${label} must be a non-empty cursor of at most ${MAX_COMPAT_CURSOR_LENGTH} characters`,
    );
  }
  return value;
}

type FinalAnswerSelector = {
  turnId?: string;
  turnCursor?: string;
  itemCursor?: string;
  textOffset: number;
  textSha256?: string;
};

export function readFinalAnswerSelector(
  value: unknown,
  threadId: string,
): FinalAnswerSelector | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("final_answer must be an object");
  }
  const turnId = readStringParam(value, "turn_id");
  if (turnId !== undefined && !isCompatString(turnId, MAX_COMPAT_THREAD_ID_LENGTH)) {
    throw new Error(
      `turn_id must be non-empty and at most ${MAX_COMPAT_THREAD_ID_LENGTH} characters`,
    );
  }
  const rawTextOffset = value.text_offset;
  if (
    rawTextOffset !== undefined &&
    (typeof rawTextOffset !== "number" || !Number.isSafeInteger(rawTextOffset) || rawTextOffset < 0)
  ) {
    throw new Error("text_offset must be a non-negative safe integer");
  }
  const textOffset = rawTextOffset ?? 0;
  const textSha256 = readStringParam(value, "text_sha256");
  if (textSha256 !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(textSha256)) {
    throw new Error("text_sha256 must be a sha256 digest");
  }
  if ((value.item_cursor !== undefined || textOffset > 0) && !turnId) {
    throw new Error("turn_id is required with item_cursor or text_offset");
  }
  if (textOffset > 0 && !textSha256) {
    throw new Error("text_sha256 is required with text_offset");
  }
  const turnCursor = readCompatInputCursor(value.turn_cursor, "turn_cursor");
  const itemCursor = readCompatInputCursor(value.item_cursor, "item_cursor");
  if (!isCompatString(threadId, MAX_COMPAT_THREAD_ID_LENGTH)) {
    throw new Error(
      `thread_id must be non-empty and at most ${MAX_COMPAT_THREAD_ID_LENGTH} characters`,
    );
  }
  return {
    ...(turnId ? { turnId } : {}),
    ...(turnCursor ? { turnCursor } : {}),
    ...(itemCursor ? { itemCursor } : {}),
    textOffset,
    ...(textSha256 ? { textSha256 } : {}),
  };
}

function sliceFinalAnswerText(text: string, offset: number): string {
  let low = 0;
  let high = Math.min(FINAL_ANSWER_JSON_TEXT_CHARS, text.length - offset);
  let chunk = "";
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const candidate = sliceUtf16Safe(text, offset, offset + length);
    if (JSON.stringify(candidate).length - 2 <= FINAL_ANSWER_JSON_TEXT_CHARS) {
      chunk = candidate;
      low = length + 1;
    } else {
      high = length - 1;
    }
  }
  return chunk;
}

export async function readCompletedFinalAnswer(params: {
  request: (method: string, requestParams: unknown) => Promise<unknown>;
  threadId: string;
  selector: FinalAnswerSelector;
}): Promise<Record<string, unknown>> {
  const turnsResponse = await params.request("thread/turns/list", {
    threadId: params.threadId,
    limit: FINAL_ANSWER_PAGE_LIMIT,
    sortDirection: "desc",
    itemsView: "notLoaded",
    ...(params.selector.turnCursor ? { cursor: params.selector.turnCursor } : {}),
  });
  if (!isRecord(turnsResponse) || !Array.isArray(turnsResponse.data)) {
    throw new Error("Codex thread/turns/list returned an invalid response");
  }
  if (turnsResponse.data.length > FINAL_ANSWER_PAGE_LIMIT) {
    throw new Error(
      `Codex thread/turns/list returned more than ${FINAL_ANSWER_PAGE_LIMIT} entries`,
    );
  }
  const turns = turnsResponse.data.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Codex thread/turns/list returned an invalid entry at data[${index}]`);
    }
    readCompatThreadId(entry.id, "thread/turns/list", index);
    return entry;
  });
  const nextTurnCursor = readCompatNextCursor(turnsResponse.nextCursor, "thread/turns/list");
  const turn = params.selector.turnId
    ? turns.find((entry) => entry.id === params.selector.turnId)
    : turns.find((entry) => entry.status === "completed");
  if (!turn) {
    if (nextTurnCursor) {
      return { threadId: params.threadId, nextTurnCursor };
    }
    throw new Error(
      params.selector.turnId
        ? `Codex completed turn not found: ${params.selector.turnId}`
        : `Codex thread ${params.threadId} has no completed turn`,
    );
  }
  if (turn.status !== "completed") {
    throw new Error(`Codex turn ${String(turn.id)} is not completed`);
  }
  const turnId = String(turn.id);
  const itemsResponse = await params.request("thread/items/list", {
    threadId: params.threadId,
    turnId,
    limit: FINAL_ANSWER_PAGE_LIMIT,
    sortDirection: "desc",
    ...(params.selector.itemCursor ? { cursor: params.selector.itemCursor } : {}),
  });
  if (!isRecord(itemsResponse) || !Array.isArray(itemsResponse.data)) {
    throw new Error("Codex thread/items/list returned an invalid response");
  }
  if (itemsResponse.data.length > FINAL_ANSWER_PAGE_LIMIT) {
    throw new Error(
      `Codex thread/items/list returned more than ${FINAL_ANSWER_PAGE_LIMIT} entries`,
    );
  }
  const items = itemsResponse.data.map((entry, index) => {
    if (!isRecord(entry) || entry.turnId !== turnId || !isRecord(entry.item)) {
      throw new Error(`Codex thread/items/list returned an invalid entry at data[${index}]`);
    }
    return entry.item;
  });
  const nextItemCursor = readCompatNextCursor(itemsResponse.nextCursor, "thread/items/list");
  const item = items.find(
    (entry) => entry.type === "agentMessage" && entry.phase === "final_answer",
  );
  const response = {
    threadId: params.threadId,
    turn: {
      id: turnId,
      status: "completed",
      ...(typeof turn.completedAt === "number" ? { completedAt: turn.completedAt } : {}),
    },
  };
  if (!item) {
    if (nextItemCursor) {
      return { ...response, nextItemCursor };
    }
    throw new Error(`Codex completed turn ${turnId} has no final answer`);
  }
  if (!isCompatString(item.id, MAX_COMPAT_THREAD_ID_LENGTH) || typeof item.text !== "string") {
    throw new Error(`Codex completed turn ${turnId} returned an invalid final answer`);
  }
  const text = item.text;
  const textSha256 = `sha256:${sha256Hex(text)}`;
  if (params.selector.textSha256 && params.selector.textSha256 !== textSha256) {
    throw new Error(`Codex final answer changed before text_offset ${params.selector.textOffset}`);
  }
  if (params.selector.textOffset > text.length) {
    throw new Error(`text_offset exceeds the ${text.length}-character final answer`);
  }
  if (
    params.selector.textOffset > 0 &&
    params.selector.textOffset < text.length &&
    /[\uD800-\uDBFF]/u.test(text[params.selector.textOffset - 1] ?? "") &&
    /[\uDC00-\uDFFF]/u.test(text[params.selector.textOffset] ?? "")
  ) {
    throw new Error("text_offset splits a UTF-16 surrogate pair");
  }
  const chunk = sliceFinalAnswerText(text, params.selector.textOffset);
  const nextTextOffset = params.selector.textOffset + chunk.length;
  return {
    ...response,
    finalAnswer: {
      type: "agentMessage",
      id: item.id,
      phase: "final_answer",
      text: chunk,
      textOffset: params.selector.textOffset,
      textLength: text.length,
      textSha256,
      ...(nextTextOffset < text.length ? { nextTextOffset } : {}),
    },
  };
}
