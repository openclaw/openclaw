import { expect, it, vi } from "vitest";
import { createStandingNavigationPolicy } from "./pw-session-navigation-standing.js";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("openclaw/plugin-sdk/logging-core", () => ({
  createSubsystemLogger: () => ({ child: () => ({ warn }) }),
}));

it("still denies a document when the first-denial warning cannot be written", async () => {
  warn.mockImplementation(() => {
    throw new Error("No safe OpenClaw temp root is available");
  });
  const standing = createStandingNavigationPolicy();
  standing.set({ standingSsrfPolicy: { dangerouslyAllowPrivateNetwork: false } });
  await expect(
    standing.denial({
      url: "http://127.0.0.1:4000/private",
      headers: {},
      frameId: "main",
      mainFrameId: "main",
    }),
  ).resolves.toBe("BlockedByClient");
  expect(warn).toHaveBeenCalledOnce();
});
