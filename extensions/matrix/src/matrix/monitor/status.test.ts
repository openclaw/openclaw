import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { expect, it, vi } from "vitest";
import { createMatrixMonitorStatusController } from "./status.js";

it("preserves an invalidated-token diagnosis through cleanup until healthy sync", () => {
  const setStatus = vi.fn<(snapshot: ChannelAccountSnapshot) => void>();
  const status = createMatrixMonitorStatusController({
    accountId: "default",
    statusSink: setStatus,
  });
  const blocked = { lifecycle: "blocked", terminalDisconnect: true, lastError: "Unknown token" };
  const tokenError = Object.assign(new Error("Unknown token"), {
    statusCode: 401,
    data: { errcode: "M_UNKNOWN_TOKEN" },
  });

  status.noteSyncState("RECONNECTING", tokenError);
  expect(setStatus).toHaveBeenLastCalledWith(expect.objectContaining(blocked));
  status.noteUnexpectedError(new Error("startup readiness timed out"));
  expect(setStatus).toHaveBeenLastCalledWith(expect.objectContaining(blocked));
  status.markStopped();
  expect(setStatus).toHaveBeenLastCalledWith(expect.objectContaining(blocked));
  status.noteSyncState("SYNCING", undefined);
  expect(setStatus).toHaveBeenLastCalledWith(
    expect.objectContaining({ lifecycle: "ready", terminalDisconnect: undefined }),
  );
});
