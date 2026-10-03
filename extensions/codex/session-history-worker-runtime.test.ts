import "openclaw/plugin-sdk/compiled-subprocess-testing";
import {
  createCodexSessionContextReader,
  SessionTranscriptReadFenceError,
  type CodexSessionContextReader,
  type CodexSessionContextSnapshot,
} from "openclaw/plugin-sdk/codex-session-transcript-runtime";
import * as sessionStore from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectCodexSettledHistoryInWorker } from "./session-history-worker-runtime.js";
import { settledFixture } from "./src/app-server/session-history.test-support.js";

afterEach(() => vi.restoreAllMocks());

function actorHistoryFixture() {
  const sessionTarget = {
    agentId: "main",
    sessionId: "actor-session",
    sessionKey: "agent:main:dashboard:incognito-history",
    storePath: "/synthetic/incognito.sqlite",
  };
  const { upstreamPrompt, settledMessages } = settledFixture();
  const snapshot: CodexSessionContextSnapshot = {
    header: { type: "session", id: sessionTarget.sessionId },
    messages: [
      { role: "user", content: "Earlier synthetic context.", timestamp: 1 },
      ...settledMessages,
    ],
  };
  const owner = {
    assertCurrent(target: Parameters<CodexSessionContextReader>[0]) {
      if (
        target.agentId !== sessionTarget.agentId ||
        target.sessionId !== sessionTarget.sessionId ||
        target.sessionKey !== sessionTarget.sessionKey ||
        target.storePath !== sessionTarget.storePath
      ) {
        throw new Error("History capability belongs to another actor target");
      }
    },
    read: vi.fn(async () => snapshot),
    validate: vi.fn(async (_snapshot: CodexSessionContextSnapshot) => {}),
    retain: <T>(operation: () => Promise<T>) => operation(),
  };
  return {
    owner,
    reader: createCodexSessionContextReader(owner),
    upstreamPrompt,
    target: {
      ...sessionTarget,
      sessionTarget,
      sessionFile: `sqlite:main:${sessionTarget.sessionId}:${sessionTarget.storePath}`,
      mirroredMessages: settledMessages,
      settledMessages,
      turnId: "settled",
    },
  };
}

describe("Codex actor history adapter", () => {
  it("projects full-fidelity settled evidence into ordered native history", async () => {
    const { target, reader, upstreamPrompt } = actorHistoryFixture();

    await expect(projectCodexSettledHistoryInWorker(target, undefined, reader)).resolves.toEqual({
      status: "ok",
      value: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Earlier synthetic context." }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: upstreamPrompt }],
        },
        { type: "function_call", call_id: "sent", name: "message", arguments: "{}" },
        { type: "function_call_output", call_id: "sent", output: "Synthetic update sent." },
      ],
    });
  });

  it("passes the requested target to the bound capability before acquiring history", async () => {
    const { target, reader, owner } = actorHistoryFixture();
    const foreignTarget = {
      ...target,
      agentId: "other",
      sessionTarget: { ...target.sessionTarget, agentId: "other" },
    };

    await expect(
      projectCodexSettledHistoryInWorker(foreignTarget, undefined, reader),
    ).rejects.toThrow("History capability belongs to another actor target");
    expect(owner.read).not.toHaveBeenCalled();
  });

  it("reports invalidated actor snapshots through the plugin rejection contract", async () => {
    const { target, reader, owner } = actorHistoryFixture();
    owner.validate.mockRejectedValueOnce(new SessionTranscriptReadFenceError("Snapshot changed"));

    await expect(projectCodexSettledHistoryInWorker(target, undefined, reader)).resolves.toEqual({
      status: "rejected",
      reason: "snapshot_invalidated",
    });
  });

  it("refuses cancellation during the final actor snapshot validation", async () => {
    const { target, reader, owner } = actorHistoryFixture();
    const controller = new AbortController();
    const cancelled = new Error("History caller cancelled during validation");
    owner.validate.mockImplementationOnce(async () => controller.abort(cancelled));

    await expect(
      projectCodexSettledHistoryInWorker(target, controller.signal, reader),
    ).rejects.toBe(cancelled);
  });

  it("preserves owner-ended errors for caller recovery", async () => {
    const { target, reader, owner } = actorHistoryFixture();
    const ended = Object.assign(new Error("Actor ended"), { code: "INCOGNITO_SESSION_ENDED" });
    owner.read.mockRejectedValueOnce(ended);

    await expect(projectCodexSettledHistoryInWorker(target, undefined, reader)).rejects.toBe(ended);
  });

  it("refuses marker-only actor targets before consulting caller-thread storage", async () => {
    const { target, reader, owner } = actorHistoryFixture();
    const exactEntry = vi.spyOn(sessionStore, "getSessionEntry").mockImplementation(() => {
      throw new Error("Unexpected caller-thread SQL");
    });
    const sessionKey = vi
      .spyOn(sessionStore, "resolveTranscriptSessionKeyBySessionId")
      .mockImplementation(() => {
        throw new Error("Unexpected caller-thread SQL");
      });
    const { sessionTarget: _capturedTarget, ...markerOnly } = target;

    await expect(projectCodexSettledHistoryInWorker(markerOnly, undefined, reader)).rejects.toThrow(
      "Actor history requires a captured sessionTarget",
    );
    expect(exactEntry).not.toHaveBeenCalled();
    expect(sessionKey).not.toHaveBeenCalled();
    expect(owner.read).not.toHaveBeenCalled();
  });
});
