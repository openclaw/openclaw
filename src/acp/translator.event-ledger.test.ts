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
  const gateway = createAcpGateway(request as GatewayClient["request"]);
  const agent = createAcpGatewayAgent(connection, gateway, { eventLedger, sessionStore });
  return {
    agent,
    request,
    sessionStore,
    sent,
    updates: () => connection["__sessionUpdateMock"].mock.calls.map(([n]) => n.update),
    load: (id: string) => agent.loadSession(createLoadSessionRequest(id)),
    prompt: (id: string, text: string) => agent.prompt(createPromptRequest(id, text)),
  };
}

async function userPrompts(ledger: AcpEventLedger, ref: { sessionId: string; sessionKey: string }) {
  return (await ledger.readReplay(ref)).events.filter(
    ({ update }) => update.sessionUpdate === "user_message_chunk",
  );
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

function expectReplay(harness: ReturnType<typeof createHarness>) {
  expect(harness.request.mock.calls.map(([method]) => method)).not.toContain("sessions.get");
  expect(harness.updates().map((update) => update.sessionUpdate)).toEqual(replayTypes);
}

describe("ACP translator event ledger replay", () => {
  it("replays complete sessions by ACP ID and Gateway key into one canonical ledger", async () => {
    const ledger = createTestAcpEventLedger();
    let recorded = createDeferred();
    const recordPrompt = ledger.recordUserPrompt.bind(ledger);
    vi.spyOn(ledger, "recordUserPrompt").mockImplementation(async (params) => {
      await recordPrompt(params);
      recorded.resolve();
    });
    const first = createHarness(ledger);
    const { sessionId } = await first.agent.newSession(createNewSessionRequest());
    const ref = sessionRef(first, sessionId);
    const prompt = first.prompt(sessionId, "Question");
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
    await second.load(sessionId);
    const updates = second.updates();
    expectReplay(second);
    expect(updates[2]).toEqual({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "Question" },
    });
    expect(updates[5]).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Answer" },
    });
    expect(await userPrompts(ledger, ref)).toHaveLength(1);

    const listed = createHarness(ledger);
    await listed.load(ref.sessionKey);
    expectReplay(listed);
    recorded = createDeferred();
    const followUp = listed.prompt(ref.sessionKey, "Follow-up");
    const followUpRun = await listed.sent.promise;
    await recorded.promise;
    await listed.agent.handleGatewayEvent(
      chat(ref.sessionKey, followUpRun, "final", "Follow-up answer"),
    );
    await expect(followUp).resolves.toEqual({ stopReason: "end_turn" });
    expect(await userPrompts(ledger, ref)).toHaveLength(2);
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
    await expect(first.prompt(sessionId, "Never accepted")).rejects.toThrow(
      "send failed before acceptance",
    );
    expect(await userPrompts(ledger, ref)).toHaveLength(0);
    const loaded = createHarness(ledger);
    await loaded.load(sessionId);
    expect(loaded.updates().map((update) => update.sessionUpdate)).not.toContain(
      "user_message_chunk",
    );
  });

  it("marks replay incomplete when an accepted prompt cannot be recorded", async () => {
    const ledger = createTestAcpEventLedger();
    const incomplete = createDeferred();
    vi.spyOn(ledger, "recordUserPrompt").mockRejectedValue(new Error("ledger write failed"));
    const markIncomplete = ledger.markIncomplete.bind(ledger);
    vi.spyOn(ledger, "markIncomplete").mockImplementation(async (params) => {
      await markIncomplete(params);
      incomplete.resolve();
    });
    const harness = createHarness(ledger);
    const { sessionId } = await harness.agent.newSession(createNewSessionRequest());
    const ref = sessionRef(harness, sessionId);
    const prompt = harness.prompt(sessionId, "Question");
    const runId = await harness.sent.promise;
    await incomplete.promise;
    await harness.agent.handleGatewayEvent(chat(ref.sessionKey, runId, "final", "Answer"));
    await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
    await expect(ledger.readReplay(ref)).resolves.toEqual({ complete: false, events: [] });
  });
});
