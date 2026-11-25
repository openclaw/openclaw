import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import "./server-context.chrome-test-harness.js";
import * as chrome from "./chrome.js";
import { createBrowserRouteContext } from "./server-context.js";
import { makeBrowserServerState } from "./server-context.test-harness.js";
import { movePathToTrash } from "./trash.js";

vi.mock("./trash.js", () => ({
  movePathToTrash: vi.fn(async (targetPath: string) => targetPath),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(chrome.stopOwnedOpenClawChrome).mockResolvedValue({ status: "not-running" });
});

function createResetHarness() {
  const userDataDir = path.join(tempDirs.make("browser-reset-"), "user-data");
  fs.mkdirSync(userDataDir);
  vi.mocked(chrome.resolveOpenClawUserDataDir).mockReturnValue(userDataDir);
  const state = makeBrowserServerState();
  const profile = createBrowserRouteContext({ getState: () => state }).forProfile();
  return { profile, state, userDataDir };
}

describe("managed browser profile reset", () => {
  it("stops a browser from an earlier runtime before moving its profile data", async () => {
    const { profile, state, userDataDir } = createResetHarness();
    const resolved = state.resolved;
    const order: string[] = [];
    vi.mocked(chrome.stopOwnedOpenClawChrome).mockImplementationOnce(async () => {
      order.push("stop");
      return { status: "stopped" };
    });
    vi.mocked(movePathToTrash).mockImplementationOnce(async (targetPath) => {
      order.push("trash");
      return targetPath;
    });

    const resetting = profile.resetProfile();
    state.resolved = { ...resolved, executablePath: "/replacement/chrome" };
    await expect(resetting).resolves.toMatchObject({ moved: true, from: userDataDir });

    expect(chrome.stopOwnedOpenClawChrome).toHaveBeenCalledWith(resolved, profile.profile);
    expect(order).toEqual(["stop", "trash"]);
    expect(chrome.stopOpenClawChrome).not.toHaveBeenCalled();
  });

  it("preserves data after uncertain shutdown and allows a later reset to finish cleanup", async () => {
    const { profile, userDataDir } = createResetHarness();
    vi.mocked(chrome.stopOwnedOpenClawChrome).mockResolvedValueOnce({
      status: "unverified",
      reason: "managed process identity changed",
    });

    await expect(profile.resetProfile()).rejects.toThrow("managed process identity changed");

    expect(movePathToTrash).not.toHaveBeenCalled();
    expect(fs.existsSync(userDataDir)).toBe(true);

    await expect(profile.resetProfile()).resolves.toMatchObject({ moved: true });
    expect(movePathToTrash).toHaveBeenCalledExactlyOnceWith(userDataDir);
  });
});
