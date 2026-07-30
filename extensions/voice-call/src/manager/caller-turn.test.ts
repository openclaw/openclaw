// Voice Call tests cover caller speech and generated-response ordering.
import { describe, expect, it } from "vitest";
import { CallerTurnState } from "./caller-turn.js";

describe("CallerTurnState", () => {
  it("emits one speech start per utterance and invalidates an in-flight response", () => {
    const activeCalls = new Set(["call-1"]);
    const state = new CallerTurnState((callId) => activeCalls.has(callId));
    const responseToken = state.beginResponse("call-1");

    expect(state.isResponseCurrent("call-1", responseToken)).toBe(true);
    expect(state.beginSpeech("call-1")).toBe(true);
    expect(state.beginSpeech("call-1")).toBe(false);
    expect(state.isSpeaking("call-1")).toBe(true);
    expect(state.isResponseCurrent("call-1", responseToken)).toBe(false);

    state.endSpeech("call-1");
    expect(state.isSpeaking("call-1")).toBe(false);
    expect(state.beginSpeech("call-1")).toBe(true);
  });

  it("keeps only the newest response token current", () => {
    const state = new CallerTurnState((callId) => callId === "call-1");
    const first = state.beginResponse("call-1");
    const second = state.beginResponse("call-1");

    expect(state.isResponseCurrent("call-1", first)).toBe(false);
    expect(state.isResponseCurrent("call-1", second)).toBe(true);

    state.finishResponse("call-1", first);
    expect(state.isResponseCurrent("call-1", second)).toBe(true);

    state.finishResponse("call-1", second);
    expect(state.isResponseCurrent("call-1", second)).toBe(false);
  });

  it("rejects inactive calls and clears all turn state", () => {
    const activeCalls = new Set(["call-1"]);
    const state = new CallerTurnState((callId) => activeCalls.has(callId));

    expect(state.beginSpeech("missing")).toBe(false);
    const responseToken = state.beginResponse("call-1");
    state.beginSpeech("call-1");
    state.clear("call-1");

    expect(state.isSpeaking("call-1")).toBe(false);
    expect(state.isResponseCurrent("call-1", responseToken)).toBe(false);
  });
});
