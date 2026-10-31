import { isRecord } from "../../lib/record-shared.mjs";
import { parseJsonOutputValues } from "./json-output.mjs";
import { readTextFileTail, tailText, textFileContains } from "./text-file-utils.mjs";

const ERROR_DETAIL_TAIL_BYTES = 64 * 1024;
const OUTPUT_SCAN_TAIL_BYTES = 2 * 1024 * 1024;
const REPLY_TEXT_PREVIEW_BYTES = 8 * 1024;
const REPLY_TEXT_PREVIEW_COUNT = 5;
const OPENAI_REQUEST_PATH_PATTERN = /\/v1\/(responses|chat\/completions)/u;

function summarizeReplyTexts(replyTexts) {
  const previewStart = Math.max(0, replyTexts.length - REPLY_TEXT_PREVIEW_COUNT);
  const recent = replyTexts.slice(previewStart).map((text, index) => ({
    index: previewStart + index,
    bytes: Buffer.byteLength(text, "utf8"),
    tail: tailText(text, REPLY_TEXT_PREVIEW_BYTES),
  }));
  return JSON.stringify({ count: replyTexts.length, recent });
}

function textValues(values) {
  return values.filter((value) => typeof value === "string" && value.length > 0);
}

function isFailureStatus(value) {
  return (
    typeof value === "string" &&
    ["blocked", "canceled", "cancelled", "error", "failed", "failure"].includes(value.toLowerCase())
  );
}

function hasFailureSignal(value) {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.isError === true ||
    value.ok === false ||
    isFailureStatus(value.status) ||
    isFailureStatus(value.livenessState) ||
    (Object.hasOwn(value, "error") && value.error !== null && value.error !== undefined)
  );
}

export function extractAgentReplyTexts(text) {
  return parseJsonOutputValues(text).flatMap((payload) => {
    const envelopeFailed =
      hasFailureSignal(payload) ||
      hasFailureSignal(payload?.meta) ||
      hasFailureSignal(payload?.result) ||
      hasFailureSignal(payload?.result?.meta);
    if (envelopeFailed) {
      return [];
    }
    const payloadEntries = Array.isArray(payload?.payloads)
      ? payload.payloads
      : Array.isArray(payload?.result?.payloads)
        ? payload.result.payloads
        : [];
    const directTexts = textValues([
      payload?.finalAssistantVisibleText,
      payload?.finalAssistantRawText,
      payload?.meta?.finalAssistantVisibleText,
      payload?.meta?.finalAssistantRawText,
      payload?.result?.finalAssistantVisibleText,
      payload?.result?.finalAssistantRawText,
      payload?.result?.meta?.finalAssistantVisibleText,
      payload?.result?.meta?.finalAssistantRawText,
    ]);
    const payloadTexts = payloadEntries.flatMap((entry) =>
      entry?.isError !== true && typeof entry?.text === "string" && entry.text.length > 0
        ? [entry.text]
        : [],
    );
    return directTexts.concat(payloadTexts);
  });
}

export function assertAgentReplyContainsMarker(marker, outputPath) {
  const output = readTextFileTail(outputPath, OUTPUT_SCAN_TAIL_BYTES);
  const replyTexts = extractAgentReplyTexts(output);
  if (replyTexts.some((text) => text.includes(marker))) {
    return;
  }
  const outputTail = tailText(output, ERROR_DETAIL_TAIL_BYTES);
  throw new Error(
    `agent reply payload did not contain marker ${marker}. Reply payload summary: ${summarizeReplyTexts(replyTexts)}. Output tail: ${outputTail}`,
  );
}

export function assertOpenAiRequestLogUsed(requestLogPath, label = "mock OpenAI server") {
  if (textFileContains(requestLogPath, OPENAI_REQUEST_PATH_PATTERN)) {
    return;
  }
  const requestLogTail = readTextFileTail(requestLogPath, ERROR_DETAIL_TAIL_BYTES);
  throw new Error(`${label} was not used. Request log tail: ${requestLogTail}`);
}
