import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { AsyncWorkScope } from "openclaw/plugin-sdk/concurrency-runtime";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { addSafeTimeoutDelayGraceMs } from "openclaw/plugin-sdk/number-runtime";
import { resolveDynamicToolServerRequestTimeoutMs } from "./dynamic-tool-execution.js";
import { createCodexElicitationResponse } from "./elicitation-response.js";
import { readCodexDynamicToolCallParams } from "./protocol-validators.js";
import { isJsonObject, type JsonValue, type RpcRequest, type RpcResponse } from "./protocol.js";

export class CodexServerRequestResolvedError extends Error {
  constructor() {
    super("Codex server request resolved by another client");
    this.name = "CodexServerRequestResolvedError";
  }
}

export type CodexServerRequestHandler = (
  request: Required<Pick<RpcRequest, "id" | "method">> & { params?: JsonValue },
  signal?: AbortSignal,
  setExecutionTimeoutMs?: (timeoutMs: number) => void,
) => Promise<JsonValue | undefined> | JsonValue | undefined;

type ServerRequest = Parameters<CodexServerRequestHandler>[0];

/** Physical-client owner for inbound requests, cancellation, and response deadlines. */
export class CodexServerRequests {
  readonly handlers = new Set<CodexServerRequestHandler>();
  private readonly refreshWork = new AsyncWorkScope();
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly active = new Map<
    string | number,
    { threadId: JsonValue | undefined; controller: AbortController }
  >();

  constructor(private readonly respond: (response: RpcResponse) => void) {}

  resolve(params: JsonValue | undefined): void {
    if (!isJsonObject(params) || typeof params.threadId !== "string") {
      return;
    }
    const id = params.requestId;
    if (typeof id !== "string" && typeof id !== "number") {
      return;
    }
    const request = this.active.get(id);
    if (request?.threadId === params.threadId) {
      this.active.delete(id);
      request.controller.abort(new CodexServerRequestResolvedError());
    }
  }

  close(error: Error): Promise<void> {
    this.closed = true;
    this.closing ??= this.refreshWork.drain();
    const requests = [...this.active.values()];
    this.active.clear();
    for (const request of requests) {
      request.controller.abort(error);
    }
    return this.closing;
  }

  async handle(request: ServerRequest): Promise<void> {
    if (this.closed) {
      return;
    }
    const controller = new AbortController();
    const entry = {
      threadId: isJsonObject(request.params) ? request.params.threadId : undefined,
      controller,
    };
    this.active.set(request.id, entry);
    const deadline = createDeferred<JsonValue | undefined>();
    const onAbort = () => deadline.resolve(undefined);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timeoutMs = resolveDynamicToolServerRequestTimeoutMs(
      readCodexDynamicToolCallParams(request.params),
    );
    let settled = false;
    let executionTimeoutResolved = false;
    const armTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        embeddedAgentLog.warn("codex app-server server request timed out", {
          id: request.id,
          method: request.method,
          timeoutMs,
        });
        deadline.resolve(timeoutServerRequestResponse(timeoutMs));
        controller.abort(new Error("codex app-server server request timed out"));
      }, timeoutMs);
      timeout.unref?.();
    };
    const setExecutionTimeoutMs = (executionTimeoutMs: number) => {
      if (
        settled ||
        controller.signal.aborted ||
        executionTimeoutResolved ||
        !Number.isFinite(executionTimeoutMs) ||
        executionTimeoutMs <= 0
      ) {
        return;
      }
      // The admitted owner sets one execution budget; later progress cannot reset it.
      executionTimeoutResolved = true;
      timeoutMs = addSafeTimeoutDelayGraceMs(executionTimeoutMs, 30_000);
      armTimeout();
    };
    const dynamicTool = request.method === "item/tool/call";
    if (dynamicTool) {
      armTimeout();
    }
    const run = async () => {
      for (const handler of this.handlers) {
        if (controller.signal.aborted) {
          return undefined;
        }
        const result = await handler(
          request,
          controller.signal,
          dynamicTool ? setExecutionTimeoutMs : undefined,
        );
        if (result !== undefined) {
          return result;
        }
      }
      return undefined;
    };
    try {
      // Auth recovery belongs to the retained physical client, not the turn
      // whose stdio handles delivered this request. Keep tool/approval work in
      // its existing caller context and join admitted refresh tails at close.
      const work =
        request.method === "account/chatgptAuthTokens/refresh"
          ? this.refreshWork.track(run)
          : run();
      const result = await Promise.race([work, deadline.promise]);
      if (this.active.get(request.id) === entry) {
        this.respond({
          id: request.id,
          result: result === undefined ? defaultServerRequestResponse(request) : result,
        });
      }
    } catch (error) {
      if (this.active.get(request.id) === entry) {
        embeddedAgentLog.warn("codex app-server server request handler failed", {
          id: request.id,
          method: request.method,
          error,
        });
        this.respond({
          id: request.id,
          error: { code: -32603, message: coerceErrorMessage(error) },
        });
      }
    } finally {
      settled = true;
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", onAbort);
      if (this.active.get(request.id) === entry) {
        this.active.delete(request.id);
      }
    }
  }
}

function defaultServerRequestResponse(
  request: Required<Pick<RpcRequest, "id" | "method">> & { params?: JsonValue },
): JsonValue {
  if (request.method === "item/tool/call") {
    return {
      contentItems: [
        {
          type: "inputText",
          text: "OpenClaw did not register a handler for this app-server tool call.",
        },
      ],
      success: false,
    };
  }
  if (
    request.method === "item/commandExecution/requestApproval" ||
    request.method === "item/fileChange/requestApproval"
  ) {
    return { decision: "decline" };
  }
  if (request.method === "item/permissions/requestApproval") {
    return { permissions: {}, scope: "turn" };
  }
  if (request.method === "item/tool/requestUserInput") {
    return {
      answers: {},
    };
  }
  if (request.method === "mcpServer/elicitation/request") {
    return createCodexElicitationResponse("decline", null, {
      message: "OpenClaw has no interactive handler for this elicitation.",
    });
  }
  return {};
}

function timeoutServerRequestResponse(timeoutMs: number): JsonValue {
  return {
    contentItems: [
      {
        type: "inputText",
        text: `OpenClaw dynamic tool call timed out after ${timeoutMs}ms before sending a response to Codex.`,
      },
    ],
    success: false,
  };
}
