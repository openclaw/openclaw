import { readResponseTextLimited } from "openclaw/plugin-sdk/provider-http";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const SLACK_RESPONSE_URL_BODY_LIMIT_BYTES = 16 * 1024;
const SLACK_RESPONSE_URL_BODY_TIMEOUT_MS = 30_000;

/** Match Slack's Web API and response_url `invalid_blocks` error shapes. */
export function isSlackInvalidBlocksError(error: unknown): boolean {
  const record = asOptionalRecord(error);
  const rawData = record?.data;
  const data = asOptionalRecord(rawData);
  const rawResponseData = asOptionalRecord(record?.response)?.data;
  const responseData = asOptionalRecord(rawResponseData);
  const code =
    data?.error ??
    (typeof rawData === "string" ? rawData : undefined) ??
    responseData?.error ??
    (typeof rawResponseData === "string" ? rawResponseData : undefined) ??
    record?.error;
  return typeof code === "string" && code.trim().toLowerCase() === "invalid_blocks";
}

type SlackResponseLike = {
  status: number;
};

function isSlackResponseLike(value: unknown): value is SlackResponseLike {
  const record = asOptionalRecord(value);
  const body = asOptionalRecord(record?.body);
  return (
    typeof record?.status === "number" &&
    (typeof record.arrayBuffer === "function" || typeof body?.getReader === "function")
  );
}

/** Consume Bolt 5's native response_url body under strict time and byte bounds. */
export async function isSlackInvalidBlocksResponse(response: unknown): Promise<boolean> {
  if (!isSlackResponseLike(response)) {
    return isSlackInvalidBlocksError(response);
  }
  try {
    const body = await readResponseTextLimited(
      response as Response,
      SLACK_RESPONSE_URL_BODY_LIMIT_BYTES,
      { timeoutMs: SLACK_RESPONSE_URL_BODY_TIMEOUT_MS },
    );
    if (body.trim().toLowerCase() === "invalid_blocks") {
      return true;
    }
    return isSlackInvalidBlocksError(JSON.parse(body));
  } catch {
    return false;
  }
}

/** Bolt 5 omits the response body from RespondError; 400 is contextual here. */
export function isSlackNativeResponseUrlRejection(error: unknown): boolean {
  if (isSlackInvalidBlocksError(error)) {
    return true;
  }
  const record = asOptionalRecord(error);
  return record?.code === "slack_bolt_respond_error" && record.statusCode === 400;
}
