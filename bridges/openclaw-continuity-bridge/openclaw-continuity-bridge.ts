import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createEngineToolDefinitions, type EngineToolOptions } from "./engine-tools.js";
import {
  createMemoryReadToolDefinitions,
  type MemoryReadToolOptions,
} from "./memory-read-tools.js";
import { proxyToolCall, proxyReadOnlyToolCall, type ProxyConfig } from "./proxy.js";

const DEFAULT_WORKSPACE_ID = "00000000-0000-0000-0000-000000000000";
const FIXED_CALLER_TAG = "vairys-openclaw";
const MAX_REQUEST_BODY_BYTES = 32 * 1024;
const DOWNSTREAM_TIMEOUT_MS = 30_000;

const PARITY_ALLOWED_TOOLS = [
  "continuity_linkage_read",
  "continuity_receipt_read",
  "continuity_write",
  "engine_get_foreman_state",
  "engine_get_run",
  "engine_list_runs",
  "hq_health",
  "linked_session_observe",
  "memory_context",
  "memory_list",
  "memory_read",
  "memory_search",
  "workstream_message_poll",
  "workstream_message_send",
  "workstream_check_in",
] as const;

const ALLOWED_TOOL_SET = new Set<string>(PARITY_ALLOWED_TOOLS);
const PROXY_TOOL_SET = new Set<string>([
  "continuity_linkage_read",
  "continuity_receipt_read",
  "continuity_write",
  "linked_session_observe",
  "workstream_message_poll",
  "workstream_message_send",
  "workstream_check_in",
]);

const PARITY_SELECTOR_FIELDS = {
  receipt_id: z.string().min(1).optional(),
  card_id: z.string().min(1).optional(),
  workflow_run_id: z.string().min(1).optional(),
} satisfies Record<string, z.ZodTypeAny>;

function refineParitySelector(
  input: { receipt_id?: string; card_id?: string; workflow_run_id?: string },
  ctx: z.RefinementCtx,
): void {
  const selectors = [
    input.receipt_id ? "receipt_id" : null,
    input.card_id ? "card_id" : null,
    input.workflow_run_id ? "workflow_run_id" : null,
  ].filter((value): value is string => value !== null);

  if (selectors.length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Exactly one of receipt_id, card_id, or workflow_run_id is required",
      path: selectors.length === 0 ? ["receipt_id"] : ["workflow_run_id"],
    });
  }
}

const BRIDGE_PARITY_INPUT_SCHEMAS: Record<string, z.ZodTypeAny> = {
  workstream_message_send: z
    .object({
      ...PARITY_SELECTOR_FIELDS,
      message_type: z.enum(["query", "status", "response", "decision"]),
      content: z.string().min(1),
      in_reply_to: z.string().min(1).optional(),
    })
    .strict()
    .superRefine(refineParitySelector),
  workstream_message_poll: z
    .object({
      ...PARITY_SELECTOR_FIELDS,
      ack: z.boolean().default(false),
      limit: z.number().int().min(1).max(50).optional(),
    })
    .strict()
    .superRefine(refineParitySelector),
};

type ToolRequestBody = {
  caller?: unknown;
  tool?: unknown;
  input?: unknown;
};

export interface ContinuityBridgeApp {
  handle(request: Request): Promise<Response>;
}

export interface ContinuityBridgeOptions {
  workspaceId?: string;
  allowedTools?: readonly string[];
  memoryReadToolOptions?: MemoryReadToolOptions;
  engineToolOptions?: EngineToolOptions;
  proxyConfig?: ProxyConfig;
  logger?: (line: string) => void;
  requestIdFactory?: () => string;
  bodySizeLimitBytes?: number;
  downstreamTimeoutMs?: number;
}

export interface ContinuityBridgeServerOptions extends ContinuityBridgeOptions {
  host?: string;
  port?: number;
}

function jsonResponse(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function parseCaller(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseTool(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function defaultLogger(line: string): void {
  process.stdout.write(`${line}\n`);
}

function buildLogLine(entry: {
  requestId: string;
  method: string;
  path: string;
  caller: string | null;
  tool: string | null;
  outcome: string;
  startedAt: number;
}): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    request_id: entry.requestId,
    method: entry.method,
    path: entry.path,
    caller: entry.caller,
    tool: entry.tool,
    outcome: entry.outcome,
    latency_ms: Date.now() - entry.startedAt,
  });
}

class ContinuityBridgeHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ContinuityBridgeHttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type ToolStatsAccumulator = {
  count: number;
  errorCount: number;
  totalLatencyMs: number;
};

type BridgeRuntimeStats = {
  startedAtMs: number;
  totalRequests: number;
  byTool: Map<string, ToolStatsAccumulator>;
  errorsByTool: Map<string, number>;
};

const HTTP_STATUS_BY_ERROR_CODE: Record<string, number> = {
  AUTH_FAILED: 401,
  CALLER_NOT_ALLOWED: 403,
  WRITE_OPTION_NOT_ALLOWED: 403,
  TOOL_NOT_ALLOWED: 403,
  VALIDATION_ERROR: 400,
  WORKFLOW_INPUT_VALIDATION_FAILED: 400,
  INVALID_CARD_TYPE: 400,
  RECEIPT_NOT_FOUND: 404,
  WORKFLOW_NOT_APPROVED: 409,
  CARD_GOVERNANCE_VIOLATION: 409,
  CONTINUITY_CONTEXT_UNRESOLVED: 409,
  TEMPORAL_QUERY_SCHEMA_REQUIRED: 409,
  TIMEOUT: 504,
  HQ_UNREACHABLE: 503,
  PROXY_ERROR: 502,
};

function createBridgeRuntimeStats(): BridgeRuntimeStats {
  return {
    startedAtMs: Date.now(),
    totalRequests: 0,
    byTool: new Map<string, ToolStatsAccumulator>(),
    errorsByTool: new Map<string, number>(),
  };
}

function recordRequestStat(
  stats: BridgeRuntimeStats,
  tool: string | null,
  outcome: string,
  latencyMs: number,
): void {
  stats.totalRequests += 1;
  if (!tool) {
    return;
  }

  const current = stats.byTool.get(tool) ?? {
    count: 0,
    errorCount: 0,
    totalLatencyMs: 0,
  };
  current.count += 1;
  current.totalLatencyMs += latencyMs;

  if (outcome !== "ok") {
    current.errorCount += 1;
    stats.errorsByTool.set(tool, (stats.errorsByTool.get(tool) ?? 0) + 1);
  }

  stats.byTool.set(tool, current);
}

function buildStatsPayload(stats: BridgeRuntimeStats): Record<string, unknown> {
  const byTool = Object.fromEntries(
    [...stats.byTool.entries()]
      .toSorted(([left], [right]: [string, ToolStatsAccumulator]) => left.localeCompare(right))
      .map(([toolName, toolStats]) => [
        toolName,
        {
          count: toolStats.count,
          error_count: toolStats.errorCount,
          avg_latency_ms: toolStats.count === 0 ? 0 : toolStats.totalLatencyMs / toolStats.count,
        },
      ]),
  );

  const errorsByTool = Object.fromEntries(
    [...stats.errorsByTool.entries()].toSorted(([left], [right]: [string, number]) =>
      left.localeCompare(right),
    ),
  );

  return {
    ok: true,
    start_time: new Date(stats.startedAtMs).toISOString(),
    uptime_ms: Date.now() - stats.startedAtMs,
    total_requests: stats.totalRequests,
    by_tool: byTool,
    errors_by_tool: errorsByTool,
  };
}

function errorResponse(error: ContinuityBridgeHttpError): Response {
  return jsonResponse(error.status, {
    ok: false,
    error: error.message,
    code: error.code,
    ...error.details,
  });
}

async function parseToolRequestBody(
  request: Request,
  bodySizeLimitBytes: number,
): Promise<ToolRequestBody> {
  const rawBody = await request.text();
  const sizeBytes = Buffer.byteLength(rawBody, "utf8");
  if (sizeBytes > bodySizeLimitBytes) {
    throw new ContinuityBridgeHttpError(
      413,
      "PAYLOAD_TOO_LARGE",
      `Request body exceeds ${bodySizeLimitBytes} bytes`,
      { max_bytes: bodySizeLimitBytes },
    );
  }

  try {
    return JSON.parse(rawBody) as ToolRequestBody;
  } catch {
    throw new ContinuityBridgeHttpError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new ContinuityBridgeHttpError(
          504,
          "TIMEOUT",
          `Tool request timed out after ${timeoutMs / 1000}s`,
        ),
      );
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function normalizeErrorPayload(parsed: Record<string, unknown>): Record<string, unknown> {
  return parsed.ok === false ? parsed : { ok: false, ...parsed };
}

function validateToolInput(
  tool: string,
  schema: Record<string, z.ZodTypeAny>,
  input: Record<string, unknown>,
):
  | {
      ok: true;
      input: Record<string, unknown>;
    }
  | {
      ok: false;
      response: Response;
      outcome: string;
    } {
  const result = z.object(schema).strict().safeParse(input);
  if (result.success) {
    return {
      ok: true,
      input: result.data,
    };
  }

  return {
    ok: false,
    response: jsonResponse(400, {
      ok: false,
      error: result.error.issues[0]?.message ?? `Tool '${tool}' input failed validation`,
      code: "VALIDATION_ERROR",
      tool,
      issues: result.error.issues,
    }),
    outcome: "VALIDATION_ERROR",
  };
}

function validateRequestInput(
  tool: string,
  input: unknown,
):
  | {
      ok: true;
      input: Record<string, unknown>;
    }
  | {
      ok: false;
      response: Response;
      outcome: string;
    } {
  const paritySchema = BRIDGE_PARITY_INPUT_SCHEMAS[tool];
  if (paritySchema) {
    const candidateInput = input === undefined ? {} : input;

    if (!candidateInput || typeof candidateInput !== "object" || Array.isArray(candidateInput)) {
      return {
        ok: false,
        response: jsonResponse(400, {
          ok: false,
          error: "input must be a JSON object when provided",
          code: "VALIDATION_ERROR",
          tool,
          issues: [
            {
              code: "invalid_type",
              expected: "object",
              received: Array.isArray(candidateInput)
                ? "array"
                : candidateInput === null
                  ? "null"
                  : typeof candidateInput,
              path: ["input"],
              message: "input must be a JSON object when provided",
            },
          ],
        }),
        outcome: "VALIDATION_ERROR",
      };
    }

    const result = paritySchema.safeParse(candidateInput);
    if (result.success) {
      return {
        ok: true,
        input: result.data as Record<string, unknown>,
      };
    }

    return {
      ok: false,
      response: jsonResponse(400, {
        ok: false,
        error: result.error.issues[0]?.message ?? `Tool '${tool}' input failed validation`,
        code: "VALIDATION_ERROR",
        tool,
        issues: result.error.issues,
      }),
      outcome: "VALIDATION_ERROR",
    };
  }

  if (input === undefined) {
    return {
      ok: true,
      input: {},
    };
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      response: jsonResponse(400, {
        ok: false,
        error: "input must be a JSON object when provided",
        code: "VALIDATION_ERROR",
        tool,
        issues: [
          {
            code: "invalid_type",
            expected: "object",
            received: Array.isArray(input) ? "array" : input === null ? "null" : typeof input,
            path: ["input"],
            message: "input must be a JSON object when provided",
          },
        ],
      }),
      outcome: "VALIDATION_ERROR",
    };
  }

  return {
    ok: true,
    input: { ...(input as Record<string, unknown>) },
  };
}

function responseForToolError(
  parsed: Record<string, unknown>,
  isError: boolean | undefined,
): {
  response: Response;
  outcome: string;
} {
  const code = typeof parsed.code === "string" ? parsed.code : null;
  const error = typeof parsed.error === "string" ? parsed.error : null;
  const normalized = normalizeErrorPayload(parsed);

  if (code && HTTP_STATUS_BY_ERROR_CODE[code]) {
    return {
      response: jsonResponse(HTTP_STATUS_BY_ERROR_CODE[code], normalized),
      outcome: code,
    };
  }
  if (error === "Memory not found" || /not found/i.test(error ?? "")) {
    return { response: jsonResponse(404, normalized), outcome: code ?? "NOT_FOUND" };
  }
  if (error && isError) {
    return {
      response: jsonResponse(500, normalized),
      outcome: code ?? "EXECUTION_ERROR",
    };
  }
  if (error) {
    return {
      response: jsonResponse(400, normalized),
      outcome: code ?? "BAD_REQUEST",
    };
  }

  return { response: jsonResponse(200, parsed), outcome: "ok" };
}

export function createContinuityBridgeApp(
  options: ContinuityBridgeOptions = {},
): ContinuityBridgeApp {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const fixedCallerTag = FIXED_CALLER_TAG;
  const requestedAllowedTools = options.allowedTools ?? PARITY_ALLOWED_TOOLS;
  const allowedTools = [
    ...new Set(requestedAllowedTools.filter((tool) => ALLOWED_TOOL_SET.has(tool))),
  ].toSorted();
  const allowedToolSet = new Set<string>(allowedTools);
  const logger = options.logger ?? defaultLogger;
  const requestIdFactory = options.requestIdFactory ?? randomUUID;
  const bodySizeLimitBytes = options.bodySizeLimitBytes ?? MAX_REQUEST_BODY_BYTES;
  const downstreamTimeoutMs = options.downstreamTimeoutMs ?? DOWNSTREAM_TIMEOUT_MS;
  const stats = createBridgeRuntimeStats();
  const memoryReadTools = new Map(
    createMemoryReadToolDefinitions({
      ...options.memoryReadToolOptions,
      defaultWorkspaceId: workspaceId,
      allowTelemetryPersistence: false,
    }).map((definition) => [definition.name, definition] as const),
  );
  const engineReadTools = new Map(
    createEngineToolDefinitions({
      ...options.engineToolOptions,
      defaultWorkspaceId: workspaceId,
      foremanStateMode: "workspace",
    })
      .filter((definition) => allowedToolSet.has(definition.name))
      .map((definition) => [definition.name, definition] as const),
  );
  const proxyConfig: ProxyConfig = {
    hqBaseUrl:
      options.proxyConfig?.hqBaseUrl ?? process.env.AIRYA_HQ_URL ?? "http://localhost:3000",
    apiSecret: options.proxyConfig?.apiSecret ?? process.env.AIRYA_TOOL_API_SECRET,
    workspaceId,
    fetchFn: options.proxyConfig?.fetchFn,
    retryDelayMs: options.proxyConfig?.retryDelayMs,
    agentToolAllowlist: allowedTools,
  };

  return {
    async handle(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const startedAt = Date.now();
      const requestId = requestIdFactory();
      let caller: string | null = null;
      let tool: string | null = null;

      const finish = (response: Response, outcome: string): Response => {
        const latencyMs = Date.now() - startedAt;
        recordRequestStat(stats, tool, outcome, latencyMs);
        logger(
          buildLogLine({
            requestId,
            method: request.method,
            path: url.pathname,
            caller,
            tool,
            outcome,
            startedAt,
          }),
        );
        return response;
      };

      try {
        if (request.method === "GET" && url.pathname === "/health") {
          return finish(
            jsonResponse(200, {
              ok: true,
              status: "ok",
              workspace_id: workspaceId,
              tools: allowedTools,
            }),
            "ok",
          );
        }

        if (request.method === "GET" && url.pathname === "/stats") {
          return finish(jsonResponse(200, buildStatsPayload(stats)), "ok");
        }

        if (request.method === "POST" && url.pathname === "/tool") {
          const parsed = await parseToolRequestBody(request, bodySizeLimitBytes);

          caller = parseCaller(parsed.caller);
          tool = parseTool(parsed.tool);

          if (!caller) {
            return finish(
              jsonResponse(400, {
                ok: false,
                error: "caller is required",
                code: "MISSING_CALLER",
              }),
              "MISSING_CALLER",
            );
          }

          if (caller !== fixedCallerTag) {
            return finish(
              jsonResponse(403, {
                ok: false,
                error: `caller '${caller}' is not allowed; fixed caller is '${fixedCallerTag}'`,
                code: "CALLER_NOT_ALLOWED",
                caller,
                allowed_caller: fixedCallerTag,
              }),
              "CALLER_NOT_ALLOWED",
            );
          }
          caller = fixedCallerTag;

          if (!tool) {
            return finish(
              jsonResponse(400, {
                ok: false,
                error: "tool is required",
                code: "MISSING_TOOL",
              }),
              "MISSING_TOOL",
            );
          }

          if (!allowedToolSet.has(tool)) {
            return finish(
              jsonResponse(403, {
                ok: false,
                error: `Tool '${tool}' is not allowed in the continuity bridge L1 pack`,
                code: "TOOL_NOT_ALLOWED",
                tool,
              }),
              "TOOL_NOT_ALLOWED",
            );
          }

          const normalizedInput = validateRequestInput(tool, parsed.input);
          if (!normalizedInput.ok) {
            return finish(normalizedInput.response, normalizedInput.outcome);
          }
          const input = normalizedInput.input;
          const requestedWorkspaceId = input.workspace_id;
          if (requestedWorkspaceId !== undefined && requestedWorkspaceId !== workspaceId) {
            return finish(
              jsonResponse(400, {
                ok: false,
                error: "workspace_id override is not allowed",
                code: "WORKSPACE_OVERRIDE_NOT_ALLOWED",
                workspace_id: workspaceId,
              }),
              "WORKSPACE_OVERRIDE_NOT_ALLOWED",
            );
          }

          const downstreamInput = {
            ...input,
            workspace_id: workspaceId,
          };

          if (tool === "hq_health") {
            const { response, outcome } = toolResultToHttpResponse(
              await withTimeout(
                proxyReadOnlyToolCall(tool, downstreamInput, proxyConfig, {
                  callerTag: fixedCallerTag,
                }),
                downstreamTimeoutMs,
              ),
            );
            return finish(response, outcome);
          }

          const memoryTool = memoryReadTools.get(tool);
          if (memoryTool) {
            const validated = validateToolInput(tool, memoryTool.schema, input);
            if (!validated.ok) {
              return finish(validated.response, validated.outcome);
            }
            const { response, outcome } = toolResultToHttpResponse(
              await withTimeout(
                memoryTool.handler({
                  ...validated.input,
                  workspace_id: workspaceId,
                }),
                downstreamTimeoutMs,
              ),
            );
            return finish(response, outcome);
          }

          const engineTool = engineReadTools.get(tool);
          if (engineTool) {
            const validated = validateToolInput(tool, engineTool.schema, input);
            if (!validated.ok) {
              return finish(validated.response, validated.outcome);
            }
            const { response, outcome } = toolResultToHttpResponse(
              await withTimeout(
                engineTool.handler({
                  ...validated.input,
                  workspace_id: workspaceId,
                }),
                downstreamTimeoutMs,
              ),
            );
            return finish(response, outcome);
          }

          if (PROXY_TOOL_SET.has(tool)) {
            const { response, outcome } = toolResultToHttpResponse(
              await withTimeout(
                proxyToolCall(tool, downstreamInput, proxyConfig, {
                  callerTag: fixedCallerTag,
                }),
                downstreamTimeoutMs,
              ),
            );
            return finish(response, outcome);
          }

          return finish(
            jsonResponse(501, {
              ok: false,
              error: `Tool '${tool}' is not wired yet`,
              code: "TOOL_NOT_IMPLEMENTED",
              tool,
              caller,
              workspace_id: workspaceId,
            }),
            "TOOL_NOT_IMPLEMENTED",
          );
        }

        return finish(
          jsonResponse(404, {
            ok: false,
            error: "Not found",
            code: "NOT_FOUND",
          }),
          "NOT_FOUND",
        );
      } catch (error) {
        if (error instanceof ContinuityBridgeHttpError) {
          return finish(errorResponse(error), error.code);
        }
        return finish(
          jsonResponse(500, {
            ok: false,
            error: error instanceof Error ? error.message : "Unknown continuity bridge error",
            code: "BRIDGE_ERROR",
          }),
          "BRIDGE_ERROR",
        );
      }
    },
  };
}

export function createContinuityBridgeServer(options: ContinuityBridgeServerOptions = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 18910;
  const logger = options.logger ?? defaultLogger;
  const requestIdFactory = options.requestIdFactory ?? randomUUID;
  const { host: _host, port: _port, ...appOptions } = options;
  const app = createContinuityBridgeApp({
    ...appOptions,
    logger,
    requestIdFactory,
  });

  return createServer(async (req, res) => {
    let appHandled = false;
    const startedAt = Date.now();
    try {
      const request = await toWebRequest(
        req,
        host,
        port,
        options.bodySizeLimitBytes ?? MAX_REQUEST_BODY_BYTES,
      );
      const response = await app.handle(request);
      appHandled = true;
      await writeNodeResponse(res, response);
    } catch (error) {
      const outcome = error instanceof ContinuityBridgeHttpError ? error.code : "BRIDGE_ERROR";
      if (!appHandled) {
        logger(
          buildLogLine({
            requestId: requestIdFactory(),
            method: req.method ?? "GET",
            path: new URL(req.url ?? "/", `http://${host}:${port}`).pathname,
            caller: null,
            tool: null,
            outcome,
            startedAt,
          }),
        );
      }
      const response =
        error instanceof ContinuityBridgeHttpError
          ? errorResponse(error)
          : jsonResponse(500, {
              ok: false,
              error: error instanceof Error ? error.message : "Unknown continuity bridge error",
              code: "BRIDGE_ERROR",
            });
      await writeNodeResponse(res, response);
    }
  });
}

function toolResultToHttpResponse(result: {
  content: Array<{ text: string }>;
  isError?: boolean;
}): { response: Response; outcome: string } {
  const rawText = result.content[0]?.text ?? "";
  const parsed = parseJson(rawText);

  if (parsed) {
    return responseForToolError(parsed, result.isError);
  }

  return {
    response: jsonResponse(result.isError ? 500 : 200, {
      ok: !result.isError,
      text: rawText,
    }),
    outcome: result.isError ? "EXECUTION_ERROR" : "ok",
  };
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return null;
}

async function toWebRequest(
  req: IncomingMessage,
  host: string,
  port: number,
  bodySizeLimitBytes: number,
): Promise<Request> {
  const body =
    req.method === "GET" || req.method === "HEAD"
      ? undefined
      : await readRequestBody(req, bodySizeLimitBytes);
  return new Request(new URL(req.url ?? "/", `http://${host}:${port}`), {
    method: req.method ?? "GET",
    headers: req.headers as Record<string, string>,
    body: body ? new Uint8Array(body) : undefined,
  });
}

function readRequestBody(req: IncomingMessage, bodySizeLimitBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let rejected = false;
    req.on("data", (chunk) => {
      if (rejected) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > bodySizeLimitBytes) {
        rejected = true;
        reject(
          new ContinuityBridgeHttpError(
            413,
            "PAYLOAD_TOO_LARGE",
            `Request body exceeds ${bodySizeLimitBytes} bytes`,
            { max_bytes: bodySizeLimitBytes },
          ),
        );
        req.resume();
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (!rejected) {
        resolve(Buffer.concat(chunks));
      }
    });
    req.on("error", (error) => {
      if (!rejected) {
        reject(error);
      }
    });
  });
}

async function writeNodeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  res.end(buffer);
}

async function main(): Promise<void> {
  const host = process.env.OPENCLAW_CONTINUITY_HOST ?? "127.0.0.1";
  const port = Number.parseInt(process.env.OPENCLAW_CONTINUITY_PORT ?? "18910", 10);
  const server = createContinuityBridgeServer({ host, port });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  process.stderr.write(`OpenClaw continuity bridge listening on http://${host}:${port}\n`);
}

const entryPath = process.argv[1] ? fileURLToPath(new URL(import.meta.url)) : null;
if (entryPath && process.argv[1] === entryPath) {
  main().catch((error: unknown) => {
    process.stderr.write(`Fatal: ${error instanceof Error ? error.message : "Unknown error"}\n`);
    process.exit(1);
  });
}

export { ALLOWED_TOOL_SET, DEFAULT_WORKSPACE_ID, PARITY_ALLOWED_TOOLS };
