import { describe, expect, it, vi } from "vitest";
import {
  IncognitoSessionEndedError,
  IncognitoSessionSyncAccessError,
} from "../../state/incognito-session-error.js";
import { SessionManager } from "../sessions/session-manager.js";
import { createProviderReplaySessionState } from "./replay-session-state.js";

describe("legacy provider replay session state", () => {
  it.each([
    new IncognitoSessionSyncAccessError("appendCustomEntry", "appendCustomEntryAsync"),
    new IncognitoSessionEndedError(),
  ])("propagates $name instead of pretending the session is empty or persisted", (failure) => {
    const manager = SessionManager.inMemory();
    vi.spyOn(manager, "getEntries").mockImplementation(() => {
      throw failure;
    });
    vi.spyOn(manager, "appendCustomEntry").mockImplementation(() => {
      throw failure;
    });
    const replay = createProviderReplaySessionState(manager);

    expect(() => replay.state.getCustomEntries()).toThrow(failure);
    expect(() => replay.state.appendCustomEntry("fixture", {})).toThrow(failure);
    replay.close();
  });

  it("retains the released adapter's ordinary failure tolerance", () => {
    const manager = SessionManager.inMemory();
    vi.spyOn(manager, "getEntries").mockImplementation(() => {
      throw new Error("legacy unavailable view");
    });
    vi.spyOn(manager, "appendCustomEntry").mockImplementation(() => {
      throw new Error("legacy persistence failure");
    });
    const replay = createProviderReplaySessionState(manager);

    expect(replay.state.getCustomEntries()).toEqual([]);
    expect(() => replay.state.appendCustomEntry("fixture", {})).not.toThrow();
    replay.close();
  });
});
