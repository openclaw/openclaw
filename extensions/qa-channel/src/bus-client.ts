import http from "node:http";
import https from "node:https";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { resolvePositiveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import {
  buildQaTarget,
  parseQaTarget,
  type QaTargetParts,
  type QaBusCreateThreadInput,
  type QaBusDeleteMessageInput,
  type QaBusEditMessageInput,
  type QaBusReactToMessageInput,
  type QaBusReadMessageInput,
  type QaBusOutboundMessageInput,
  type QaBusInboundMessageInput,
  type QaBusMessage,
  type QaBusPollResult,
  type QaBusSearchMessagesInput,
  type QaBusStateSnapshot,
  type QaBusThread,
} from "openclaw/plugin-sdk/qa-channel-protocol";
import { readByteStreamWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

export { buildQaTarget, parseQaTarget };

export type {
  QaBusAttachment,
  QaBusConversation,
  QaBusConversationKind,
  QaBusCreateThreadInput,
  QaBusDeleteMessageInput,
  QaBusEditMessageInput,
  QaBusEvent,
  QaBusInboundMessageInput,
  QaBusMessage,
  QaBusOutboundMessageInput,
  QaBusPollInput,
  QaBusPollResult,
  QaBusReactToMessageInput,
  QaBusReadMessageInput,
  QaBusSearchMessagesInput,
  QaBusStateSnapshot,
  QaBusThread,
  QaBusToolCall,
  QaBusWaitForInput,
} from "openclaw/plugin-sdk/qa-channel-protocol";

type QaBusAccountRequest<T> = Omit<T, "accountId" | "timestamp"> & {
  baseUrl: string;
  accountId: string;
};
const QA_BUS_JSON_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
/** Total deadline for local qa-bus POST requests and long-poll response grace. */
const QA_BUS_REQUEST_TIMEOUT_MS = 10_000;
// Final replies can contend with CPU-heavy QA lanes on the shared release
// runner. Keep delivery inside the outer turn budget without treating a brief
// local scheduling stall as a channel failure.
const QA_BUS_MESSAGE_REQUEST_TIMEOUT_MS = 30_000;
/** Total deadline for local qa-bus state requests. */
const QA_BUS_STATE_TIMEOUT_MS = 10_000;

type QaBusPostOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

function buildQaBusUrl(baseUrl: string, path: string): URL {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\/+/, ""), normalizedBaseUrl);
}

async function readQaBusNodeJsonResponse<T>(
  response: http.IncomingMessage,
  label: string,
): Promise<T> {
  const bytes = await readByteStreamWithLimit(response, {
    maxBytes: QA_BUS_JSON_RESPONSE_MAX_BYTES,
    onOverflow: ({ maxBytes }) => new Error(`${label}: JSON response exceeds ${maxBytes} bytes`),
  });
  const text = bytes.toString("utf8");
  if (!text) {
    return {} as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new Error(`${label}: malformed JSON response`, { cause });
  }
}

async function postJson<T>(
  baseUrl: string,
  path: string,
  body: unknown,
  options: QaBusPostOptions = {},
): Promise<T> {
  const url = buildQaBusUrl(baseUrl, path);
  const payload = JSON.stringify(body);
  const client = url.protocol === "https:" ? https : http;
  const timeoutMs = resolvePositiveTimerTimeoutMs(options.timeoutMs, QA_BUS_REQUEST_TIMEOUT_MS);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

  return await new Promise<T>((resolve, reject) => {
    const request = client.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          connection: "close",
        },
        signal,
      },
      (response) => {
        const label = `qa-bus ${path}`;
        void readQaBusNodeJsonResponse<T | { error?: string }>(response, label).then(
          (parsed) => {
            if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
              const error =
                typeof parsed === "object" && parsed && "error" in parsed
                  ? parsed.error
                  : undefined;
              reject(new Error(error || `qa-bus request failed: ${response.statusCode ?? 500}`));
              return;
            }
            resolve(parsed as T);
          },
          (error: unknown) => {
            reject(toErrorObject(error, "Non-Error rejection"));
          },
        );
        response.on("error", reject);
      },
    );

    request.on("error", reject);
    request.end(payload);
  });
}

export function normalizeQaTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

export function resolveQaTargetThread(params: {
  target: string;
  threadId?: string | number | null;
}): { target: QaTargetParts; threadId?: string } {
  const target = parseQaTarget(params.target);
  const explicitThreadId = params.threadId == null ? "" : String(params.threadId).trim();
  if (target.threadId && explicitThreadId && target.threadId !== explicitThreadId) {
    throw new Error("qa-channel target conflicts with the explicit threadId");
  }
  const threadId = explicitThreadId || target.threadId;
  return {
    target,
    ...(threadId ? { threadId } : {}),
  };
}

export async function pollQaBus(params: {
  baseUrl: string;
  accountId: string;
  cursor: number;
  acknowledgedCursor: number;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<QaBusPollResult> {
  return await postJson<QaBusPollResult>(
    params.baseUrl,
    "/v1/poll",
    {
      accountId: params.accountId,
      cursor: params.cursor,
      acknowledgedCursor: params.acknowledgedCursor,
      timeoutMs: params.timeoutMs,
    },
    {
      signal: params.signal,
      timeoutMs: params.timeoutMs + QA_BUS_REQUEST_TIMEOUT_MS,
    },
  );
}

export async function sendQaBusMessage(params: QaBusAccountRequest<QaBusOutboundMessageInput>) {
  return await postJson<{ message: QaBusMessage }>(params.baseUrl, "/v1/outbound/message", params, {
    timeoutMs: QA_BUS_MESSAGE_REQUEST_TIMEOUT_MS,
  });
}

export async function createQaBusThread(params: QaBusAccountRequest<QaBusCreateThreadInput>) {
  return await postJson<{ thread: QaBusThread }>(
    params.baseUrl,
    "/v1/actions/thread-create",
    params,
  );
}

export async function reactToQaBusMessage(params: QaBusAccountRequest<QaBusReactToMessageInput>) {
  return await postJson<{ message: QaBusMessage }>(params.baseUrl, "/v1/actions/react", params);
}

export async function editQaBusMessage(params: QaBusAccountRequest<QaBusEditMessageInput>) {
  return await postJson<{ message: QaBusMessage }>(params.baseUrl, "/v1/actions/edit", params);
}

export async function deleteQaBusMessage(params: QaBusAccountRequest<QaBusDeleteMessageInput>) {
  return await postJson<{ message: QaBusMessage }>(params.baseUrl, "/v1/actions/delete", params);
}

export async function readQaBusMessage(params: QaBusAccountRequest<QaBusReadMessageInput>) {
  return await postJson<{ message: QaBusMessage }>(params.baseUrl, "/v1/actions/read", params);
}

export async function searchQaBusMessages(params: {
  baseUrl: string;
  input: QaBusSearchMessagesInput;
}) {
  return await postJson<{ messages: QaBusMessage[] }>(
    params.baseUrl,
    "/v1/actions/search",
    params.input,
  );
}

export async function injectQaBusInboundMessage(params: {
  baseUrl: string;
  input: QaBusInboundMessageInput;
}) {
  return await postJson<{ message: QaBusMessage }>(
    params.baseUrl,
    "/v1/inbound/message",
    params.input,
  );
}

export async function getQaBusState(baseUrl: string): Promise<QaBusStateSnapshot> {
  const { response, release } = await fetchWithSsrFGuard({
    url: buildQaBusUrl(baseUrl, "/v1/state").toString(),
    policy: { allowPrivateNetwork: true },
    auditContext: "qa-channel.bus-state",
    timeoutMs: QA_BUS_STATE_TIMEOUT_MS,
  });
  try {
    if (!response.ok) {
      throw new Error(`qa-bus request failed: ${response.status}`);
    }
    return await readProviderJsonResponse<QaBusStateSnapshot>(response, "qa-channel.bus-state");
  } finally {
    await release();
  }
}
