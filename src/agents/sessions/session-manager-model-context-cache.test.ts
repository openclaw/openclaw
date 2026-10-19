import assert from "node:assert/strict";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { SessionManager } from "./session-manager.js";

it("refills warmed context when a prompt restart retires a suffix entry", async () => {
  await withOpenClawTestState({ label: "model-prompt-restart" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "prompt-restart",
      sessionKey: "agent:main:prompt-restart",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const source = SessionManager.open(scope);
    for (let index = 1; index <= 4; index++) {
      source.appendMessage(makeUserMessage(`question-${index}`, index));
    }
    source.appendCustomMessageEntry("openclaw.system-update", "old prompt", false, {
      kind: "prompt-update",
    });
    const limits = { maxBytes: 1_000_000, maxEvents: 4 };
    const read = async () =>
      (await SessionManager.openModelContextAsync(scope, { limits })).buildSessionContext();
    const warmed = await read();
    expect(warmed.messages).toHaveLength(4);
    expect(warmed.messages[0]).toMatchObject({ content: "question-2" });

    source.appendCustomEntry("openclaw.system-prompt", { restart: true });
    const expected = source.buildSessionContext();
    expect(expected.messages).toHaveLength(4);
    expect(expected.messages[0]).toMatchObject({ content: "question-1" });
    expect(await read()).toEqual(expected);
    expect(await read()).toEqual(expected);
  });
});

it("keeps warmed current context after historical and smaller-window reads", async () => {
  await withOpenClawTestState({ label: "model-anchor-retention" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "anchor-retention",
      sessionKey: "agent:main:anchor-retention",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const source = SessionManager.open(scope);
    const discardedId = source.appendMessage(makeUserMessage("discarded-prefix", 0));
    for (let index = 1; index < 6; index++) {
      source.appendMessage(makeUserMessage(`question-${index}`, index));
    }
    await waitForSessionTranscriptProjection(scope);
    const historical = source.appendMessageWithTranscriptAnchor(makeUserMessage("question-6", 6));
    assert(historical.anchor, "missing historical anchor");
    for (let index = 7; index < 16; index++) {
      source.appendMessage(makeUserMessage(`question-${index}`, index));
    }
    await waitForSessionTranscriptProjection(scope);
    const limits = { maxBytes: 8192, maxEvents: 4 };
    const readCurrent = () => SessionManager.openModelContext(scope, { limits });
    const current = readCurrent();
    const expected = current.buildSessionContext();
    expect(current.getBranch().some((entry) => entry.id === discardedId)).toBe(false);
    expect(expected.messages.at(-1)).toMatchObject({ content: "question-15" });

    const earlier = SessionManager.openModelContext(scope, {
      through: historical.anchor,
      limits: { ...limits, maxEvents: 2 },
    });
    expect(earlier.buildSessionContext().messages.at(-1)).toMatchObject({ content: "question-6" });

    let discardedPrefixReads = 0;
    const parse = JSON.parse;
    const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      if (typeof text === "string" && text.includes(JSON.stringify(discardedId))) {
        discardedPrefixReads += 1;
      }
      return parse(text, reviver);
    });
    try {
      expect(readCurrent().buildSessionContext()).toEqual(expected);
      expect(
        SessionManager.openModelContext(scope, {
          limits: { ...limits, maxEvents: 2 },
        })
          .buildSessionContext()
          .messages.at(-1),
      ).toMatchObject({ content: "question-15" });
      expect(readCurrent().buildSessionContext()).toEqual(expected);
      expect(discardedPrefixReads).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
