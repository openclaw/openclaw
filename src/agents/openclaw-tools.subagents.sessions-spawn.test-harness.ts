import { vi } from "vitest";

type SessionsSpawnTestConfig = ReturnType<(typeof import("../config/config.js"))["loadConfig"]>;
type CreateSessionsSpawnTool =
  (typeof import("./tools/sessions-spawn-tool.js"))["createSessionsSpawnTool"];
export type CreateOpenClawToolsOpts = Parameters<CreateSessionsSpawnTool>[0];
export type GatewayRequest = { method?: string; params?: unknown };
export type AgentWaitCall = { runId?: string; timeoutMs?: number };
type SessionsSpawnGatewayMockOptions = {
  includeSessionsList?: boolean;
  includeChatHistory?: boolean;
  chatHistoryText?: string;
  onAgentSubagentSpawn?: (params: unknown) => void;
  onSessionsPatch?: (params: unknown) => void;
  onSessionsDelete?: (params: unknown) => void;
  agentWaitResult?: { status: "ok" | "timeout"; startedAt: number; endedAt: number };
};

// Avoid exporting vitest mock types (TS2742 under pnpm + d.ts emit).
// oxlint-disable-next-line typescript/no-explicit-any
type AnyMock = any;

const hoisted = vi.hoisted(() => {
  const callGatewayMock = vi.fn();
  const defaultConfigOverride = {
    session: {
      mainKey: "main",
      scope: "per-sender",
    },
  } as SessionsSpawnTestConfig;
  const state = { configOverride: defaultConfigOverride };
  return { callGatewayMock, defaultConfigOverride, state };
});

export function getCallGatewayMock(): AnyMock {
  return hoisted.callGatewayMock;
}

export function getGatewayRequests(): Array<GatewayRequest> {
  return getCallGatewayMock().mock.calls.map((call: [unknown]) => call[0] as GatewayRequest);
}

export function getGatewayMethods(): Array<string | undefined> {
  return getGatewayRequests().map((request) => request.method);
}

export function findGatewayRequest(method: string): GatewayRequest | undefined {
  return getGatewayRequests().find((request) => request.method === method);
}

export function resetSessionsSpawnConfigOverride(): void {
  hoisted.state.configOverride = hoisted.defaultConfigOverride;
}

export function setSessionsSpawnConfigOverride(next: SessionsSpawnTestConfig): void {
  hoisted.state.configOverride = next;
}

export async function getSessionsSpawnTool(opts: CreateOpenClawToolsOpts) {
  // Dynamic import: ensure harness mocks are installed before tool modules load.
  const { createSessionsSpawnTool } = await import("./tools/sessions-spawn-tool.js");
  return createSessionsSpawnTool(opts);
}

export function setupSessionsSpawnGatewayMock(setupOpts: SessionsSpawnGatewayMockOptions): {
  calls: Array<GatewayRequest>;
  waitCalls: Array<AgentWaitCall>;
  getChild: () => { runId?: string; sessionKey?: string };
} {
  const calls: Array<GatewayRequest> = [];
  const waitCalls: Array<AgentWaitCall> = [];
  let agentCallCount = 0;
  let childRunId: string | undefined;
  let childSessionKey: string | undefined;

  getCallGatewayMock().mockImplementation(async (optsUnknown: unknown) => {
    const request = optsUnknown as GatewayRequest;
    calls.push(request);

    if (request.method === "sessions.list" && setupOpts.includeSessionsList) {
      return {
        sessions: [
          {
            key: "main",
            lastChannel: "whatsapp",
            lastTo: "+123",
          },
        ],
      };
    }

    if (request.method === "agent") {
      agentCallCount += 1;
      const runId = `run-${agentCallCount}`;
      const params = request.params as { lane?: string; sessionKey?: string } | undefined;
      // Capture only the subagent run metadata.
      if (params?.lane === "subagent") {
        childRunId = runId;
        childSessionKey = params.sessionKey ?? "";
        setupOpts.onAgentSubagentSpawn?.(params);
      }
      return {
        runId,
        status: "accepted",
        acceptedAt: 1000 + agentCallCount,
      };
    }

    if (request.method === "agent.wait") {
      const params = request.params as AgentWaitCall | undefined;
      waitCalls.push(params ?? {});
      const waitResult = setupOpts.agentWaitResult ?? {
        status: "ok",
        startedAt: 1000,
        endedAt: 2000,
      };
      return {
        runId: params?.runId ?? "run-1",
        ...waitResult,
      };
    }

    if (request.method === "sessions.patch") {
      setupOpts.onSessionsPatch?.(request.params);
      return { ok: true };
    }

    if (request.method === "sessions.delete") {
      setupOpts.onSessionsDelete?.(request.params);
      return { ok: true };
    }

    if (request.method === "chat.history" && setupOpts.includeChatHistory) {
      return {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: setupOpts.chatHistoryText ?? "done" }],
          },
        ],
      };
    }

    return {};
  });

  return {
    calls,
    waitCalls,
    getChild: () => ({ runId: childRunId, sessionKey: childSessionKey }),
  };
}

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => hoisted.callGatewayMock(opts),
}));
// Some tools import callGateway via "../../gateway/call.js" (from nested folders). Mock that too.
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => hoisted.callGatewayMock(opts),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => hoisted.state.configOverride,
    resolveGatewayPort: () => 18789,
  };
});

// Same module, different specifier (used by tools under src/agents/tools/*).
vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => hoisted.state.configOverride,
    resolveGatewayPort: () => 18789,
  };
});
