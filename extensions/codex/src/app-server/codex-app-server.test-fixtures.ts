import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import type { CodexServerNotification, RpcRequest } from "./protocol.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

type ServerRequestHandler = (request: RpcRequest, signal: AbortSignal) => unknown;
type NotificationHandler = (notification: CodexServerNotification) => Promise<void> | void;

export function createCronAuthorityCapabilityFixture(
  runId: string,
): NonNullable<EmbeddedRunAttemptParams["cronCreatorAuthorityCapability"]> {
  // Mirror the gateway-minted capability instead of casting a partial fixture;
  // transcript tools consume callerOrigin and future contract drift must type-fail.
  const abortController = new AbortController();
  return {
    active: true,
    abort: () => abortController.abort(),
    callerOrigin: { kind: "local" },
    grantTokens: new Set<string>(),
    runId,
    signal: abortController.signal,
  };
}

export function codexTestTurnIds(threadId = "thread-1", turnId = "turn-1") {
  return { threadId, turnId };
}

export function buildConnectorPluginApprovalElicitation(overrides: Record<string, unknown> = {}) {
  return {
    ...codexTestTurnIds(),
    serverName: "codex_apps",
    mode: "form",
    message: "Allow Google Calendar to create an event?",
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      source: "connector",
      connector_id: "connector_google_calendar",
      connector_name: "Google Calendar",
      tool_title: "create_event",
    },
    requestedSchema: {
      type: "object",
      properties: {},
    },
    ...overrides,
  };
}

export function mockClientRuntimeMethods() {
  const getServerVersion = () => CODEX_APP_SERVER_VERSION;
  const closeAndWait: CodexAppServerClient["closeAndWait"] = async () => ({
    exited: true,
    cleanup: "closed",
  });
  const protectPrivateTransportSecret =
    vi.fn<CodexAppServerClient["protectPrivateTransportSecret"]>();
  return {
    closeAndWait,
    protectPrivateTransportSecret,
    getInstanceId: () => "test-client-1",
    getTransportPid: (): number | undefined => undefined,
    getRuntimeIdentity: () => ({ serverVersion: getServerVersion() }),
    getServerVersion,
  };
}

export function threadStartResult(threadId = "thread-1", cwd = "/tmp/openclaw-codex-test") {
  return {
    thread: {
      id: threadId,
      sessionId: "session-1",
      forkedFromId: null,
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd,
      projectId: null,
      cliVersion: CODEX_APP_SERVER_VERSION,
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.4-codex",
    modelProvider: "openai",
    serviceTier: null,
    cwd,
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    permissionProfile: null,
    reasoningEffort: null,
  };
}

export function turnStartResult(turnId = "turn-1", status = "inProgress") {
  return {
    turn: {
      id: turnId,
      status,
      items: [],
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
  };
}

export function createFakeCodexAppServerClient(
  requestImpl: (method: string, params?: unknown, options?: unknown) => unknown = async () =>
    undefined,
) {
  const notificationHandlers = new Set<NotificationHandler>();
  const requestHandlers = new Set<ServerRequestHandler>();
  const closeHandlers = new Set<(client: CodexAppServerClient) => void>();
  let closeError: Error | undefined;
  const request = vi.fn(requestImpl);
  const client = {
    ...mockClientRuntimeMethods(),
    request,
    addNotificationHandler(handler: NotificationHandler) {
      notificationHandlers.add(handler);
      return () => notificationHandlers.delete(handler);
    },
    addRequestHandler(handler: ServerRequestHandler) {
      requestHandlers.add(handler);
      return () => requestHandlers.delete(handler);
    },
    addCloseHandler(handler: (client: CodexAppServerClient) => void) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    getCloseError: () => closeError,
  } as unknown as CodexAppServerClient;

  return {
    client,
    notifications: notificationHandlers,
    request,
    requests: requestHandlers,
    async notify(notification: CodexServerNotification) {
      await Promise.all(
        [...notificationHandlers].map((handler) => Promise.resolve(handler(notification))),
      );
    },
    async handleServerRequest(
      this: void,
      serverRequest: RpcRequest,
      signal = new AbortController().signal,
    ) {
      for (const handler of requestHandlers) {
        const result = await handler(serverRequest, signal);
        if (result !== undefined) {
          return result;
        }
      }
      return undefined;
    },
    close(this: void, error?: Error) {
      closeError = error;
      for (const handler of closeHandlers) {
        handler(client);
      }
    },
  };
}
