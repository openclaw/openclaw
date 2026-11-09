import { AsyncLocalStorage } from "node:async_hooks";
import {
  ProtocolError,
  ProtocolErrorCode,
  isInputRequiredResult,
  withInputRequired,
  type Client,
  type ClientContext,
  type InputResponses,
  type RequestOptions,
  type ServerNotification,
  type StandardSchemaV1,
  type Transport,
} from "@modelcontextprotocol/client";
import {
  CallToolResultSchema,
  GetPromptResultSchema,
  ReadResourceResultSchema,
} from "@modelcontextprotocol/core";
import { z } from "zod";
import {
  captureGuardedFetchRequestAuthority,
  withGuardedFetchRequestAuthority,
} from "../infra/net/fetch-request-authority.js";
import { logWarn } from "../logger.js";
import type { McpToolCatalogMetadata } from "./mcp-tool-metadata.js";
import type {
  NativeMcpClientContext,
  NativeMcpRequestOptions,
  NativeMcpResponse,
  NativeMcpServerEvent,
  NativeMcpServerView,
} from "./native-mcp-runtime.js";

type View = {
  context: NativeMcpClientContext;
  signal: AbortSignal;
  assertCurrent: () => void;
  restore: ReturnType<typeof AsyncLocalStorage.snapshot>;
  listeners: Set<(event: NativeMcpServerEvent) => void>;
};
type ActiveRequest = {
  view: View;
  signal: AbortSignal;
  assertCurrent: () => void;
  holdForHumanInput: () => () => void;
};

/** Typed adaptation only. The containing session owns connection, admission and cleanup. */
export function createNativeMcpClientBridge(params: {
  client: Client;
  transport: Transport;
  transportType: "stdio" | "sse" | "streamable-http";
  context: NativeMcpClientContext;
  signal: AbortSignal;
  invalidateCatalog: () => void;
  validatorForCall: McpToolCatalogMetadata["validatorForCall"];
  retire: () => Promise<void>;
  acquireLease: () => () => void;
  runRequest: <T>(
    signal: AbortSignal,
    run: (
      options: RequestOptions & { signal: AbortSignal },
      holdForHumanInput: () => () => void,
    ) => Promise<T>,
  ) => Promise<T>;
}) {
  const { client } = params;
  const send = params.transport.send.bind(params.transport);
  params.transport.send = async (message, options) => {
    if ("method" in message && "id" in message) {
      captureGuardedFetchRequestAuthority()?.();
    }
    await send(message, options);
  };
  const views = new Set<View>();
  const active = new Set<ActiveRequest>();
  const urlElicitations = new Map<string, View>();
  let closed = false;
  const assertOpen = () => {
    if (closed) {
      throw new Error("MCP connection closed; reacquire the server view");
    }
  };

  const callbackOwner = () => {
    // Legacy callbacks have no portable parent id. Never guess between callers.
    if (active.size !== 1) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidRequest,
        "MCP callback has no unambiguous active requester",
      );
    }
    const call = active.values().next().value!;
    call.assertCurrent();
    return call;
  };
  const callback = async <T>(
    extra: ClientContext,
    run: (view: View, signal: AbortSignal) => Promise<T>,
    humanInput = false,
  ) => {
    const call = callbackOwner();
    const signal = AbortSignal.any([call.signal, extra.mcpReq.signal]);
    signal.throwIfAborted();
    const release = humanInput ? call.holdForHumanInput() : undefined;
    try {
      const result = await call.view.restore(run, call.view, signal);
      call.assertCurrent();
      signal.throwIfAborted();
      return result;
    } finally {
      release?.();
    }
  };
  if (params.context.capabilities.roots) {
    const roots = params.context.roots;
    client.setRequestHandler("roots/list", (_request, extra) => {
      // Roots belong to this capability context even when no operation is active.
      params.signal.throwIfAborted();
      assertOpen();
      extra.mcpReq.signal.throwIfAborted();
      return roots;
    });
  }
  if (params.context.capabilities.elicitation) {
    client.setRequestHandler("elicitation/create", (request, extra) =>
      callback(
        extra,
        async (view, signal) => {
          const result = await view.context.elicit!(request.params, { signal });
          view.assertCurrent();
          signal.throwIfAborted();
          if (request.params.mode === "url" && result.action === "accept") {
            urlElicitations.set(request.params.elicitationId, view);
          }
          return result;
        },
        true,
      ),
    );
  }
  if (params.context.capabilities.sampling) {
    client.setRequestHandler("sampling/createMessage", (request, extra) =>
      callback(extra, (view, signal) => view.context.createMessage!(request.params, { signal })),
    );
  }
  if (params.context.capabilities.extensions?.["openai/elicitation"]) {
    client.setRequestHandler(
      "openai/elicitation/create",
      { params: z.record(z.string(), z.unknown()) },
      (input, extra) =>
        callback(extra, (view, signal) => view.context.elicitCustom!(input, { signal }), true),
    );
  }
  const emit = (event: NativeMcpServerEvent, targets = views) => {
    if (event.kind === "closed") {
      if (closed) {
        return;
      }
      closed = true;
      urlElicitations.clear();
    }
    for (const view of targets) {
      try {
        // Retirement revokes authority first; its terminal fact still reaches borrowers.
        if (event.kind !== "closed") {
          view.assertCurrent();
        }
      } catch {
        continue;
      }
      for (const listener of view.listeners) {
        try {
          view.restore(listener, event);
        } catch {
          logWarn("bundle-mcp: projection listener failed");
        }
      }
    }
  };
  const notification = (value: ServerNotification) => {
    if (closed) {
      return;
    }
    if (value.method === "notifications/elicitation/complete") {
      // URL completion can arrive after the initiating request, or during another view's work.
      const owner = urlElicitations.get(value.params.elicitationId);
      urlElicitations.delete(value.params.elicitationId);
      if (owner) {
        emit({ kind: "notification", notification: value }, new Set([owner]));
      }
    } else if (value.method.endsWith("/list_changed")) {
      params.invalidateCatalog();
      emit({ kind: "notification", notification: value });
    } else if (active.size === 1) {
      emit({ kind: "notification", notification: value }, new Set([callbackOwner().view]));
    }
  };
  client.setNotificationHandler("notifications/tools/list_changed", notification);
  client.setNotificationHandler("notifications/resources/list_changed", notification);
  client.setNotificationHandler("notifications/prompts/list_changed", notification);
  client.setNotificationHandler("notifications/resources/updated", notification);
  client.setNotificationHandler("notifications/message", notification);
  client.setNotificationHandler("notifications/elicitation/complete", notification);

  function bind(context: NativeMcpClientContext) {
    const released = new AbortController();
    const pending = new Set<Promise<void>>();
    const viewSignal = AbortSignal.any([params.signal, released.signal]);
    const view: View = {
      context,
      signal: viewSignal,
      assertCurrent() {
        viewSignal.throwIfAborted();
        assertOpen();
        context.assertCurrent();
      },
      restore: AsyncLocalStorage.snapshot(),
      listeners: new Set(),
    };
    views.add(view);
    const run = async <T>(
      options: NativeMcpRequestOptions,
      request: (options: RequestOptions & { signal: AbortSignal }) => Promise<T>,
    ): Promise<T> => {
      const signal = AbortSignal.any([view.signal, options.signal]);
      const assertCurrent = () => {
        view.assertCurrent();
        signal.throwIfAborted();
        options.assertCurrent();
      };
      assertCurrent();
      const release = params.acquireLease();
      const settled = Promise.withResolvers<void>();
      pending.add(settled.promise);
      try {
        const result = await params.runRequest(
          signal,
          async (requestOptions, holdForHumanInput) => {
            const assertActive = () => {
              assertCurrent();
              requestOptions.signal.throwIfAborted();
            };
            assertActive();
            const call = {
              view,
              signal: requestOptions.signal,
              assertCurrent: assertActive,
              holdForHumanInput,
            };
            active.add(call);
            let retirement: Promise<void> | undefined;
            const onAbort = () => {
              if (client.getProtocolEra() === "legacy") {
                // Cancelled legacy work can still emit callbacks with no portable parent id.
                retirement ??= params.retire();
                void retirement.catch(() => undefined);
              }
            };
            requestOptions.signal.addEventListener("abort", onAbort, { once: true });
            try {
              return await view.restore(() =>
                withGuardedFetchRequestAuthority(assertActive, () =>
                  request({
                    ...requestOptions,
                    onprogress: options.onprogress
                      ? (progress) => {
                          assertActive();
                          view.restore(options.onprogress!, progress);
                        }
                      : undefined,
                  }),
                ),
              );
            } catch (error) {
              requestOptions.signal.throwIfAborted();
              throw error;
            } finally {
              requestOptions.signal.removeEventListener("abort", onAbort);
              try {
                if (retirement) {
                  await retirement;
                }
              } finally {
                active.delete(call);
              }
            }
          },
        );
        assertCurrent();
        return result;
      } finally {
        release();
        pending.delete(settled.promise);
        settled.resolve();
      }
    };
    const flow = async <T>(
      method: "tools/call" | "resources/read" | "prompts/get",
      input: Record<string, unknown>,
      schema: StandardSchemaV1<unknown, T>,
      options: NativeMcpRequestOptions,
      validateResult?: (result: T) => void,
    ): Promise<NativeMcpResponse<T>> => {
      const result = await run(options, (requestOptions) =>
        params.transportType === "stdio"
          ? client.request({ method, params: input }, withInputRequired(schema), {
              ...requestOptions,
              allowInputRequired: true,
            })
          : client.request({ method, params: input }, schema, requestOptions),
      );
      if (!isInputRequiredResult(result)) {
        validateResult?.(result);
        return { kind: "complete", result };
      }
      let resumed = false;
      return {
        kind: "input-required",
        result,
        resume(responses: InputResponses, nextOptions: NativeMcpRequestOptions) {
          view.assertCurrent();
          options.signal.throwIfAborted();
          options.assertCurrent();
          nextOptions.signal.throwIfAborted();
          nextOptions.assertCurrent();
          if (resumed) {
            throw new Error("MCP continuation was already resumed");
          }
          resumed = true;
          return flow(
            method,
            { ...input, requestState: result.requestState, inputResponses: responses },
            schema,
            {
              ...nextOptions,
              signal: AbortSignal.any([options.signal, nextOptions.signal]),
              assertCurrent() {
                options.assertCurrent();
                nextOptions.assertCurrent();
              },
            },
            validateResult,
          );
        },
      };
    };
    const protocol: Omit<NativeMcpServerView, "runtime" | "release"> = {
      getServerInfo: () => client.getServerVersion(),
      getCapabilities: () => client.getServerCapabilities(),
      getInstructions: () => client.getInstructions(),
      getProtocolEra: () => client.getProtocolEra(),
      getProtocolVersion: () => client.getNegotiatedProtocolVersion(),
      listTools: (input, options) =>
        run(options, (request) => client.request({ method: "tools/list", params: input }, request)),
      listResources: (input, options) =>
        run(options, (request) =>
          client.request({ method: "resources/list", params: input }, request),
        ),
      listResourceTemplates: (input, options) =>
        run(options, (request) =>
          client.request({ method: "resources/templates/list", params: input }, request),
        ),
      listPrompts: (input, options) =>
        run(options, (request) =>
          client.request({ method: "prompts/list", params: input }, request),
        ),
      complete: (input, options) =>
        run(options, (request) =>
          client.request({ method: "completion/complete", params: input }, request),
        ),
      callTool: async (input, options) => {
        if (params.transportType === "stdio") {
          // Keep dispatch-time catalog validation through every continuation.
          const validateResult = params.validatorForCall(input.name);
          return flow("tools/call", input, CallToolResultSchema, options, validateResult);
        }
        // The SDK lacks a manual-result callTool overload; HTTP retains its header mirroring.
        return {
          kind: "complete",
          result: await run(options, (request) => client.callTool(input, request)),
        };
      },
      readResource: (input, options) =>
        flow("resources/read", input, ReadResourceResultSchema, options),
      getPrompt: (input, options) => flow("prompts/get", input, GetPromptResultSchema, options),
      rootsChanged: (options) => run(options, () => client.sendRootsListChanged()),
      subscribe(listener) {
        view.assertCurrent();
        view.listeners.add(listener);
        return () => view.listeners.delete(listener);
      },
    };
    return {
      protocol,
      // Bind operation callbacks before initialization starts.
      initialize: <T>(runInitialize: () => Promise<T>) =>
        run({ signal: viewSignal, assertCurrent: view.assertCurrent }, runInitialize),
      async detach() {
        released.abort(new Error("MCP projection view released"));
        await Promise.all(pending);
        views.delete(view);
        view.listeners.clear();
        for (const [id, owner] of urlElicitations) {
          if (owner === view) {
            urlElicitations.delete(id);
          }
        }
      },
    };
  }
  return {
    bind,
    emit,
    async listenForCatalogChanges(timeout: number) {
      const capabilities = client.getServerCapabilities();
      const filter = {
        ...(capabilities?.tools?.listChanged ? { toolsListChanged: true } : {}),
        ...(capabilities?.resources?.listChanged ? { resourcesListChanged: true } : {}),
        ...(capabilities?.prompts?.listChanged ? { promptsListChanged: true } : {}),
      };
      if (Object.keys(filter).length > 0) {
        return client.listen(filter, { signal: params.signal, timeout });
      }
      return undefined;
    },
  };
}
