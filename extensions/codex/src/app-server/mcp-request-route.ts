import { AsyncResource } from "node:async_hooks";
import { isJsonObject } from "./protocol.js";
import type {
  CodexAppServerServerRequest,
  CodexThreadRequestHandler,
  CodexThreadRouteScope,
} from "./turn-router.types.js";
export type CodexMcpToolCallOptions = {
  threadId: string;
  serverName: string;
  signal?: AbortSignal;
  onRequest: CodexThreadRequestHandler;
};
type Route = {
  threadId: string;
  controller: AbortController;
  onRequest: CodexThreadRequestHandler;
};
/** Subscope of the physical client router; there is no independent connection or registry. */
export class CodexMcpRequestRoutes {
  private readonly routes = new Map<string, Route>();
  hasSiblingWork(threadId: string) {
    return [...this.routes.values()].some((route) => route.threadId !== threadId);
  }
  async run<T>(options: CodexMcpToolCallOptions, operation: () => Promise<T>): Promise<T> {
    options.signal?.throwIfAborted();
    const key = JSON.stringify([options.threadId, options.serverName]);
    if (this.routes.has(key)) {
      throw new Error("An MCP App call is already pending for this server in the conversation");
    }
    const route = {
      threadId: options.threadId,
      controller: new AbortController(),
      onRequest: AsyncResource.bind(options.onRequest),
    };
    const abort = () => route.controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    this.routes.set(key, route);
    try {
      return await operation();
    } finally {
      options.signal?.removeEventListener("abort", abort);
      this.routes.delete(key);
      route.controller.abort(new Error("MCP App call ended"));
    }
  }
  route(
    request: CodexAppServerServerRequest,
    scope: CodexThreadRouteScope,
    signal: AbortSignal,
    setExecutionTimeoutMs?: (timeoutMs: number) => void,
  ) {
    if (
      scope.turnId ||
      request.method !== "mcpServer/elicitation/request" ||
      !isJsonObject(request.params) ||
      typeof request.params.serverName !== "string"
    ) {
      return undefined;
    }
    const route = this.routes.get(JSON.stringify([scope.threadId, request.params.serverName]));
    if (!route) {
      return undefined;
    }
    return (async () => {
      const requestSignal = AbortSignal.any([signal, route.controller.signal]);
      requestSignal.throwIfAborted();
      const result = await route.onRequest(request, scope, requestSignal, setExecutionTimeoutMs);
      return requestSignal.aborted ? undefined : result;
    })();
  }
  close(error: Error) {
    for (const route of this.routes.values()) {
      route.controller.abort(error);
    }
    this.routes.clear();
  }
}
