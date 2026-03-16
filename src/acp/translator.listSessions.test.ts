import type { ListSessionsRequest } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import type { SessionsListResult } from "../gateway/session-utils.js";
import { createInMemorySessionStore } from "./session.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

describe("acp listSessions", () => {
  function createListSessionsRequest(cwd = "/tmp", limit?: number): ListSessionsRequest {
    return {
      cwd,
      _meta: limit !== undefined ? { limit } : {},
    } as unknown as ListSessionsRequest;
  }

  it("should list sessions with default limit", async () => {
    const sessionStore = createInMemorySessionStore();
    const mockSessions: SessionsListResult = {
      sessions: [
        {
          key: "session-1",
          displayName: "Test Session 1",
          label: "test-label-1",
          updatedAt: Date.now(),
          kind: "chat",
          channel: "acp",
        },
        {
          key: "session-2",
          displayName: "Test Session 2",
          updatedAt: Date.now(),
          kind: "chat",
          channel: "acp",
        },
      ],
    };

    const requestSpy = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return mockSessions;
      }
      return {};
    }) as unknown as GatewayClient["request"];

    const agent = new AcpGatewayAgent(
      createAcpConnection(),
      createAcpGateway(requestSpy),
      { sessionStore },
    );

    const result = await agent.listSessions(createListSessionsRequest());

    expect(requestSpy).toHaveBeenCalledWith("sessions.list", { limit: 100 });
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions[0].sessionId).toBe("session-1");
    expect(result.sessions[0].title).toBe("Test Session 1");
    expect(result.sessions[1].title).toBe("Test Session 2");
    expect(result.nextCursor).toBeNull();

    sessionStore.clearAllSessionsForTest();
  });

  it("should list sessions with custom limit", async () => {
    const sessionStore = createInMemorySessionStore();
    const mockSessions: SessionsListResult = {
      sessions: [
        {
          key: "session-1",
          displayName: "Test Session 1",
          updatedAt: Date.now(),
          kind: "chat",
          channel: "acp",
        },
      ],
    };

    const requestSpy = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return mockSessions;
      }
      return {};
    }) as unknown as GatewayClient["request"];

    const agent = new AcpGatewayAgent(
      createAcpConnection(),
      createAcpGateway(requestSpy),
      { sessionStore },
    );

    await agent.listSessions(createListSessionsRequest("/tmp", 50));

    expect(requestSpy).toHaveBeenCalledWith("sessions.list", { limit: 50 });

    sessionStore.clearAllSessionsForTest();
  });

  it("should handle empty session list", async () => {
    const sessionStore = createInMemorySessionStore();
    const mockSessions: SessionsListResult = {
      sessions: [],
    };

    const requestSpy = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return mockSessions;
      }
      return {};
    }) as unknown as GatewayClient["request"];

    const agent = new AcpGatewayAgent(
      createAcpConnection(),
      createAcpGateway(requestSpy),
      { sessionStore },
    );

    const result = await agent.listSessions(createListSessionsRequest());

    expect(result.sessions).toHaveLength(0);
    expect(result.nextCursor).toBeNull();

    sessionStore.clearAllSessionsForTest();
  });

  it("should use label as fallback when displayName is not available", async () => {
    const sessionStore = createInMemorySessionStore();
    const mockSessions: SessionsListResult = {
      sessions: [
        {
          key: "session-1",
          label: "fallback-label",
          updatedAt: Date.now(),
          kind: "chat",
          channel: "acp",
        },
      ],
    };

    const requestSpy = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return mockSessions;
      }
      return {};
    }) as unknown as GatewayClient["request"];

    const agent = new AcpGatewayAgent(
      createAcpConnection(),
      createAcpGateway(requestSpy),
      { sessionStore },
    );

    const result = await agent.listSessions(createListSessionsRequest());

    expect(result.sessions[0].title).toBe("fallback-label");

    sessionStore.clearAllSessionsForTest();
  });

  it("should use session key as fallback when neither displayName nor label is available", async () => {
    const sessionStore = createInMemorySessionStore();
    const mockSessions: SessionsListResult = {
      sessions: [
        {
          key: "session-key-only",
          updatedAt: Date.now(),
          kind: "chat",
          channel: "acp",
        },
      ],
    };

    const requestSpy = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return mockSessions;
      }
      return {};
    }) as unknown as GatewayClient["request"];

    const agent = new AcpGatewayAgent(
      createAcpConnection(),
      createAcpGateway(requestSpy),
      { sessionStore },
    );

    const result = await agent.listSessions(createListSessionsRequest());

    expect(result.sessions[0].title).toBe("session-key-only");

    sessionStore.clearAllSessionsForTest();
  });

  it("should include session metadata in response", async () => {
    const sessionStore = createInMemorySessionStore();
    const mockSessions: SessionsListResult = {
      sessions: [
        {
          key: "session-1",
          displayName: "Test Session",
          updatedAt: Date.now(),
          kind: "chat",
          channel: "acp",
        },
      ],
    };

    const requestSpy = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return mockSessions;
      }
      return {};
    }) as unknown as GatewayClient["request"];

    const agent = new AcpGatewayAgent(
      createAcpConnection(),
      createAcpGateway(requestSpy),
      { sessionStore },
    );

    const result = await agent.listSessions(createListSessionsRequest("/custom/cwd"));

    expect(result.sessions[0].cwd).toBe("/custom/cwd");
    expect(result.sessions[0]._meta).toEqual({
      sessionKey: "session-1",
      kind: "chat",
      channel: "acp",
    });

    sessionStore.clearAllSessionsForTest();
  });
});
