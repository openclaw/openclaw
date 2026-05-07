import type {
  LoadSessionRequest,
  NewSessionRequest,
  PromptRequest,
} from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import type { EventFrame } from "../gateway/protocol/index.js";
import { createInMemoryAcpEventLedger } from "./event-ledger.js";
import { createInMemorySessionStore } from "./session.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

vi.mock("./commands.js", () => ({
  getAvailableCommands: () => [],
}));

function createNewSessionRequest(cwd = "/tmp"): NewSessionRequest {
  return {
    cwd,
    mcpServers: [],
    _meta: {},
  } as unknown as NewSessionRequest;
}

function createLoadSessionRequest(sessionId: string, cwd = "/tmp"): LoadSessionRequest {
  return {
    sessionId,
    cwd,
    mcpServers: [],
    _meta: {},
  } as unknown as LoadSessionRequest;
}

function createPromptRequest(sessionId: string, text: string): PromptRequest {
  return {
    sessionId,
    prompt: [{ type: "text", text }],
    _meta: {},
  } as unknown as PromptRequest;
}

function createToolEvent(params: {
  sessionKey: string;
  runId: string;
  phase: "start" | "result";
  toolCallId: string;
}): EventFrame {
  return {
    event: "agent",
    payload: {
      sessionKey: params.sessionKey,
      runId: params.runId,
      stream: "tool",
      data: {
        phase: params.phase,
        toolCallId: params.toolCallId,
        name: "read",
        args: { path: "src/app.ts" },
        result: { content: [{ type: "text", text: "FILE:src/app.ts" }] },
      },
    },
  } as unknown as EventFrame;
}

function createChatEvent(params: {
  sessionKey: string;
  runId: string;
  state: "delta" | "final";
  text: string;
}): EventFrame {
  return {
    event: "chat",
    payload: {
      sessionKey: params.sessionKey,
      runId: params.runId,
      state: params.state,
      message: {
        content: [{ type: "text", text: params.text }],
      },
    },
  } as unknown as EventFrame;
}

describe("ACP translator event ledger replay", () => {
  it("loads complete ledger-backed sessions without the lossy Gateway transcript fallback", async () => {
    const eventLedger = createInMemoryAcpEventLedger();
    const firstSessionStore = createInMemorySessionStore();
    const firstConnection = createAcpConnection();
    const firstRequestMock = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { ok: true };
      }
      return { ok: true };
    });
    const firstRequest = firstRequestMock as GatewayClient["request"];
    const firstAgent = new AcpGatewayAgent(firstConnection, createAcpGateway(firstRequest), {
      eventLedger,
      sessionStore: firstSessionStore,
    });

    const created = await firstAgent.newSession(createNewSessionRequest());
    const firstSession = firstSessionStore.getSession(created.sessionId);
    if (!firstSession) {
      throw new Error("Expected new ACP session to be stored");
    }
    firstConnection.__sessionUpdateMock.mockClear();

    const promptPromise = firstAgent.prompt(createPromptRequest(created.sessionId, "Question"));
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (firstRequestMock.mock.calls.some((call) => call[0] === "chat.send")) {
        break;
      }
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
    const runId = firstSessionStore.getSession(created.sessionId)?.activeRunId;
    if (!runId) {
      throw new Error("Expected active ACP run");
    }

    await firstAgent.handleGatewayEvent(
      createToolEvent({
        sessionKey: firstSession.sessionKey,
        runId,
        phase: "start",
        toolCallId: "tool-1",
      }),
    );
    await firstAgent.handleGatewayEvent(
      createToolEvent({
        sessionKey: firstSession.sessionKey,
        runId,
        phase: "result",
        toolCallId: "tool-1",
      }),
    );
    await firstAgent.handleGatewayEvent(
      createChatEvent({
        sessionKey: firstSession.sessionKey,
        runId,
        state: "delta",
        text: "Answer",
      }),
    );
    await firstAgent.handleGatewayEvent(
      createChatEvent({
        sessionKey: firstSession.sessionKey,
        runId,
        state: "final",
        text: "Answer",
      }),
    );
    await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });

    const secondConnection = createAcpConnection();
    const secondRequestMock = vi.fn(async (method: string) => {
      if (method === "sessions.get") {
        throw new Error("ledger replay should not call sessions.get");
      }
      return { ok: true };
    });
    const secondRequest = secondRequestMock as GatewayClient["request"];
    const secondAgent = new AcpGatewayAgent(secondConnection, createAcpGateway(secondRequest), {
      eventLedger,
      sessionStore: createInMemorySessionStore(),
    });

    await secondAgent.loadSession(createLoadSessionRequest(created.sessionId));

    expect(secondRequestMock).not.toHaveBeenCalledWith("sessions.get", expect.anything());
    const replayedUpdates = secondConnection.__sessionUpdateMock.mock.calls.map(
      (call) => call[0]?.update,
    );
    const replayedUpdateTypes = replayedUpdates.map((update) => update?.sessionUpdate);
    expect(replayedUpdateTypes).toEqual(
      expect.arrayContaining([
        "session_info_update",
        "available_commands_update",
        "user_message_chunk",
        "tool_call",
        "tool_call_update",
        "agent_message_chunk",
      ]),
    );
    expect(replayedUpdates).toContainEqual({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "Question" },
    });
    expect(replayedUpdates).toContainEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Answer" },
    });
    expect(replayedUpdateTypes.indexOf("user_message_chunk")).toBeLessThan(
      replayedUpdateTypes.indexOf("agent_message_chunk"),
    );

    const ledgerReplay = await eventLedger.readReplay({
      sessionId: created.sessionId,
      sessionKey: firstSession.sessionKey,
    });
    expect(
      ledgerReplay.events.filter((event) => event.update.sessionUpdate === "user_message_chunk"),
    ).toHaveLength(1);

    firstSessionStore.clearAllSessionsForTest();
  });
});
