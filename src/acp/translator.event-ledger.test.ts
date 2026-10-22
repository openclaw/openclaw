import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { AcpEventLedger } from "./event-ledger.js";
import { createTestAcpEventLedger } from "./event-ledger.test-support.js";
import {
  createLoadSessionRequest,
  createNewSessionRequest,
} from "./translator.bridge-test-helpers.js";
import { createPromptScenario } from "./translator.scenario.test-support.js";

vi.mock("./commands.js", () => ({ getAvailableCommands: () => [] }));

async function createHarness(
  eventLedger: AcpEventLedger,
  options: { load?: string; rejectSend?: boolean } = {},
) {
  const h = createPromptScenario({
    eventLedger,
    sessions: [],
    send: () => {
      if (options.rejectSend) {
        throw new Error("send failed before acceptance");
      }
      return { ok: true };
    },
    request: (method) => {
      if (method === "sessions.get") {
        throw new Error("ledger replay must not load the transcript");
      }
      return { ok: true };
    },
  });
  const { agent, sessionStore } = h;
  const sessionId = options.load ?? (await agent.newSession(createNewSessionRequest())).sessionId;
  if (options.load) {
    await agent.loadSession(createLoadSessionRequest(sessionId));
  }
  const session = sessionStore.getSession(sessionId);
  if (!session) {
    throw new Error("missing ACP session");
  }
  const ref = { sessionId, sessionKey: session.sessionKey };
  const event = (name: string, payload: Record<string, unknown>) =>
    h.event(name, { sessionKey: ref.sessionKey, ...payload });
  return {
    ref,
    request: h.request,
    event,
    updates: () => h.sessionUpdate.mock.calls.map(([n]) => n.update),
    start: (text: string) => h.start(sessionId, text),
    chat: (runId: string, state: "delta" | "final", text: string) =>
      event("chat", { runId, state, message: { content: [{ type: "text", text }] } }),
  };
}

async function userPrompts(ledger: AcpEventLedger, ref: { sessionId: string; sessionKey: string }) {
  return (await ledger.readReplay(ref)).events.filter(
    ({ update }) => update.sessionUpdate === "user_message_chunk",
  );
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

function expectReplay(harness: Awaited<ReturnType<typeof createHarness>>) {
  expect(harness.request.mock.calls.map(([method]) => method)).not.toContain("sessions.get");
  expect(harness.updates().map((update) => update.sessionUpdate)).toEqual(replayTypes);
}

it("replays complete sessions by ACP ID and Gateway key into one canonical ledger", async () => {
  const ledger = createTestAcpEventLedger();
  let recorded = createDeferred();
  const recordPrompt = ledger.recordUserPrompt.bind(ledger);
  vi.spyOn(ledger, "recordUserPrompt").mockImplementation(async (params) => {
    await recordPrompt(params);
    recorded.resolve();
  });
  const first = await createHarness(ledger);
  const ref = first.ref;
  const { result: prompt, sent } = first.start("Question");
  const runId = await sent;
  await recorded.promise;
  for (const phase of ["start", "result"]) {
    await first.event("agent", {
      runId,
      stream: "tool",
      data: {
        phase,
        toolCallId: "tool-1",
        name: "read",
        args: { path: "src/app.ts" },
        result: { content: [{ type: "text", text: "FILE:src/app.ts" }] },
      },
    });
  }
  await first.chat(runId, "delta", "Answer");
  await first.chat(runId, "final", "Answer");
  await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });

  const second = await createHarness(ledger, { load: ref.sessionId });
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

  const listed = await createHarness(ledger, { load: ref.sessionKey });
  expectReplay(listed);
  recorded = createDeferred();
  const { result: followUp, sent: followUpSent } = listed.start("Follow-up");
  const followUpRun = await followUpSent;
  await recorded.promise;
  await listed.chat(followUpRun, "final", "Follow-up answer");
  await expect(followUp).resolves.toEqual({ stopReason: "end_turn" });
  expect(await userPrompts(ledger, ref)).toHaveLength(2);
  await expect(ledger.readReplayBySessionId({ sessionId: ref.sessionKey })).resolves.toEqual({
    complete: false,
    events: [],
  });
});

it("does not replay prompts rejected before Gateway acceptance", async () => {
  const ledger = createTestAcpEventLedger();
  const first = await createHarness(ledger, { rejectSend: true });
  await expect(first.start("Never accepted").result).rejects.toThrow(
    "send failed before acceptance",
  );
  expect(await userPrompts(ledger, first.ref)).toHaveLength(0);
  const loaded = await createHarness(ledger, { load: first.ref.sessionId });
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
  const harness = await createHarness(ledger);
  const { result: prompt, sent } = harness.start("Question");
  const runId = await sent;
  await incomplete.promise;
  await harness.chat(runId, "final", "Answer");
  await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
  await expect(ledger.readReplay(harness.ref)).resolves.toEqual({ complete: false, events: [] });
});
