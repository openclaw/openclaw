import path from "node:path";
import { afterAll, expect, it } from "vitest";
import {
  findTranscriptEvent,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { SessionManager } from "../sessions/session-manager.js";
import { persistAcpTurnTranscript, persistCliTurnTranscript } from "./transcript-persistence.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-coordination-fallback-");

async function createSession(body = "Write the report", subagent = false) {
  const cwd = sessionDirs.make();
  const sessionId = "test-session";
  const sessionEntry = { sessionId, updatedAt: Date.now() };
  const common = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${subagent ? "subagent:" : ""}${sessionId}`,
    storePath: path.join(cwd, "openclaw-agent.sqlite"),
    body,
    sessionEntry,
    sessionAgentId: "main",
    sessionCwd: cwd,
    config: {},
  };
  await upsertSessionEntryCore(common, sessionEntry);
  return { ...common, sessionStore: { [common.sessionKey]: sessionEntry } };
}

function assistantMessage(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

type TranscriptContext = Omit<Parameters<typeof persistCliTurnTranscript>[0], "result">;

function persist(runtime: string, common: TranscriptContext, finalText: string, hidden = false) {
  return runtime === "CLI"
    ? persistCliTurnTranscript({
        ...common,
        result: { payloads: [{ text: finalText }], meta: { durationMs: 0 } },
        skipUserTurn: hidden,
      })
    : persistAcpTurnTranscript({
        ...common,
        finalText,
        terminalOutcome: { reason: "completed", status: "ok" },
        prepareAssistantTranscriptMessage: hidden
          ? (message) => ({ ...message, display: true })
          : undefined,
      });
}

it.each([
  { runtime: "CLI", sourceTool: "sessions_send" },
  { runtime: "ACP", sourceTool: "sessions_send" },
  { runtime: "CLI", sourceTool: "subagent_settle", privateCompletion: true as const },
  { runtime: "ACP", sourceTool: "subagent_settle", privateCompletion: true as const },
])("hides $runtime $sourceTool fallback", async ({ runtime, sourceTool, privateCompletion }) => {
  const common = {
    ...(await createSession("Review the worker result")),
    privateCompletion,
    inputProvenance: {
      kind: "inter_session" as const,
      sourceTool,
      sourceRole: "subagent" as const,
    },
  };
  await persist(runtime, common, "Report received", true);
  const messages = SessionManager.open(common).buildSessionContext().messages;
  expect(messages).toHaveLength(runtime === "CLI" ? 1 : 2);
  expect(messages.at(-1)).toMatchObject(assistantMessage("Report received"));
  expect(messages.every((message) => Reflect.get(message, "display") === false)).toBe(true);
});

it.each(["CLI", "ACP"] as const)(
  "keeps %s private completions out of unread activity",
  async (runtime) => {
    const common = await createSession("Review the worker result");
    const settled = Date.now() - 60_000;
    const baseline = { ...common.sessionEntry, updatedAt: settled, lastActivityAt: settled };
    await upsertSessionEntryCore({ ...common, sessionEntry: baseline }, baseline);
    const read = () =>
      loadSessionEntry({
        agentId: common.agentId,
        sessionKey: common.sessionKey,
        storePath: common.storePath,
        readConsistency: "latest",
      });
    await persist(
      runtime,
      {
        ...common,
        sessionEntry: baseline,
        sessionStore: { [common.sessionKey]: baseline },
        privateCompletion: true,
        inputProvenance: {
          kind: "inter_session",
          sourceTool: "subagent_settle",
          sourceRole: "subagent",
        },
      },
      "Report received",
      true,
    );
    // The append still touches the entry, but a hidden completion is not activity.
    expect(read()?.updatedAt).toBeGreaterThan(settled);
    expect(read()?.lastActivityAt).toBe(settled);
  },
);

it.each(["CLI", "ACP"] as const)(
  "counts a visible %s transcript append as unread activity",
  async (runtime) => {
    const common = await createSession();
    const settled = Date.now() - 60_000;
    const baseline = { ...common.sessionEntry, updatedAt: settled, lastActivityAt: settled };
    await upsertSessionEntryCore({ ...common, sessionEntry: baseline }, baseline);
    await persist(
      runtime,
      { ...common, sessionEntry: baseline, sessionStore: { [common.sessionKey]: baseline } },
      "Report received",
    );
    expect(
      loadSessionEntry({
        agentId: common.agentId,
        sessionKey: common.sessionKey,
        storePath: common.storePath,
        readConsistency: "latest",
      })?.lastActivityAt,
    ).toBeGreaterThan(settled);
  },
);

it.each(["CLI", "ACP"] as const)("recovers full %s answer after a later turn", async (runtime) => {
  const runId = `run-${runtime.toLowerCase()}-final`;
  const common = await createSession(undefined, true);
  const finalText = `${"line of the child report\n".repeat(400)}END-MARKER`;
  for (const turn of [
    { runId, finalText },
    { runId: `${runId}-later`, finalText: "A different turn's answer" },
  ]) {
    await persist(runtime, { ...common, runId: turn.runId }, turn.finalText);
  }
  const found = await findTranscriptEvent(common, { kind: "visible-final", runId });
  expect(found?.event).toMatchObject({
    message: { ...assistantMessage(finalText), __openclaw: { runId } },
  });
});
