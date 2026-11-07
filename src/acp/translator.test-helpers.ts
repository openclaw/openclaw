/** Shared mocked ACP connection and Gateway client helpers for translator tests. */
import type {
  AgentContext,
  RequestPermissionRequest,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type { AcpSessionStore } from "@openclaw/acp-core/session";
import type { AcpServerOptions } from "@openclaw/acp-core/types";
import { vi, type Mock } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import type { AcpEventLedger } from "./event-ledger.js";
import { createTestAcpEventLedger } from "./event-ledger.test-support.js";
import { AcpGatewayAgent } from "./translator.js";

type TestAcpConnection = AgentContext & {
  __requestPermissionMock: ReturnType<typeof vi.fn>;
  __sessionUpdateMock: ReturnType<typeof vi.fn<(params: SessionNotification) => Promise<void>>>;
};

type TestAcpGatewayAgentOptions = AcpServerOptions & {
  eventLedger?: AcpEventLedger;
  sessionStore?: AcpSessionStore;
};

/** Creates a mocked ACP connection with exposed permission and update spies. */
export function createAcpConnection(
  params: {
    requestPermission?: Mock;
  } = {},
): TestAcpConnection {
  const requestPermission: Mock =
    params.requestPermission ?? vi.fn(async () => ({ outcome: { outcome: "cancelled" } }));
  const sessionUpdate = vi.fn<(params: SessionNotification) => Promise<void>>(async () => {});
  return {
    // Route the SDK's method-keyed peer calls to per-method spies.
    notify: async (method: string, notification: SessionNotification) => {
      if (method !== "session/update") {
        throw new Error(`unexpected ACP notification: ${method}`);
      }
      await sessionUpdate(notification);
    },
    request: async (method: string, permissionRequest: RequestPermissionRequest) => {
      if (method !== "session/request_permission") {
        throw new Error(`unexpected ACP request: ${method}`);
      }
      return await requestPermission(permissionRequest);
    },
    __requestPermissionMock: requestPermission,
    __sessionUpdateMock: sessionUpdate,
  } as unknown as TestAcpConnection;
}

/** Creates a mocked Gateway client for translator tests. */
export function createAcpGateway(
  request: GatewayClient["request"] = vi.fn(async () => ({ ok: true })) as GatewayClient["request"],
): GatewayClient {
  return {
    request,
  } as unknown as GatewayClient;
}

/** Creates an ACP translator with an explicit test-owned SQLite event ledger. */
export function createAcpGatewayAgent(
  connection: AgentContext,
  gateway: GatewayClient,
  options: TestAcpGatewayAgentOptions = {},
): AcpGatewayAgent {
  return new AcpGatewayAgent(connection, gateway, {
    ...options,
    eventLedger: options.eventLedger ?? createTestAcpEventLedger(),
  });
}
