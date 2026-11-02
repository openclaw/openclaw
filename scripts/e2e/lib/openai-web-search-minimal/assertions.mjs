import fs from "node:fs";
import { readTextFileTail, tailText } from "../text-file-utils.mjs";

const command = process.argv[2];

const ERROR_DETAIL_TAIL_BYTES = 64 * 1024;
const REQUEST_LOG_SCAN_CHUNK_BYTES = 64 * 1024;
const RESPONSE_PREVIEW_BYTES = 8 * 1024;
const RESPONSE_PREVIEW_COUNT = 5;

function scanTextFileLines(file, onLine) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(REQUEST_LOG_SCAN_CHUNK_BYTES);
    let carry = "";
    let lineNumber = 1;
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) {
        break;
      }
      const text = carry + buffer.subarray(0, bytesRead).toString("utf8");
      const lines = text.split(/\r?\n/u);
      carry = lines.pop() ?? "";
      for (const line of lines) {
        onLine(line, lineNumber);
        lineNumber += 1;
      }
    }
    if (carry.length > 0) {
      onLine(carry, lineNumber);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function isSuccessPrompt(text) {
  if (typeof text !== "string") {
    return false;
  }
  // The Gateway may prepend its marked, compact JSON context block. Match the
  // whole turn so a recap or quotation containing the prompt cannot select it.
  const match =
    /^(?:\[[^\]\r\n]+\] )?(?:Conversation info: ⟦openclaw:ctx⟧\n```json\n(\{[^\r\n]*\})\n```\n\n)?Return exactly OPENCLAW_SCHEMA_E2E_OK\.$/u.exec(
      text.trim(),
    );
  if (!match) {
    return false;
  }
  try {
    if (match[1]) {
      JSON.parse(match[1]);
    }
    return true;
  } catch {
    return false;
  }
}

function scanSuccessRequest(logPath) {
  let responseCount = 0;
  let success;
  const recentResponses = [];
  scanTextFileLines(logPath, (line, lineNumber) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    const entry = JSON.parse(trimmed);
    if (entry.method !== "POST" || entry.path !== "/v1/responses") {
      return;
    }
    responseCount += 1;
    const bodyText = JSON.stringify(entry.body);
    if (recentResponses.length >= RESPONSE_PREVIEW_COUNT) {
      recentResponses.shift();
    }
    recentResponses.push({
      line: lineNumber,
      bodyTail: tailText(bodyText, RESPONSE_PREVIEW_BYTES),
    });
    // Activity recaps quote the marker too; select the agent turn independently
    // of the web_search tool and reasoning settings that this assertion checks.
    const input = entry.body?.input;
    const hasSuccessPrompt =
      typeof input === "string"
        ? isSuccessPrompt(input)
        : Array.isArray(input) &&
          input.some(
            (item) =>
              item?.role === "user" &&
              (isSuccessPrompt(item.content) ||
                (Array.isArray(item.content) &&
                  item.content.some(
                    (part) => part?.type === "input_text" && isSuccessPrompt(part.text),
                  ))),
          );
    if (!success && entry.body?.model === "gpt-5" && hasSuccessPrompt) {
      success = entry;
    }
  });
  return { responseCount, success, recentResponses };
}

function assertSuccessRequest() {
  const logPath = process.argv[3];
  const { responseCount, success, recentResponses } = scanSuccessRequest(logPath);
  if (responseCount < 1) {
    throw new Error(
      `mock OpenAI /v1/responses was not used. Request log tail: ${readTextFileTail(logPath, ERROR_DETAIL_TAIL_BYTES)}`,
    );
  }
  if (!success) {
    throw new Error(
      `missing success request. Recent /v1/responses: ${JSON.stringify(recentResponses)}`,
    );
  }
  const tools = Array.isArray(success.body.tools) ? success.body.tools : [];
  const hasNativeWebSearch = tools.some((tool) => tool?.type === "web_search");
  if (!hasNativeWebSearch) {
    throw new Error(
      `success request did not include native web_search. Body: ${JSON.stringify(success.body)}`,
    );
  }
  if (success.body.reasoning?.effort === "minimal") {
    throw new Error(
      `expected web_search request to avoid minimal reasoning, got ${JSON.stringify(success.body.reasoning)}`,
    );
  }
}

function assertSchemaRejectLog() {
  const required = [
    'sessionKey="agent:main:openai-web-search-minimal:reject"',
    'runId="schema-reject"',
    "provider=openai",
    "model=gpt-5",
    "status=400",
    "code=invalid_request_error",
    "type=invalid_request_error",
  ];
  let found = false;
  scanTextFileLines(process.argv[3], (line) => {
    const match = /^\d{4}-\d{2}-\d{2}T\S+ \[provider-error\] Model request failed (.+)$/u.exec(
      line,
    );
    if (match) {
      const fields = new Set(match[1].split(/\s+/u));
      found ||= required.every((field) => fields.has(field));
    }
  });
  if (!found) {
    throw new Error("missing provider-error metadata for the controlled schema rejection");
  }
}

const commands = {
  "assert-success-request": assertSuccessRequest,
  "assert-schema-reject-log": assertSchemaRejectLog,
};

const fn = commands[command];
if (!fn) {
  throw new Error(`unknown OpenAI web-search minimal assertion command: ${command}`);
}
await fn();
