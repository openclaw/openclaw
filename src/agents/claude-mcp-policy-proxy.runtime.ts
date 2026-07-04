/**
 * Stdio MCP proxy used by Claude CLI to enforce OpenClaw's effective tool policy.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  ElicitRequestSchema,
  GetPromptRequestSchema,
  InitializeRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  PromptListChangedNotificationSchema,
  ReadResourceRequestSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  SubscribeRequestSchema,
  ToolListChangedNotificationSchema,
  UnsubscribeRequestSchema,
  type ClientCapabilities,
  type JSONRPCMessage,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { buildSafeToolName, normalizeReservedToolNames } from "./agent-bundle-mcp-names.js";
import {
  isClaudeMcpProxyToolAllowed,
  isClaudeMcpProxyToolIncluded,
  type ClaudeMcpProxyServerPolicy,
} from "./cli-runner/claude-live-tool-policy.js";
import {
  CLAUDE_MCP_POLICY_RELAY_TIMEOUT_MS,
  connectClaudeMcpProxyClient,
  resolveClaudeMcpProxyTransport,
} from "./cli-runner/claude-mcp-policy-proxy.js";
import { sanitizeMcpMetadataText } from "./mcp-metadata.js";

type ClaudeMcpPolicyProxyConfig = {
  upstream: Record<string, unknown>;
  policy: ClaudeMcpProxyServerPolicy;
  relay: {
    provider: "claude";
    relayId: string;
    generation: string;
  };
};
type UtilityOperation = "resources_list" | "resources_read" | "prompts_list" | "prompts_get";
type ClaudeMcpRelayDecision =
  | { decision: "allow"; updatedInput?: Record<string, unknown> }
  | { decision: "deny"; reason: string };

class BufferedStdioServerTransport implements Transport {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];

  private readonly inner = new StdioServerTransport();
  private readonly pendingMessages: JSONRPCMessage[] = [];
  private readonly firstMessage: Promise<JSONRPCMessage>;
  private resolveFirstMessage!: (message: JSONRPCMessage) => void;
  private rejectFirstMessage!: (error: Error) => void;
  private forwarding = false;
  private closed = false;

  constructor() {
    this.firstMessage = new Promise<JSONRPCMessage>((resolve, reject) => {
      this.resolveFirstMessage = resolve;
      this.rejectFirstMessage = reject;
    });
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport is not an EventTarget.
    this.inner.onmessage = (message) => {
      if (this.forwarding) {
        this.onmessage?.(message);
        return;
      }
      if (this.pendingMessages.length === 0) {
        this.resolveFirstMessage(message);
      }
      this.pendingMessages.push(message);
    };
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport is not an EventTarget.
    this.inner.onerror = (error) => {
      if (this.pendingMessages.length === 0) {
        this.rejectFirstMessage(error);
      }
      this.onerror?.(error);
    };
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport is not an EventTarget.
    this.inner.onclose = () => {
      if (this.pendingMessages.length === 0) {
        this.rejectFirstMessage(
          new Error("Claude MCP policy proxy stdin closed before initialize"),
        );
      }
      this.onclose?.();
    };
  }

  async captureClientCapabilities(): Promise<ClientCapabilities> {
    await this.inner.start();
    const initialize = InitializeRequestSchema.parse(await this.firstMessage);
    return initialize.params.capabilities;
  }

  async start(): Promise<void> {
    this.forwarding = true;
    for (const message of this.pendingMessages.splice(0)) {
      this.onmessage?.(message);
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    await this.inner.send(message);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.inner.close();
  }
}

function bridgeableClientCapabilities(
  capabilities: ClientCapabilities,
  policy: ClaudeMcpProxyServerPolicy,
): ClientCapabilities {
  const isComputerUse = normalizeLowercaseStringOrEmpty(policy.configuredName) === "computer-use";
  return isComputerUse && capabilities.elicitation ? { elicitation: capabilities.elicitation } : {};
}

async function readProxyConfig(filePath: string): Promise<ClaudeMcpPolicyProxyConfig> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf-8")) as unknown;
  if (
    !isRecord(parsed) ||
    !isRecord(parsed.upstream) ||
    !isRecord(parsed.policy) ||
    !isRecord(parsed.relay) ||
    parsed.relay.provider !== "claude" ||
    typeof parsed.relay.relayId !== "string" ||
    typeof parsed.relay.generation !== "string"
  ) {
    throw new Error("Claude MCP policy proxy requires a valid policy config");
  }
  return parsed as ClaudeMcpPolicyProxyConfig;
}

function parseRelayDecision(stdout: string): ClaudeMcpRelayDecision {
  const parsed = JSON.parse(stdout) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("OpenClaw hook relay returned a non-object decision");
  }
  if (parsed.decision === "deny" && typeof parsed.reason === "string") {
    return { decision: "deny", reason: parsed.reason };
  }
  if (parsed.decision !== "allow") {
    throw new Error("OpenClaw hook relay returned an invalid decision");
  }
  if (parsed.updatedInput !== undefined && !isRecord(parsed.updatedInput)) {
    throw new Error("OpenClaw hook relay returned invalid updated tool input");
  }
  return {
    decision: "allow",
    ...(parsed.updatedInput ? { updatedInput: parsed.updatedInput } : {}),
  };
}

async function authorizeToolCall(params: {
  config: ClaudeMcpPolicyProxyConfig;
  canonicalToolName: string;
  toolUseId: string;
  toolInput: Record<string, unknown>;
  timeoutMs: number;
}): Promise<ClaudeMcpRelayDecision> {
  const { invokeNativeHookRelayBridge } = await import("./harness/native-hook-relay.js");
  const response = await invokeNativeHookRelayBridge({
    ...params.config.relay,
    event: "pre_tool_use",
    timeoutMs: params.timeoutMs,
    rawPayload: {
      hook_event_name: "PreToolUse",
      tool_name: params.canonicalToolName,
      tool_use_id: params.toolUseId,
      tool_input: params.toolInput,
    },
  });
  if (response.exitCode !== 0) {
    throw new Error(response.stderr.trim() || "OpenClaw hook relay rejected the tool call");
  }
  return parseRelayDecision(response.stdout);
}

function toRelayJsonValue(value: unknown): import("./harness/native-hook-relay.js").JsonValue {
  if (value === undefined) {
    return null;
  }
  return structuredClone(value) as import("./harness/native-hook-relay.js").JsonValue;
}

function formatRelayError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return JSON.stringify(error) || "Unknown MCP operation error";
}

async function relayToolOutcome(params: {
  config: ClaudeMcpPolicyProxyConfig;
  canonicalToolName: string;
  toolUseId: string;
  toolInput: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}): Promise<void> {
  try {
    const { invokeNativeHookRelayBridge } = await import("./harness/native-hook-relay.js");
    await invokeNativeHookRelayBridge({
      ...params.config.relay,
      event: "post_tool_use",
      registrationTimeoutMs: 250,
      timeoutMs: 30_000,
      rawPayload: {
        hook_event_name: "PostToolUse",
        tool_name: params.canonicalToolName,
        tool_use_id: params.toolUseId,
        tool_input: params.toolInput,
        ...(params.error !== undefined
          ? { tool_error: formatRelayError(params.error) }
          : { tool_response: toRelayJsonValue(params.result) }),
      },
    });
  } catch (error) {
    process.stderr.write(
      `OpenClaw post-tool relay failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

async function listIncludedToolNames(params: {
  client: Client;
  policy: ClaudeMcpProxyServerPolicy;
  timeout: number;
}): Promise<Array<{ rawName: string; toolName: string }>> {
  const names: Array<{ rawName: string; toolName: string }> = [];
  let cursor: string | undefined;
  do {
    const listed = await params.client.listTools(cursor ? { cursor } : undefined, {
      timeout: params.timeout,
    });
    names.push(
      ...listed.tools
        .map((tool) => ({ rawName: tool.name, toolName: tool.name.trim() }))
        .filter(({ toolName }) => isClaudeMcpProxyToolIncluded(params.policy, toolName)),
    );
    cursor = listed.nextCursor;
  } while (cursor);

  return names.toSorted((left, right) => left.toolName.localeCompare(right.toolName));
}

function appendSafeToolNames(params: {
  names: Array<{ rawName: string; toolName: string }>;
  policy: ClaudeMcpProxyServerPolicy;
  reservedNames: Set<string>;
  safeToolNames: Map<string, string>;
}): void {
  for (const { rawName, toolName } of params.names) {
    if (params.safeToolNames.has(rawName)) {
      continue;
    }
    const safeToolName = buildSafeToolName({
      serverName: params.policy.safeName,
      toolName,
      reservedNames: params.reservedNames,
    });
    params.reservedNames.add(normalizeLowercaseStringOrEmpty(safeToolName));
    params.safeToolNames.set(rawName, safeToolName);
  }
}

async function refreshSafeToolNames(params: {
  client: Client;
  policy: ClaudeMcpProxyServerPolicy;
  timeout: number;
  reservedNames: Set<string>;
  safeToolNames: Map<string, string>;
}): Promise<void> {
  appendSafeToolNames({
    names: await listIncludedToolNames(params),
    policy: params.policy,
    reservedNames: params.reservedNames,
    safeToolNames: params.safeToolNames,
  });
}

function listIncludedUtilityOperations(
  policy: ClaudeMcpProxyServerPolicy,
  capabilities: ServerCapabilities | undefined,
): UtilityOperation[] {
  return [
    ...(capabilities?.resources
      ? (["resources_list", "resources_read"] satisfies UtilityOperation[])
      : []),
    ...(capabilities?.prompts
      ? (["prompts_list", "prompts_get"] satisfies UtilityOperation[])
      : []),
  ].filter((operation) => isClaudeMcpProxyToolIncluded(policy, operation));
}

function buildUtilitySafeToolNames(
  policy: ClaudeMcpProxyServerPolicy,
  reservedNames: Set<string>,
  operations: readonly UtilityOperation[],
): Map<UtilityOperation, string> {
  return new Map(
    operations.map((operation) => {
      const safeToolName = buildSafeToolName({
        serverName: policy.safeName,
        toolName: operation,
        reservedNames,
      });
      reservedNames.add(normalizeLowercaseStringOrEmpty(safeToolName));
      return [operation, safeToolName];
    }),
  );
}

function proxyCapabilities(
  upstream: ServerCapabilities | undefined,
  allowed: {
    prompts: boolean;
    promptsList: boolean;
    resources: boolean;
    resourcesList: boolean;
    resourcesRead: boolean;
    completions: boolean;
  },
): ServerCapabilities {
  const tools = upstream?.tools;
  const prompts =
    upstream?.prompts && allowed.prompts
      ? Object.fromEntries(
          Object.entries(upstream.prompts).filter(
            ([name]) => name !== "listChanged" || allowed.promptsList,
          ),
        )
      : undefined;
  const resources =
    upstream?.resources && allowed.resources
      ? Object.fromEntries(
          Object.entries(upstream.resources).filter(
            ([name]) =>
              (name !== "listChanged" || allowed.resourcesList) &&
              (name !== "subscribe" || allowed.resourcesRead),
          ),
        )
      : undefined;
  return {
    ...(tools ? { tools } : {}),
    ...(prompts ? { prompts } : {}),
    ...(resources ? { resources } : {}),
    ...(upstream?.completions && allowed.completions ? { completions: upstream.completions } : {}),
  };
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) {
    throw new Error("Claude MCP policy proxy requires a policy config path");
  }
  const config = await readProxyConfig(configPath);
  const upstream = resolveClaudeMcpProxyTransport(config.policy.configuredName, config.upstream);
  if (!upstream) {
    throw new Error(
      `Claude MCP policy proxy could not resolve server ${config.policy.configuredName}`,
    );
  }
  const downstreamTransport = new BufferedStdioServerTransport();
  const clientCapabilities = bridgeableClientCapabilities(
    await downstreamTransport.captureClientCapabilities().catch(async (error: unknown) => {
      await downstreamTransport.close();
      throw error;
    }),
    config.policy,
  );
  const client = new Client(
    { name: "openclaw-claude-mcp-policy-proxy-client", version: "0.0.0" },
    { capabilities: clientCapabilities },
  );
  let server: Server | undefined;
  let downstreamConnected = false;
  let activeAuthorizedToolCalls = 0;
  let sequentialToolCallTail: Promise<void> = Promise.resolve();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let resolveDownstreamReady: ((server: Server) => void) | undefined;
  const downstreamReady = new Promise<Server>((resolve) => {
    resolveDownstreamReady = resolve;
  });
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      closing = true;
      upstream.detachStderr?.();
      await Promise.allSettled([
        client.close(),
        server ? server.close() : downstreamTransport.close(),
      ]);
    })();
    return closePromise;
  };
  // The SDK exposes lifecycle hooks as callback properties. An upstream close
  // is terminal for this proxy so Claude can observe EOF and restart the server.
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Client is not an EventTarget.
  client.onclose = () => {
    if (closing) {
      return;
    }
    process.exitCode = 1;
    void close();
  };
  const withAuthorizedToolCall = async <T>(run: () => Promise<T>): Promise<T> => {
    activeAuthorizedToolCalls += 1;
    try {
      return await run();
    } finally {
      activeAuthorizedToolCalls -= 1;
    }
  };
  const scheduleToolCall = <T>(run: () => Promise<T>): Promise<T> => {
    if (upstream.supportsParallelToolCalls) {
      return run();
    }
    const result = sequentialToolCallTail.then(run);
    sequentialToolCallTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  try {
    if (clientCapabilities.elicitation) {
      client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
        if (activeAuthorizedToolCalls === 0) {
          throw new Error("OpenClaw tool policy denied unsolicited MCP elicitation.");
        }
        const downstream = await downstreamReady;
        return await downstream.elicitInput(request.params, {
          timeout: upstream.requestTimeoutMs,
          signal: extra.signal,
        });
      });
    }
    await connectClaudeMcpProxyClient(client, upstream.transport, upstream.connectionTimeoutMs);

    const capabilities = client.getServerCapabilities();
    const requestOptions = (signal: AbortSignal) => ({
      timeout: upstream.requestTimeoutMs,
      signal,
    });
    const authorizeInput = async (params: {
      canonicalToolName: string;
      input: Record<string, unknown>;
      signal: AbortSignal;
    }): Promise<{ input: Record<string, unknown>; toolUseId: string }> => {
      const toolUseId = randomUUID();
      const decision = await authorizeToolCall({
        config,
        canonicalToolName: params.canonicalToolName,
        toolUseId,
        toolInput: params.input,
        timeoutMs: CLAUDE_MCP_POLICY_RELAY_TIMEOUT_MS,
      });
      if (decision.decision === "deny") {
        throw new Error(decision.reason);
      }
      if (params.signal.aborted) {
        throw new Error("Claude MCP operation cancelled before upstream execution.");
      }
      return {
        input: decision.updatedInput ?? params.input,
        toolUseId,
      };
    };
    const runObservedOperation = async <T>(params: {
      canonicalToolName: string;
      toolUseId: string;
      input: Record<string, unknown>;
      run: () => Promise<T>;
    }): Promise<T> => {
      try {
        const result = await params.run();
        await relayToolOutcome({
          config,
          canonicalToolName: params.canonicalToolName,
          toolUseId: params.toolUseId,
          toolInput: params.input,
          result,
        });
        return result;
      } catch (error) {
        await relayToolOutcome({
          config,
          canonicalToolName: params.canonicalToolName,
          toolUseId: params.toolUseId,
          toolInput: params.input,
          error,
        });
        throw error;
      }
    };
    // Tool aliases are append-only for the proxy lifetime. Dynamic catalogs can
    // add tools, but removal/readdition cannot rebind an existing policy name.
    const reservedToolNames = normalizeReservedToolNames(config.policy.reservedToolNames);
    const safeToolNames = new Map<string, string>();
    const includedUtilityOperations = listIncludedUtilityOperations(config.policy, capabilities);
    const utilityIncluded = (operation: UtilityOperation): boolean =>
      includedUtilityOperations.includes(operation);
    let utilitySafeToolNames = new Map<UtilityOperation, string>();
    let policyAliasesReady: Promise<void> | undefined;
    const ensurePolicyAliases = (): Promise<void> => {
      policyAliasesReady ??= (async () => {
        if (capabilities?.tools) {
          await refreshSafeToolNames({
            client,
            policy: config.policy,
            timeout: upstream.requestTimeoutMs,
            reservedNames: reservedToolNames,
            safeToolNames,
          });
        }
        utilitySafeToolNames = buildUtilitySafeToolNames(
          config.policy,
          reservedToolNames,
          includedUtilityOperations,
        );
      })().catch((error: unknown) => {
        policyAliasesReady = undefined;
        throw error;
      });
      return policyAliasesReady;
    };
    const utilityAllowed = (operation: UtilityOperation): boolean => {
      const safeToolName = utilitySafeToolNames.get(operation);
      return (
        safeToolName !== undefined &&
        isClaudeMcpProxyToolAllowed(config.policy, operation, safeToolName)
      );
    };
    const requireUtilitySafeToolName = (operation: UtilityOperation): string => {
      const safeToolName = utilitySafeToolNames.get(operation);
      if (
        safeToolName === undefined ||
        !isClaudeMcpProxyToolAllowed(config.policy, operation, safeToolName)
      ) {
        throw new Error(`OpenClaw tool policy denied ${operation}.`);
      }
      return safeToolName;
    };
    const promptsListIncluded = utilityIncluded("prompts_list");
    const promptsGetIncluded = utilityIncluded("prompts_get");
    const resourcesListIncluded = utilityIncluded("resources_list");
    const resourcesReadIncluded = utilityIncluded("resources_read");
    const completionsIncluded = promptsGetIncluded || resourcesReadIncluded;
    server = new Server(
      { name: "openclaw-claude-mcp-policy-proxy", version: "0.0.0" },
      {
        capabilities: proxyCapabilities(capabilities, {
          prompts: promptsListIncluded || promptsGetIncluded,
          promptsList: promptsListIncluded,
          resources: resourcesListIncluded || resourcesReadIncluded,
          resourcesList: resourcesListIncluded,
          resourcesRead: resourcesReadIncluded,
          completions: completionsIncluded,
        }),
      },
    );
    server.oninitialized = () => {
      resolveDownstreamReady?.(server!);
      resolveDownstreamReady = undefined;
    };
    if (capabilities?.tools) {
      server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
        // Full paginated discovery can exceed Claude's MCP initialize deadline.
        // Resolve the policy snapshot lazily on the first catalog request.
        await ensurePolicyAliases();
        const listed = await client.listTools(request.params, requestOptions(extra.signal));
        appendSafeToolNames({
          names: listed.tools
            .map((tool) => ({ rawName: tool.name, toolName: tool.name.trim() }))
            .filter(({ toolName }) => isClaudeMcpProxyToolIncluded(config.policy, toolName))
            .toSorted((left, right) => left.toolName.localeCompare(right.toolName)),
          policy: config.policy,
          reservedNames: reservedToolNames,
          safeToolNames,
        });
        return {
          ...listed,
          tools: listed.tools
            .filter((tool) => {
              const safeToolName = safeToolNames.get(tool.name);
              return (
                safeToolName !== undefined &&
                isClaudeMcpProxyToolAllowed(config.policy, tool.name, safeToolName)
              );
            })
            .map((tool) =>
              Object.assign({}, tool, {
                description: sanitizeMcpMetadataText(tool.description),
              }),
            ),
        };
      });
      server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        await ensurePolicyAliases();
        const safeToolName = safeToolNames.get(request.params.name);
        if (
          safeToolName === undefined ||
          !isClaudeMcpProxyToolAllowed(config.policy, request.params.name, safeToolName)
        ) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `OpenClaw tool policy denied ${request.params.name}.`,
              },
            ],
          };
        }
        let authorized: Awaited<ReturnType<typeof authorizeInput>>;
        try {
          authorized = await authorizeInput({
            canonicalToolName: safeToolName,
            input: request.params.arguments ?? {},
            signal: extra.signal,
          });
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `OpenClaw tool policy relay failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
        const callParams = {
          ...request.params,
          arguments: authorized.input,
        };
        return await runObservedOperation({
          canonicalToolName: safeToolName,
          toolUseId: authorized.toolUseId,
          input: authorized.input,
          run: async () =>
            await scheduleToolCall(
              async () =>
                await withAuthorizedToolCall(
                  async () =>
                    await client.callTool(callParams, undefined, requestOptions(extra.signal)),
                ),
            ),
        });
      });
      if (capabilities.tools.listChanged) {
        client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
          await refreshSafeToolNames({
            client,
            policy: config.policy,
            timeout: upstream.requestTimeoutMs,
            reservedNames: reservedToolNames,
            safeToolNames,
          });
          if (downstreamConnected) {
            await server?.sendToolListChanged();
          }
        });
      }
    }

    if (capabilities?.prompts && (promptsListIncluded || promptsGetIncluded)) {
      server.setRequestHandler(ListPromptsRequestSchema, async (request, extra) => {
        await ensurePolicyAliases();
        const canonicalToolName = requireUtilitySafeToolName("prompts_list");
        const authorizedInput = await authorizeInput({
          canonicalToolName,
          input: { ...request.params },
          signal: extra.signal,
        });
        const authorized = ListPromptsRequestSchema.parse({
          ...request,
          params: authorizedInput.input,
        });
        return await runObservedOperation({
          canonicalToolName,
          toolUseId: authorizedInput.toolUseId,
          input: authorizedInput.input,
          run: async () =>
            await client.listPrompts(authorized.params, requestOptions(extra.signal)),
        });
      });
      server.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
        await ensurePolicyAliases();
        const canonicalToolName = requireUtilitySafeToolName("prompts_get");
        const authorizedInput = await authorizeInput({
          canonicalToolName,
          input: { ...request.params },
          signal: extra.signal,
        });
        const authorized = GetPromptRequestSchema.parse({
          ...request,
          params: authorizedInput.input,
        });
        return await runObservedOperation({
          canonicalToolName,
          toolUseId: authorizedInput.toolUseId,
          input: authorizedInput.input,
          run: async () => await client.getPrompt(authorized.params, requestOptions(extra.signal)),
        });
      });
      if (capabilities.prompts.listChanged && promptsListIncluded) {
        client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
          await ensurePolicyAliases();
          if (downstreamConnected && utilityAllowed("prompts_list")) {
            await server?.sendPromptListChanged();
          }
        });
      }
    }

    if (capabilities?.resources && (resourcesListIncluded || resourcesReadIncluded)) {
      server.setRequestHandler(ListResourcesRequestSchema, async (request, extra) => {
        await ensurePolicyAliases();
        const canonicalToolName = requireUtilitySafeToolName("resources_list");
        const authorizedInput = await authorizeInput({
          canonicalToolName,
          input: { ...request.params },
          signal: extra.signal,
        });
        const authorized = ListResourcesRequestSchema.parse({
          ...request,
          params: authorizedInput.input,
        });
        return await runObservedOperation({
          canonicalToolName,
          toolUseId: authorizedInput.toolUseId,
          input: authorizedInput.input,
          run: async () =>
            await client.listResources(authorized.params, requestOptions(extra.signal)),
        });
      });
      server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request, extra) => {
        await ensurePolicyAliases();
        const canonicalToolName = requireUtilitySafeToolName("resources_list");
        const authorizedInput = await authorizeInput({
          canonicalToolName,
          input: { ...request.params },
          signal: extra.signal,
        });
        const authorized = ListResourceTemplatesRequestSchema.parse({
          ...request,
          params: authorizedInput.input,
        });
        return await runObservedOperation({
          canonicalToolName,
          toolUseId: authorizedInput.toolUseId,
          input: authorizedInput.input,
          run: async () =>
            await client.listResourceTemplates(authorized.params, requestOptions(extra.signal)),
        });
      });
      server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
        await ensurePolicyAliases();
        const canonicalToolName = requireUtilitySafeToolName("resources_read");
        const authorizedInput = await authorizeInput({
          canonicalToolName,
          input: { ...request.params },
          signal: extra.signal,
        });
        const authorized = ReadResourceRequestSchema.parse({
          ...request,
          params: authorizedInput.input,
        });
        return await runObservedOperation({
          canonicalToolName,
          toolUseId: authorizedInput.toolUseId,
          input: authorizedInput.input,
          run: async () =>
            await client.readResource(authorized.params, requestOptions(extra.signal)),
        });
      });
      if (capabilities.resources.subscribe && resourcesReadIncluded) {
        server.setRequestHandler(SubscribeRequestSchema, async (request, extra) => {
          await ensurePolicyAliases();
          const canonicalToolName = requireUtilitySafeToolName("resources_read");
          const authorizedInput = await authorizeInput({
            canonicalToolName,
            input: { ...request.params },
            signal: extra.signal,
          });
          const authorized = SubscribeRequestSchema.parse({
            ...request,
            params: authorizedInput.input,
          });
          return await runObservedOperation({
            canonicalToolName,
            toolUseId: authorizedInput.toolUseId,
            input: authorizedInput.input,
            run: async () =>
              await client.subscribeResource(authorized.params, requestOptions(extra.signal)),
          });
        });
        server.setRequestHandler(UnsubscribeRequestSchema, async (request, extra) => {
          await ensurePolicyAliases();
          const canonicalToolName = requireUtilitySafeToolName("resources_read");
          const authorizedInput = await authorizeInput({
            canonicalToolName,
            input: { ...request.params },
            signal: extra.signal,
          });
          const authorized = UnsubscribeRequestSchema.parse({
            ...request,
            params: authorizedInput.input,
          });
          return await runObservedOperation({
            canonicalToolName,
            toolUseId: authorizedInput.toolUseId,
            input: authorizedInput.input,
            run: async () =>
              await client.unsubscribeResource(authorized.params, requestOptions(extra.signal)),
          });
        });
        client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notification) => {
          await ensurePolicyAliases();
          if (downstreamConnected && utilityAllowed("resources_read")) {
            await server?.notification(notification);
          }
        });
      }
      if (capabilities.resources.listChanged && resourcesListIncluded) {
        client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
          await ensurePolicyAliases();
          if (downstreamConnected && utilityAllowed("resources_list")) {
            await server?.sendResourceListChanged();
          }
        });
      }
    }

    if (capabilities?.completions && completionsIncluded) {
      server.setRequestHandler(CompleteRequestSchema, async (request, extra) => {
        await ensurePolicyAliases();
        const operation =
          request.params.ref.type === "ref/prompt" ? "prompts_get" : "resources_read";
        const canonicalToolName = requireUtilitySafeToolName(operation);
        const authorizedInput = await authorizeInput({
          canonicalToolName,
          input: { ...request.params },
          signal: extra.signal,
        });
        const authorized = CompleteRequestSchema.parse({
          ...request,
          params: authorizedInput.input,
        });
        return await runObservedOperation({
          canonicalToolName,
          toolUseId: authorizedInput.toolUseId,
          input: authorizedInput.input,
          run: async () => await client.complete(authorized.params, requestOptions(extra.signal)),
        });
      });
    }

    process.once("SIGINT", () => void close());
    process.once("SIGTERM", () => void close());
    process.stdin.once("end", () => void close());
    process.stdin.once("close", () => void close());
    await server.connect(downstreamTransport);
    downstreamConnected = true;
  } catch (error) {
    await close();
    throw error;
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
