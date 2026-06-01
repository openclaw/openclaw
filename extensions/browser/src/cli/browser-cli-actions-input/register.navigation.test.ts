import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as browserCliResizeModule from "../browser-cli-resize.js";
import * as browserCliSharedModule from "../browser-cli-shared.js";
import {
  createBrowserProgram,
  getBrowserCliRuntime,
  getBrowserCliRuntimeCapture,
} from "../browser-cli.test-support.js";
import * as cliCoreApiModule from "../core-api.js";

const mocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn(async () => ({ url: "https://example.test/app" })),
  runBrowserResizeWithOutput: vi.fn(async () => {}),
}));

vi.spyOn(browserCliSharedModule, "callBrowserRequest").mockImplementation(mocks.callBrowserRequest);
vi.spyOn(browserCliResizeModule, "runBrowserResizeWithOutput").mockImplementation(
  mocks.runBrowserResizeWithOutput,
);
const browserCliRuntime = getBrowserCliRuntime();
vi.spyOn(cliCoreApiModule.defaultRuntime, "log").mockImplementation(browserCliRuntime.log);
vi.spyOn(cliCoreApiModule.defaultRuntime, "writeJson").mockImplementation(
  browserCliRuntime.writeJson,
);
vi.spyOn(cliCoreApiModule.defaultRuntime, "error").mockImplementation(browserCliRuntime.error);
vi.spyOn(cliCoreApiModule.defaultRuntime, "exit").mockImplementation(browserCliRuntime.exit);

const { registerBrowserNavigationCommands } = await import("./register.navigation.js");

function createNavigationProgram(): Command {
  const { program, browser, parentOpts } = createBrowserProgram();
  registerBrowserNavigationCommands(browser, parentOpts);
  return program;
}

describe("browser navigation commands", () => {
  beforeEach(() => {
    mocks.callBrowserRequest.mockClear();
    mocks.runBrowserResizeWithOutput.mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
  });

  it("sends navigate requests with target and profile context", async () => {
    const program = createNavigationProgram();

    await program.parseAsync(
      [
        "browser",
        "--browser-profile",
        "qa",
        "navigate",
        "https://example.test/app",
        "--target-id",
        "tab-main",
      ],
      { from: "user" },
    );

    expect(mocks.callBrowserRequest).toHaveBeenCalledWith(
      expect.objectContaining({ browserProfile: "qa" }),
      {
        method: "POST",
        path: "/navigate",
        query: { profile: "qa" },
        body: {
          url: "https://example.test/app",
          targetId: "tab-main",
        },
      },
      { timeoutMs: 20000 },
    );
  });

  it("passes normalized resize dimensions into the resize runner", async () => {
    const program = createNavigationProgram();

    await program.parseAsync(
      ["browser", "--browser-profile", "qa", "resize", "+01280", "0720", "--target-id", "tab-main"],
      { from: "user" },
    );

    expect(mocks.runBrowserResizeWithOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: expect.objectContaining({ browserProfile: "qa" }),
        profile: "qa",
        width: 1280,
        height: 720,
        targetId: "tab-main",
        timeoutMs: 20000,
        successMessage: "resized to 1280x720",
      }),
    );
  });

  it("rejects non-decimal resize dimensions before dispatch", async () => {
    const program = createNavigationProgram();

    await expect(
      program.parseAsync(["browser", "resize", "1e3", "768"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    const capture = getBrowserCliRuntimeCapture();
    expect(capture.runtimeErrors.join("\n")).toContain("Invalid width: must be a positive integer");
    expect(mocks.runBrowserResizeWithOutput).not.toHaveBeenCalled();
  });

  it("rejects excessive resize dimensions before dispatch", async () => {
    const program = createNavigationProgram();

    await expect(
      program.parseAsync(["browser", "resize", "8193", "768"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    const capture = getBrowserCliRuntimeCapture();
    expect(capture.runtimeErrors.join("\n")).toContain("Invalid width: maximum is 8192");
    expect(mocks.runBrowserResizeWithOutput).not.toHaveBeenCalled();
  });
});
