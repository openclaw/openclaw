import { describe, expect, it } from "vitest";
import { buildCliSessionDriftNote, buildCliSessionUnseenTurnsContext } from "../cli-session.js";
import { prependCliSessionResumeUserContext } from "./prompt-context.js";

const unseenTurns = [{ prompt: "Child result: CHILD_RESULT", reply: "Relayed." }];
const cliSessionBinding = { sessionId: "native-bound", unseenTurns };

describe("CLI resume user context", () => {
  it("puts the drift note before exchanges the resumed session missed", () => {
    const context = prependCliSessionResumeUserContext(
      { currentInboundContext: { text: "Conversation info" }, cliSessionBinding },
      { mode: "reuse-with-drift", sessionId: "native-bound", drift: { reasons: ["prompt-tools"] } },
    );

    expect(context?.text).toBe(
      [
        buildCliSessionDriftNote(["prompt-tools"]),
        buildCliSessionUnseenTurnsContext(unseenTurns),
        "Conversation info",
      ].join("\n\n"),
    );
  });

  it.each([
    { name: "a fresh session", session: { mode: "invalidate", invalidatedReason: "mcp" } },
    { name: "another native session", session: { mode: "reuse", sessionId: "native-other" } },
  ] as const)("leaves $name to recover from saved history", ({ session }) => {
    expect(
      prependCliSessionResumeUserContext(
        { currentInboundContext: { text: "ask" }, cliSessionBinding },
        session,
      ),
    ).toEqual({ text: "ask" });
  });
});
