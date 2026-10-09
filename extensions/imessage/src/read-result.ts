import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { boundedJsonUtf8Bytes, truncateUtf8Prefix } from "openclaw/plugin-sdk/text-utility-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";

const MAX_TEXT_BYTES = 4 * 1024;
const MAX_SENDER_BYTES = 256;
const MAX_RESULT_BYTES = 32 * 1024;

type ReadMessage = {
  id: string;
  timestamp: string;
  sender: string;
  direction: "incoming" | "outgoing";
  text: string;
  textTruncated: boolean;
  senderTruncated: boolean;
};

function projectMessage(value: unknown, chatId: number): ReadMessage | undefined {
  const row = asOptionalRecord(value);
  if (!row) {
    return undefined;
  }
  if (row.chat_id !== chatId || row.is_group === true) {
    throw new Error("iMessage history returned a different or group conversation.");
  }
  if (
    typeof row.id !== "number" ||
    !Number.isSafeInteger(row.id) ||
    row.id <= 0 ||
    typeof row.created_at !== "string" ||
    row.created_at.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      row.created_at,
    ) ||
    !Number.isFinite(Date.parse(row.created_at)) ||
    typeof row.sender !== "string" ||
    typeof row.is_from_me !== "boolean" ||
    typeof row.text !== "string"
  ) {
    return undefined;
  }
  const text = truncateUtf8Prefix(row.text.toWellFormed(), MAX_TEXT_BYTES);
  const sender = truncateUtf8Prefix(row.sender.toWellFormed(), MAX_SENDER_BYTES);
  return {
    id: String(row.id),
    timestamp: new Date(row.created_at).toISOString(),
    sender,
    direction: row.is_from_me ? "outgoing" : "incoming",
    text,
    textTruncated: text !== row.text,
    senderTruncated: sender !== row.sender,
  };
}

/** Only this typed projection crosses the provider boundary; native rows never do. */
export function projectIMessageReadResult(params: {
  result: unknown;
  chatId: number;
  limit: number;
}) {
  const rows = asOptionalRecord(params.result)?.messages;
  if (!Array.isArray(rows) || rows.length > params.limit) {
    throw new Error("iMessage history returned an invalid recent-message window.");
  }
  const messages: ReadMessage[] = [];
  for (const row of rows) {
    const message = projectMessage(row, params.chatId);
    if (message) {
      messages.push(message);
    }
  }
  messages.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || Number(b.id) - Number(a.id));
  const omittedInvalid = rows.length - messages.length;
  let omittedForBudget = 0;
  const buildResult = () =>
    jsonResult({
      ok: true,
      chatId: params.chatId,
      limit: params.limit,
      coverage: "recent-window",
      historyComplete: false,
      order: "newest-first",
      returned: messages.length,
      omittedInvalid,
      omittedForBudget,
      truncated:
        omittedInvalid > 0 ||
        omittedForBudget > 0 ||
        messages.some((message) => message.textTruncated || message.senderTruncated),
      messages,
    });
  const fits = (result: ReturnType<typeof buildResult>) =>
    boundedJsonUtf8Bytes(result, MAX_RESULT_BYTES).complete;
  let result = buildResult();
  // Measure the entire ToolResult: details and escaped content both count.
  while (!fits(result) && messages.length > 1) {
    messages.pop();
    omittedForBudget += 1;
    result = buildResult();
  }
  const newest = messages[0];
  if (!fits(result) && newest) {
    // Escaped control characters can exceed the envelope even for one 4 KiB body.
    const text = newest.text;
    newest.textTruncated = true;
    let low = 0;
    let high = Buffer.byteLength(text);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      newest.text = truncateUtf8Prefix(text, mid);
      if (fits(buildResult())) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    newest.text = truncateUtf8Prefix(text, low);
    result = buildResult();
  }
  if (!fits(result)) {
    throw new Error("iMessage history could not fit the bounded text result.");
  }
  return result;
}
