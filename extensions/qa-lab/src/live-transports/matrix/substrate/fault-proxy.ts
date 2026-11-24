import { once } from "node:events";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { promisify } from "node:util";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

const DEFAULT_FAULT_PROXY_REQUEST_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_FAULT_PROXY_RESPONSE_MAX_BYTES = 20 * 1024 * 1024;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

type MatrixQaFaultProxyRequest = {
  bearerToken?: string;
  body: Buffer;
  headers: IncomingHttpHeaders;
  method: string;
  path: string;
  search: string;
};

type MatrixQaFaultProxyResponse = {
  body?: unknown;
  headers?: Record<string, string>;
  status: number;
};

type MatrixQaFaultProxyForwardedResponse = {
  body: Buffer;
  headers: Headers;
  status: number;
};

type MatrixQaFaultProxyExchange = {
  request: MatrixQaFaultProxyRequest;
  response: MatrixQaFaultProxyForwardedResponse;
};

export type MatrixQaFaultProxyObserver = {
  onExchange?: (exchange: MatrixQaFaultProxyExchange) => Promise<void> | void;
};

class MatrixQaFaultProxyHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MatrixQaFaultProxyHttpError";
  }
}

export type MatrixQaFaultProxyRule = {
  id: string;
  match(request: MatrixQaFaultProxyRequest): boolean;
  mutateResponse?(params: {
    request: MatrixQaFaultProxyRequest;
    response: MatrixQaFaultProxyForwardedResponse;
  }): MatrixQaFaultProxyForwardedResponse | Promise<MatrixQaFaultProxyForwardedResponse>;
  response?(request: MatrixQaFaultProxyRequest): MatrixQaFaultProxyResponse;
};

export type MatrixQaFaultProxyHit = {
  method: string;
  path: string;
  ruleId: string;
};

export type MatrixQaFaultProxyRuleHandle = {
  hits(): MatrixQaFaultProxyHit[];
  remove(): void;
};

type MatrixQaFaultProxy = {
  baseUrl: string;
  hits(): MatrixQaFaultProxyHit[];
  installRule(rule: MatrixQaFaultProxyRule): MatrixQaFaultProxyRuleHandle;
  setTargetBaseUrl(targetBaseUrl: string): void;
  stop(): Promise<void>;
};

type MatrixQaRegisteredFaultProxyRule = {
  hits: MatrixQaFaultProxyHit[];
  rule: MatrixQaFaultProxyRule;
};

function normalizeHeaderValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  return value;
}

function extractBearerToken(headers: IncomingHttpHeaders) {
  const value = normalizeHeaderValue(headers.authorization)?.trim();
  const match = /^Bearer\s+(.+)$/i.exec(value ?? "");
  return match?.[1];
}

function buildFetchHeaders(headers: IncomingHttpHeaders) {
  const result = new Headers();
  for (const [key, rawValue] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase()) || key.toLowerCase() === "host") {
      continue;
    }
    const value = normalizeHeaderValue(rawValue);
    if (value !== undefined) {
      result.set(key, value);
    }
  }
  return result;
}

function rejectOversizedRequestBody(maxBytes: number, size: number) {
  return new MatrixQaFaultProxyHttpError(
    413,
    "MATRIX_QA_FAULT_PROXY_REQUEST_TOO_LARGE",
    `Matrix QA fault proxy request body exceeds ${maxBytes} bytes (got at least ${size})`,
  );
}

function rejectAbortedRequestBody() {
  return new MatrixQaFaultProxyHttpError(
    400,
    "MATRIX_QA_FAULT_PROXY_REQUEST_ABORTED",
    "Matrix QA fault proxy request body ended before upload completed",
  );
}

function drainRejectedRequestBody(req: IncomingMessage) {
  const onError = () => undefined;
  const onClose = () => {
    req.off("error", onError);
  };
  req.on("error", onError);
  req.once("close", onClose);
  req.resume();
}

async function readRequestBody(req: IncomingMessage, maxBytes: number) {
  const contentLength = normalizeHeaderValue(req.headers["content-length"]);
  if (contentLength !== undefined) {
    const size = Number(contentLength);
    if (Number.isFinite(size) && size > maxBytes) {
      drainRejectedRequestBody(req);
      throw rejectOversizedRequestBody(maxBytes, size);
    }
  }

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    // Keep the socket open so an oversized upload can receive its 413 response.
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxBytes) {
        throw rejectOversizedRequestBody(maxBytes, total);
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof MatrixQaFaultProxyHttpError) {
      drainRejectedRequestBody(req);
    } else if (req.aborted) {
      throw rejectAbortedRequestBody();
    }
    throw error;
  }
  return Buffer.concat(chunks, total);
}

function bufferToArrayBuffer(buffer: Buffer) {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

function normalizeJsonResponse(
  response: MatrixQaFaultProxyResponse,
): MatrixQaFaultProxyForwardedResponse {
  const body =
    response.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(response.body));
  return {
    body,
    headers: new Headers({
      "content-type": "application/json",
      ...response.headers,
    }),
    status: response.status,
  };
}

async function forwardMatrixQaFaultProxyRequest(params: {
  body: Buffer;
  maxResponseBytes: number;
  req: IncomingMessage;
  signal: AbortSignal;
  targetUrl: URL;
}): Promise<MatrixQaFaultProxyForwardedResponse> {
  const method = params.req.method ?? "GET";
  const init: RequestInit = {
    headers: buildFetchHeaders(params.req.headers),
    method,
    redirect: "manual",
    signal: params.signal,
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = bufferToArrayBuffer(params.body);
  }
  const { response, release } = await fetchWithSsrFGuard({
    url: params.targetUrl.toString(),
    init,
    policy: { allowPrivateNetwork: true },
    auditContext: "qa-lab-matrix-fault-proxy-forward",
  });
  try {
    return {
      body: await readResponseWithLimit(response, params.maxResponseBytes, {
        onOverflow: ({ size }) =>
          new MatrixQaFaultProxyHttpError(
            502,
            "MATRIX_QA_FAULT_PROXY_RESPONSE_TOO_LARGE",
            `Matrix QA fault proxy upstream response exceeds ${params.maxResponseBytes} bytes (got at least ${size})`,
          ),
      }),
      headers: response.headers,
      status: response.status,
    };
  } finally {
    await release();
  }
}

function writeForwardedResponse(
  res: ServerResponse,
  response: MatrixQaFaultProxyForwardedResponse,
  options: { preserveConnectionClose?: boolean } = {},
) {
  const headers: Record<string, string> = {};
  for (const [key, value] of response.headers) {
    const normalizedKey = key.toLowerCase();
    const isIntentionalConnectionClose =
      options.preserveConnectionClose && normalizedKey === "connection" && value === "close";
    if (
      (!HOP_BY_HOP_HEADERS.has(normalizedKey) || isIntentionalConnectionClose) &&
      normalizedKey !== "content-encoding"
    ) {
      headers[key] = value;
    }
  }
  res.writeHead(response.status, headers);
  res.end(response.body);
}

export async function startMatrixQaFaultProxy(
  params: MatrixQaFaultProxyObserver & {
    maxRequestBytes?: number;
    maxResponseBytes?: number;
    rules: MatrixQaFaultProxyRule[];
    targetBaseUrl: string;
  },
): Promise<MatrixQaFaultProxy> {
  let targetBaseUrl = new URL(params.targetBaseUrl);
  const maxRequestBytes = params.maxRequestBytes ?? DEFAULT_FAULT_PROXY_REQUEST_MAX_BYTES;
  const maxResponseBytes = params.maxResponseBytes ?? DEFAULT_FAULT_PROXY_RESPONSE_MAX_BYTES;
  const registeredRules: MatrixQaRegisteredFaultProxyRule[] = params.rules.map((rule) => ({
    hits: [],
    rule,
  }));
  const hits: MatrixQaFaultProxyHit[] = [];
  const activeAbortControllers = new Set<AbortController>();
  const server = createServer((req, res) => {
    const abortController = new AbortController();
    activeAbortControllers.add(abortController);
    void (async () => {
      let observedRequest: MatrixQaFaultProxyRequest | undefined;
      let observerNotified = false;
      const observeExchange = async (
        request: MatrixQaFaultProxyRequest,
        response: MatrixQaFaultProxyForwardedResponse,
      ) => {
        if (!params.onExchange) {
          return;
        }
        observerNotified = true;
        await params.onExchange({
          request,
          response,
        });
      };
      try {
        const requestTarget = req.url ?? "/";
        if (!requestTarget.startsWith("/") || requestTarget.startsWith("//")) {
          throw new MatrixQaFaultProxyHttpError(
            400,
            "MATRIX_QA_FAULT_PROXY_INVALID_TARGET",
            "Matrix QA fault proxy accepts origin-form request targets only",
          );
        }
        const requestUrl = new URL(requestTarget, targetBaseUrl);
        if (requestUrl.origin !== targetBaseUrl.origin) {
          throw new MatrixQaFaultProxyHttpError(
            400,
            "MATRIX_QA_FAULT_PROXY_INVALID_TARGET",
            "Matrix QA fault proxy request target escaped the configured origin",
          );
        }
        const path = requestUrl.pathname;
        const bearerToken = extractBearerToken(req.headers);
        const body = await readRequestBody(req, maxRequestBytes);
        const request: MatrixQaFaultProxyRequest = {
          ...(bearerToken ? { bearerToken } : {}),
          body,
          headers: req.headers,
          method: req.method ?? "GET",
          path,
          search: requestUrl.search,
        };
        observedRequest = request;
        const registeredRule = registeredRules.find((candidate) => candidate.rule.match(request));
        const rule = registeredRule?.rule;
        if (rule && registeredRule) {
          const hit = {
            method: request.method,
            path: request.path,
            ruleId: rule.id,
          };
          hits.push(hit);
          registeredRule.hits.push(hit);
          if (rule.response) {
            const response = normalizeJsonResponse(rule.response(request));
            await observeExchange(request, response);
            writeForwardedResponse(res, response);
            return;
          }
        }
        const forwarded = await forwardMatrixQaFaultProxyRequest({
          body,
          maxResponseBytes,
          req,
          signal: abortController.signal,
          targetUrl: requestUrl,
        });
        const response =
          rule?.mutateResponse !== undefined
            ? await rule.mutateResponse({
                request,
                response: forwarded,
              })
            : forwarded;
        await observeExchange(request, response);
        writeForwardedResponse(res, response);
      } catch (error) {
        const httpError = error instanceof MatrixQaFaultProxyHttpError ? error : undefined;
        const preserveConnectionClose = httpError?.status === 413;
        const response = normalizeJsonResponse({
          body: {
            errcode: httpError?.code ?? "MATRIX_QA_FAULT_PROXY_ERROR",
            error: error instanceof Error ? error.message : String(error),
          },
          ...(preserveConnectionClose ? { headers: { connection: "close" } } : {}),
          status: httpError?.status ?? 502,
        });
        if (observedRequest && !observerNotified) {
          try {
            await observeExchange(observedRequest, response);
          } catch {
            // Capture is diagnostic; its failure must not strand the original HTTP response.
          }
        }
        if (!res.destroyed) {
          writeForwardedResponse(res, response, { preserveConnectionClose });
        }
      } finally {
        activeAbortControllers.delete(abortController);
      }
    })();
  });

  await once(server.listen(0, "127.0.0.1"), "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Matrix QA fault proxy did not bind to a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    hits: () => [...hits],
    installRule(rule) {
      const registeredRule: MatrixQaRegisteredFaultProxyRule = { hits: [], rule };
      registeredRules.push(registeredRule);
      return {
        hits: () => [...registeredRule.hits],
        remove() {
          const index = registeredRules.indexOf(registeredRule);
          if (index !== -1) {
            registeredRules.splice(index, 1);
          }
        },
      };
    },
    setTargetBaseUrl(nextTargetBaseUrl) {
      targetBaseUrl = new URL(nextTargetBaseUrl);
    },
    stop: async () => {
      const closePromise = promisify(server.close.bind(server))();
      for (const controller of activeAbortControllers) {
        controller.abort();
      }
      server.closeAllConnections();
      await closePromise;
    },
  };
}
