import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { GatewayClient } from "../gateway/client.js";
import type { AcpEventLedger } from "./event-ledger.js";
import { createTestAcpEventLedger } from "./event-ledger.test-support.js";
import {
  createLoadSessionRequest,
  createNewSessionRequest,
  createPromptRequest,
} from "./translator.bridge-test-helpers.js";
import { createChatEvent } from "./translator.prompt-harness.test-support.js";
import {
  createAcpConnection,
  createAcpGateway,
  createAcpGatewayAgent,
} from "./translator.test-helpers.js";

vi.mock("./commands.js", () => ({ getAvailableCommands: () => [] }));

function createHarness(eventLedger: AcpEventLedger, rejectSend = false) {
  const sessionStore = createInMemorySessionStore();
  const connection = createAcpConnection();
  const sent = createDeferred<string>();
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "sessions.get") {
      throw new Error("ledger replay must not load the transcript");
    }
    if (method === "chat.send") {
      if (rejectSend) {
        throw new Error("send failed before acceptance");
      }
      if (typeof params?.idempotencyKey !== "string") {
        throw new Error("missing run ID");
      }
      sent.resolve(params.idempotencyKey);
    }
    return { ok: true };
  });
  const agent = createAcpGatewayAgent(
    connection,
    createAcpGateway(request as GatewayClient["request"]),
    {
      eventLedger,
      sessionStore,
    },
  );
  return { agent, request, sessionStore, sent, updates: connection["__sessionUpdateMock"] };
}

function sessionRef(harness: ReturnType<typeof createHarness>, sessionId: string) {
  const session = harness.sessionStore.getSession(sessionId);
  if (!session) {
    throw new Error("missing ACP session");
  }
  return { sessionId, sessionKey: session.sessionKey };
}

function chat(sessionKey: string, runId: string, state: "delta" | "final", text: string) {
  return createChatEvent({
    sessionKey,
    runId,
    state,
    message: { content: [{ type: "text", text }] },
  });
}

const replayTypes = [
  "session_info_update",
  "available_commands_update",
  "user_message_chunk",
  "tool_call",
  "tool_call_update",
  "agent_message_chunk",
  "session_info_update",
  "session_info_update",
  "available_commands_update",
];

describe("ACP translator event ledger replay", () => {
  it("replays complete sessions by ACP ID and Gateway key into one canonical ledger", async () => {
    const ledger = createTestAcpEventLedger();
    const recorded = createDeferred();
    const recordPrompt = ledger.recordUserPrompt.bind(ledger);
    vi.spyOn(ledger, "recordUserPrompt").mockImplementation(async (params) => {
      await recordPrompt(params);
      recorded.resolve();
    });
    const first = createHarness(ledger);
    const { sessionId } = await first.agent.newSession(createNewSessionRequest());
    const ref = sessionRef(first, sessionId);
    const prompt = first.agent.prompt(createPromptRequest(sessionId, "Question"));
    const runId = await first.sent.promise;
    await recorded.promise;
    for (const phase of ["start", "result"]) {
      await first.agent.handleGatewayEvent({
        type: "event",
        event: "agent",
        payload: {
          sessionKey: ref.sessionKey,
          runId,
          stream: "tool",
          data: {
            phase,
            toolCallId: "tool-1",
            name: "read",
            args: { path: "src/app.ts" },
            result: { content: [{ type: "text", text: "FILE:src/app.ts" }] },
          },
        },
      });
    }
    await first.agent.handleGatewayEvent(chat(ref.sessionKey, runId, "delta", "Answer"));
    await first.agent.handleGatewayEvent(chat(ref.sessionKey, runId, "final", "Answer"));
    await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });

    const second = createHarness(ledger);
    await second.agent.loadSession(createLoadSessionRequest(sessionId));
    const updates = second.updates.mock.calls.map(([notification]) => notification.update);
    expect(second.request.mock.calls.map(([method]) => method)).not.toContain("sessions.get");
    expect(updates.map((update) => update.sessionUpdate)).toEqual(replayTypes);
    expect(updates[2]).toEqual({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "Question" },
    });
    expect(updates[5]).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Answer" },
    });
    expect(
      (await ledger.readReplay(ref)).events.filter(
        ({ update }) => update.sessionUpdate === "user_message_chunk",
      ),
    ).toHaveLength(1);

    const listed = createHarness(ledger);
    await listed.agent.loadSession(createLoadSessionRequest(ref.sessionKey));
    expect(listed.request.mock.calls.map(([method]) => method)).not.toContain("sessions.get");
    expect(
      listed.updates.mock.calls.map(([notification]) => notification.update.sessionUpdate),
    ).toEqual(replayTypes);
    const followUpRecorded = createDeferred();
    vi.mocked(ledger.recordUserPrompt).mockImplementation(async (params) => {
      await recordPrompt(params);
      followUpRecorded.resolve();
    });
    const followUp = listed.agent.prompt(createPromptRequest(ref.sessionKey, "Follow-up"));
    const followUpRun = await listed.sent.promise;
    await followUpRecorded.promise;
    await listed.agent.handleGatewayEvent(
      chat(ref.sessionKey, followUpRun, "final", "Follow-up answer"),
    );
    await expect(followUp).resolves.toEqual({ stopReason: "end_turn" });
    expect(
      (await ledger.readReplay(ref)).events.filter(
        ({ update }) => update.sessionUpdate === "user_message_chunk",
      ),
    ).toHaveLength(2);
    await expect(ledger.readReplayBySessionId({ sessionId: ref.sessionKey })).resolves.toEqual({
      complete: false,
      events: [],
    });
  });

  it("does not replay prompts rejected before Gateway acceptance", async () => {
    const ledger = createTestAcpEventLedger();
    const first = createHarness(ledger, true);
    const { sessionId } = await first.agent.newSession(createNewSessionRequest());
    const ref = sessionRef(first, sessionId);
    await expect(
      first.agent.prompt(createPromptRequest(sessionId, "Never accepted")),
    ).rejects.toThrow("send failed before acceptance");
    expect(
      (await ledger.readReplay(ref)).events.map(({ update }) => update.sessionUpdate),
    ).not.toContain("user_message_chunk");
    const loaded = createHarness(ledger);
    await loaded.agent.loadSession(createLoadSessionRequest(sessionId));
    expect(
      loaded.updates.mock.calls.map(([notification]) => notification.update.sessionUpdate),
    ).not.toContain("user_message_chunk");
  });

  it("marks replay incomplete when an accepted prompt cannot be recorded", async () => {
    const inner = createTestAcpEventLedger();
    const incomplete = createDeferred();
    const ledger: AcpEventLedger = {
      ...inner,
      recordUserPrompt: async () => {
        throw new Error("ledger write failed");
      },
      markIncomplete: async (params) => {
        await inner.markIncomplete(params);
        incomplete.resolve();
      },
    };
    const harness = createHarness(ledger);
    const { sessionId } = await harness.agent.newSession(createNewSessionRequest());
    const ref = sessionRef(harness, sessionId);
    const prompt = harness.agent.prompt(createPromptRequest(sessionId, "Question"));
    const runId = await harness.sent.promise;
    await incomplete.promise;
    await harness.agent.handleGatewayEvent(chat(ref.sessionKey, runId, "final", "Answer"));
    await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
    await expect(inner.readReplay(ref)).resolves.toEqual({ complete: false, events: [] });
  });
});
