import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import {
  createAcpConnection,
  createAcpGateway,
  createAcpGatewayAgent,
} from "./translator.test-helpers.js";

vi.mock("./commands.js", () => ({ getAvailableCommands: () => [] }));

describe("ACP translator resume reset", () => {
  it("resumes a listed canonical session when its implicit bridge probe is missing", async () => {
    const canonicalKey = "agent:main:work";
    const implicitBridgeKey = `acp-bridge:${canonicalKey}`;
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "sessions.resolve" && params?.key === implicitBridgeKey) {
        if (params.allowMissing !== true) {
          throw Object.assign(new Error(`No session found: ${implicitBridgeKey}`), {
            code: "INVALID_REQUEST",
          });
        }
        return { ok: true, missing: true };
      }
      if (method === "sessions.list") {
        return { sessions: [{ key: canonicalKey, kind: "direct", updatedAt: 1 }] };
      }
      throw new Error(`Unexpected Gateway request: ${method}`);
    });
    const sessionStore = createInMemorySessionStore();
    const agent = createAcpGatewayAgent(
      createAcpConnection(),
      createAcpGateway(request as GatewayClient["request"]),
      { sessionStore },
    );
    const listed = await agent.listSessions({});
    expect(listed.sessions[0]?.sessionId).toBe(canonicalKey);

    await agent.resumeSession({ sessionId: canonicalKey, cwd: "/work/project", mcpServers: [] });

    expect(sessionStore.getSession(canonicalKey)?.sessionKey).toBe(canonicalKey);
    expect(request).toHaveBeenCalledWith("sessions.resolve", {
      key: implicitBridgeKey,
      allowMissing: true,
    });
  });

  it.each(["metadata", "server default"])(
    "resets the recovered bridge before reading its snapshot (%s)",
    async (resetSource) => {
      const firstStore = createInMemorySessionStore();
      const firstAgent = createAcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
        sessionStore: firstStore,
      });
      const { sessionId } = await firstAgent.newSession({ cwd: "/work/project", mcpServers: [] });
      const implicitBridgeKey = firstStore.getSession(sessionId)?.sessionKey;
      expect(implicitBridgeKey).toBe(`acp-bridge:${sessionId}`);
      const bridgeKey = `agent:main:${implicitBridgeKey}`;

      const resetKeys: unknown[] = [];
      const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
        if (method === "sessions.resolve") {
          return params?.key === implicitBridgeKey ? { ok: true, key: bridgeKey } : { ok: false };
        }
        if (method === "sessions.reset") {
          resetKeys.push(params?.key);
          return { ok: true };
        }
        if (method === "sessions.list") {
          return {
            sessions: [
              {
                key: bridgeKey,
                kind: "direct",
                thinkingLevel: resetKeys.includes(bridgeKey) ? "off" : "high",
                derivedTitle: resetKeys.includes(bridgeKey)
                  ? "Reset conversation"
                  : "Old conversation",
              },
            ],
          };
        }
        return { ok: true };
      });
      const resumedStore = createInMemorySessionStore();
      const connection = createAcpConnection();
      const resumedAgent = createAcpGatewayAgent(
        connection,
        createAcpGateway(request as GatewayClient["request"]),
        { sessionStore: resumedStore, resetSession: resetSource === "server default" },
      );

      const result = await resumedAgent.resumeSession({
        sessionId,
        cwd: "/work/project",
        mcpServers: [],
        ...(resetSource === "metadata" ? { _meta: { resetSession: true } } : {}),
      });

      expect(resetKeys).toEqual([bridgeKey]);
      expect(resumedStore.getSession(sessionId)?.sessionKey).toBe(bridgeKey);
      expect(result.modes?.currentModeId).toBe("off");
      expect(connection["__sessionUpdateMock"]).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId,
          update: expect.objectContaining({
            sessionUpdate: "session_info_update",
            title: "Reset conversation",
          }),
        }),
      );
    },
  );

  it("keeps an explicit routing override authoritative during reset", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return { sessions: [{ key: "agent:main:chosen", kind: "direct" }] };
      }
      return { ok: true };
    });
    const sessionStore = createInMemorySessionStore();
    const agent = createAcpGatewayAgent(
      createAcpConnection(),
      createAcpGateway(request as GatewayClient["request"]),
      { sessionStore },
    );

    await agent.resumeSession({
      sessionId: "old-bridge-id",
      cwd: "/work/project",
      _meta: { sessionKey: "agent:main:chosen", resetSession: true },
    });

    expect(request).toHaveBeenCalledWith("sessions.reset", { key: "agent:main:chosen" });
    expect(sessionStore.getSession("old-bridge-id")?.sessionKey).toBe("agent:main:chosen");
  });
});
