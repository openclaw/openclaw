import { describe, expect, it, vi } from "vitest";
import {
  IncognitoSessionEndedError,
  IncognitoSessionSyncAccessError,
} from "../../state/incognito-session-error.js";
import { SessionManager } from "../sessions/session-manager.js";
import { createProviderReplaySessionState } from "./replay-session-state.js";

describe("awaited provider replay session state", () => {
  it("returns the accepted entry when the adapter closes after append settlement", async () => {
    const manager = SessionManager.inMemory();
    const replay = createProviderReplaySessionState(manager);
    const append = manager.appendCustomEntryAsync.bind(manager);
    const appendSpy = vi
      .spyOn(manager, "appendCustomEntryAsync")
      .mockImplementation(async (customType, data) => {
        const id = await append(customType, data);
        replay.close();
        return id;
      });
    try {
      const outcome = await replay.state.appendCustomEntryAsync("fixture", { retained: true }).then(
        (id) => ({ id }),
        (error: unknown) => ({ error }),
      );
      const entry = manager.getEntries().find((candidate) => candidate.type === "custom");
      expect(entry).toMatchObject({
        type: "custom",
        customType: "fixture",
        data: { retained: true },
      });
      expect(outcome).toEqual({ id: entry?.id });
    } finally {
      appendSpy.mockRestore();
      replay.close();
    }
  });

  it("rejects a new append after the adapter closes", async () => {
    const manager = SessionManager.inMemory();
    const replay = createProviderReplaySessionState(manager);
    replay.close();

    await expect(
      replay.state.appendCustomEntryAsync("fixture", { retained: true }),
    ).rejects.toThrow("Provider replay session state is no longer active");
    expect(manager.getEntries()).toEqual([]);
  });
});

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
