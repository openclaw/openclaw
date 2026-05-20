import { beforeEach, describe, expect, it } from "vitest";
import { getBrowserCliRuntime } from "../browser-cli.test-support.js";
import {
  createActionInputProgram,
  getActionInputResizeMock,
  getLastActionInputOptions,
  getLastActionInputRequest,
  resetActionInputTestState,
} from "./register.test-helpers.js";

describe("browser action input navigation commands", () => {
  beforeEach(() => {
    resetActionInputTestState();
  });

  it("sends navigate requests with URL, target, profile, and timeout", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(
      [
        "browser",
        "--browser-profile",
        "work",
        "navigate",
        "https://example.test",
        "--target-id",
        "tab-1",
      ],
      { from: "user" },
    );

    expect(getLastActionInputRequest()).toMatchObject({
      method: "POST",
      path: "/navigate",
      query: { profile: "work" },
      body: {
        url: "https://example.test",
        targetId: "tab-1",
      },
    });
    expect(getLastActionInputOptions()?.timeoutMs).toBe(20000);
    expect(getBrowserCliRuntime().log).toHaveBeenCalledWith(
      "navigated to https://example.test/after-navigation",
    );
  });

  it("passes resize dimensions, target, profile, and timeout to the resize runner", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(
      ["browser", "--browser-profile", "work", "resize", "1280", "720", "--target-id", "tab-2"],
      { from: "user" },
    );

    expect(getActionInputResizeMock()).toHaveBeenCalledWith({
      parent: expect.objectContaining({ browserProfile: "work" }),
      profile: "work",
      width: 1280,
      height: 720,
      targetId: "tab-2",
      timeoutMs: 20000,
      successMessage: "resized to 1280x720",
    });
  });
});
