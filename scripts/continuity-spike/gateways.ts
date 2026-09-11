import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  GatewayClient,
  startGatewayClientWhenEventLoopReady,
} from "openclaw/plugin-sdk/gateway-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createQaLiveLaneGateway } from "../../extensions/qa-lab/gateway-runtime-api.js";

export const SPIKE_GATEWAY_NAMES = ["home", "company", "family"] as const;
export type SpikeGatewayName = (typeof SPIKE_GATEWAY_NAMES)[number];

const PRIMARY_MODEL = "mock-openai/gpt-4.1";
const UTILITY_MODEL = "mock-openai/gpt-4.1-mini";
const MAX_DEBUG_BYTES = 16 * 1024 * 1024;
const MAX_REQUESTS = 2_000;
const MAX_CONTEXT_CHARS = 256 * 1024;

type GatewayOwner = ReturnType<typeof createQaLiveLaneGateway>;
type GatewayLane = Awaited<ReturnType<GatewayOwner["start"]>>;
type RpcOptions = { timeoutMs?: number };

export type SpikeProviderRequest = {
  cursor: number;
  model: string;
  prompt: string;
  allInputText: string;
  toolOutput: string;
  requestKind: string;
  outcome: string;
  rawByteLength: number;
  plannedToolName: string | null;
  plannedToolArgs: Record<string, unknown> | null;
};

export type SpikeChatTicket = Readonly<{
  name: SpikeGatewayName;
  sessionKey: string;
  runId: string;
}>;

export type SpikeChatResult = {
  ticket: SpikeChatTicket;
  terminal: Record<string, unknown>;
  history: Record<string, unknown>;
  requests: SpikeProviderRequest[];
  metrics: {
    mock: true;
    provider: "mock-openai";
    requestScope: "gateway-window";
    physicalProviderRequests: number;
    requestBytes: number;
    elapsedMs: number;
    tokens: null;
    costUsd: null;
  };
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireString(value: unknown, label: string, maxLength = MAX_CONTEXT_CHARS): string {
  if (typeof value !== "string" || value.length > maxLength) {
    throw new Error(`${label} must be a bounded string`);
  }
  return value;
}

function requireCounter(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
  return value;
}

// Debug URLs originate only from the task-owned loopback provider. Do not return
// Gateway handles, config, auth, or runtime environment in the public harness API.
async function readMockJson(baseUrl: string, endpoint: string): Promise<unknown> {
  const url = new URL(endpoint, baseUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("spike provider must be a task-owned loopback HTTP server");
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`mock provider evidence request failed (${response.status})`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      byteLength += next.value.byteLength;
      if (byteLength > MAX_DEBUG_BYTES) {
        await reader.cancel();
        throw new Error("mock provider evidence exceeds the capture bound");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function projectRequest(value: unknown): SpikeProviderRequest {
  const request = requireRecord(value, "mock request");
  return {
    cursor: requireCounter(request.cursor, "request cursor"),
    model: requireString(request.model, "request model", 200),
    prompt: requireString(request.prompt, "request prompt"),
    allInputText: requireString(request.allInputText, "request context"),
    toolOutput: requireString(request.toolOutput, "request tool output"),
    requestKind: requireString(request.requestKind, "request kind", 100),
    outcome: requireString(request.outcome, "request outcome", 100),
    rawByteLength: requireCounter(request.rawByteLength, "request bytes"),
    plannedToolName:
      request.plannedToolName === undefined
        ? null
        : requireString(request.plannedToolName, "planned tool", 200),
    plannedToolArgs:
      request.plannedToolArgs === undefined
        ? null
        : requireRecord(request.plannedToolArgs, "planned arguments"),
  };
}

/** Real isolated OpenClaw Gateways; only the model provider is deterministic. */
export async function startSpikeNetwork(repoRoot: string) {
  const owners: GatewayOwner[] = [];
  const lanes = new Map<SpikeGatewayName, GatewayLane>();
  const readOnlyClients = new Set<GatewayClient>();
  const tickets = new WeakMap<
    SpikeChatTicket,
    { startedAt: number; cursor: number; completion?: Promise<SpikeChatResult> }
  >();
  let closed = false;
  let stopping: Promise<void> | undefined;

  const stop = (): Promise<void> => {
    closed = true;
    stopping ??= (async () => {
      const clientResults = await Promise.allSettled(
        [...readOnlyClients].map((client) => client.stopAndWait()),
      );
      // Every owner is registered before startup. One failed cleanup must not
      // prevent the other Gateway processes and mock servers from being joined.
      const results = await Promise.allSettled(owners.map((owner) => owner.stop()));
      const errors = results.flatMap((result) => {
        if (result.status === "rejected") {
          return [result.reason];
        }
        return result.value.process === "unconfirmed"
          ? result.value.errors.concat(new Error("owned Gateway shutdown was not confirmed"))
          : result.value.errors;
      });
      for (const result of clientResults) {
        if (result.status === "rejected") {
          errors.push(result.reason);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "spike Gateway cleanup incomplete");
      }
    })().catch((error: unknown) => {
      // Failed cleanup retains ownership; a caller may explicitly retry stop.
      stopping = undefined;
      throw error;
    });
    return stopping;
  };

  const laneFor = (name: SpikeGatewayName): GatewayLane => {
    const lane = lanes.get(name);
    if (closed || !lane) {
      throw new Error("spike Gateway is not available");
    }
    return lane;
  };
  const mockUrl = (name: SpikeGatewayName): string => {
    const mock = laneFor(name).mock;
    if (!mock) {
      throw new Error("spike requires the managed mock provider");
    }
    return mock.baseUrl;
  };
  const call = (name: SpikeGatewayName, method: string, params?: unknown, opts?: RpcOptions) =>
    laneFor(name).gateway.call(method, params, opts);
  // Use the public client against the same owned Gateway with an explicitly
  // restricted handshake. Never expose the Gateway credential or hello payload.
  const withReadOnlyClient = async <T>(
    name: SpikeGatewayName,
    use: (connection: {
      grantedScopes: readonly string[];
      request: (method: string, params?: unknown) => Promise<unknown>;
    }) => Promise<T>,
  ): Promise<T> => {
    const gateway = laneFor(name).gateway;
    const hello = createDeferred<readonly string[]>();
    void hello.promise.catch(() => {});
    const client = new GatewayClient({
      url: gateway.wsUrl,
      token: gateway.token,
      clientName: "gateway-client",
      mode: "backend",
      role: "operator",
      deviceIdentity: null,
      sharedStateMode: "read-only",
      scopes: ["operator.read"],
      requestTimeoutMs: 20_000,
      onHelloOk: (value) => hello.resolve([...value.auth.scopes]),
      onConnectError: () => hello.reject(new Error("read-only QA client handshake failed")),
    });
    readOnlyClients.add(client);
    const timer = setTimeout(
      () => hello.reject(new Error("read-only QA client handshake timed out")),
      20_000,
    );
    try {
      const readiness = await startGatewayClientWhenEventLoopReady(client, { timeoutMs: 20_000 });
      if (!readiness.ready) {
        throw new Error("read-only QA client event loop readiness timed out");
      }
      const grantedScopes = await hello.promise;
      clearTimeout(timer);
      if (closed) {
        throw new Error("spike network stopped during client startup");
      }
      return await use({
        grantedScopes,
        request: (method, params) => client.request(method, params ?? {}),
      });
    } finally {
      clearTimeout(timer);
      await client.stopAndWait();
      readOnlyClients.delete(client);
    }
  };
  const requestCursor = async (name: SpikeGatewayName): Promise<number> => {
    const result = requireRecord(
      await readMockJson(mockUrl(name), "/debug/request-cursor"),
      "request cursor response",
    );
    return requireCounter(result.cursor, "request cursor");
  };
  const requests = async (
    name: SpikeGatewayName,
    opts: { after?: number } = {},
  ): Promise<SpikeProviderRequest[]> => {
    const after = requireCounter(opts.after ?? 0, "request cursor");
    const result = await readMockJson(mockUrl(name), `/debug/requests?after=${after}`);
    if (!Array.isArray(result) || result.length > MAX_REQUESTS) {
      throw new Error("mock provider evidence must be a bounded array");
    }
    // A cursor expiration or oversized capture fails; never silently drop
    // context and then claim that a privacy sentinel was absent.
    return result.map(projectRequest);
  };

  try {
    // Startup is serialized because native bootstrap may stage/build shared
    // source artifacts. Each lane still has distinct process, state, and port.
    for (const name of SPIKE_GATEWAY_NAMES) {
      const owner = createQaLiveLaneGateway();
      owners.push(owner);
      lanes.set(
        name,
        await owner.start({
          repoRoot,
          providerMode: "mock-openai",
          primaryModel: PRIMARY_MODEL,
          alternateModel: UTILITY_MODEL,
          forcedRuntime: "openclaw",
          thinkingDefault: "off",
          controlUiEnabled: false,
          transportBaseUrl: "http://127.0.0.1",
          transport: {
            requiredPluginIds: ["continuity-spike"],
            createGatewayConfig: () => ({}),
          },
          mutateConfig: (cfg) => {
            const provider = cfg.models?.providers?.["mock-openai"];
            const qa = cfg.agents?.entries?.qa;
            if (!provider || !qa) {
              throw new Error("canonical QA mock provider or agent missing");
            }
            return {
              ...cfg,
              plugins: {
                ...cfg.plugins,
                entries: {
                  ...cfg.plugins?.entries,
                  "continuity-spike": {
                    ...cfg.plugins?.entries?.["continuity-spike"],
                    enabled: true,
                    hooks: { allowConversationAccess: true, allowPromptInjection: true },
                  },
                },
              },
              tools: { allow: ["continuity_advance"] },
              models: { mode: "replace", providers: { "mock-openai": provider } },
              agents: {
                ...cfg.agents,
                defaults: {
                  ...cfg.agents?.defaults,
                  model: { primary: PRIMARY_MODEL, fallbacks: [] },
                  utilityModel: UTILITY_MODEL,
                  mediaModels: undefined,
                  heartbeat: { every: "0m" },
                },
                entries: {
                  qa: {
                    ...qa,
                    model: { primary: PRIMARY_MODEL, fallbacks: [] },
                    utilityModel: UTILITY_MODEL,
                    tools: { allow: ["continuity_advance"] },
                  },
                },
              },
            };
          },
        }),
      );
    }
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "spike startup and cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }

  const startChat = async (
    name: SpikeGatewayName,
    input: { sessionKey: string; message: string },
  ): Promise<SpikeChatTicket> => {
    const sessionKey = requireString(input.sessionKey, "session key", 240);
    const message = requireString(input.message, "chat message", 8_192);
    if (!sessionKey.startsWith("agent:qa:") || !message.trim()) {
      throw new Error("spike chat requires an explicit qa session and nonempty message");
    }
    const cursor = await requestCursor(name);
    const startedAt = performance.now();
    const started = requireRecord(
      await call(
        name,
        "chat.send",
        { sessionKey, message, deliver: false, idempotencyKey: randomUUID() },
        { timeoutMs: 30_000 },
      ),
      "chat start",
    );
    const runId = requireString(started.runId, "chat run id", 240);
    if (!runId) {
      throw new Error("chat start did not return a run id");
    }
    const ticket = Object.freeze({ name, sessionKey, runId });
    tickets.set(ticket, { startedAt, cursor });
    return ticket;
  };
  const finishChat = (ticket: SpikeChatTicket, opts: RpcOptions = {}): Promise<SpikeChatResult> => {
    const owned = tickets.get(ticket);
    if (!owned) {
      throw new Error("chat ticket does not belong to this spike network");
    }
    owned.completion ??= (async () => {
      const timeoutMs = opts.timeoutMs ?? 60_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
        throw new Error("chat wait must be between 1 and 120000 milliseconds");
      }
      const terminal = requireRecord(
        await call(
          ticket.name,
          "agent.wait",
          { runId: ticket.runId, timeoutMs },
          { timeoutMs: timeoutMs + 5_000 },
        ),
        "chat terminal",
      );
      if (terminal.status !== "ok" && terminal.status !== "error") {
        throw new Error("spike chat did not reach a terminal outcome within the wait window");
      }
      const elapsedMs = performance.now() - owned.startedAt;
      const history = requireRecord(
        await call(ticket.name, "chat.history", { sessionKey: ticket.sessionKey, limit: 100 }),
        "chat history",
      );
      const observed = await requests(ticket.name, { after: owned.cursor });
      return {
        ticket,
        terminal,
        history,
        requests: observed,
        metrics: {
          mock: true,
          provider: "mock-openai",
          requestScope: "gateway-window",
          physicalProviderRequests: observed.length,
          requestBytes: observed.reduce((sum, request) => sum + request.rawByteLength, 0),
          elapsedMs,
          // The mock fabricates token usage. Neither mock token counts nor
          // elapsed transport time establish paid-model efficiency or quality.
          tokens: null,
          costUsd: null,
        },
      };
    })();
    return owned.completion;
  };
  const chat = async (
    name: SpikeGatewayName,
    input: { sessionKey: string; message: string },
  ): Promise<SpikeChatResult> => finishChat(await startChat(name, input));

  return {
    names: SPIKE_GATEWAY_NAMES,
    call,
    withReadOnlyClient,
    // Ordinary process replacement with unchanged task-owned state, not an
    // abrupt-crash test and not SIGUSR1's potentially in-process restart.
    restart: (name: SpikeGatewayName) =>
      laneFor(name).gateway.restartAfterStateMutation(async () => {}),
    requestCursor,
    requests,
    startChat,
    finishChat,
    chat,
    chatAdvance: (name: SpikeGatewayName, input: { sessionKey: string }) =>
      chat(name, {
        sessionKey: input.sessionKey,
        // This is the maintained QA mock's generic tool fixture, not a new
        // classifier. The tool reads direction/step from its host-owned turn.
        message: "tool search qa check target=continuity_advance. Call that tool exactly once.",
      }),
    stop,
  };
}

export type SpikeNetwork = Awaited<ReturnType<typeof startSpikeNetwork>>;
