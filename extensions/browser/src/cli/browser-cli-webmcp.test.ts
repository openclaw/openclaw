import { beforeEach, describe, expect, it, vi } from "vitest";
import { isBrowserMachineOutput } from "../../cli-output-mode.js";
import * as shared from "./browser-cli-shared.js";
import { registerBrowserWebMcpCommands } from "./browser-cli-webmcp.js";
import {
  createBrowserProgram,
  getBrowserCliRuntime,
  getBrowserCliRuntimeCapture,
} from "./browser-cli.test-support.js";
import { defaultRuntime } from "./core-api.js";

const actualRequest = shared.callBrowserRequest;
const request = vi.spyOn(shared, "callBrowserRequest").mockResolvedValue({ ok: true });
const runtime = getBrowserCliRuntime();
vi.spyOn(defaultRuntime, "writeJson").mockImplementation(runtime.writeJson);
vi.spyOn(defaultRuntime, "error").mockImplementation(runtime.error);
vi.spyOn(defaultRuntime, "exit").mockImplementation(runtime.exit);
describe("WebMCP CLI", () => {
  beforeEach(() => {
    request.mockReset().mockResolvedValue({ ok: true });
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
  });
  it.each(["list", "execute"])("routes %s with the selected profile and target", async (action) => {
    const { program, browser, parentOpts } = createBrowserProgram();
    registerBrowserWebMcpCommands(browser, parentOpts);
    const args = [
      "browser",
      "--browser-profile",
      "isolated",
      `webmcp_${action}`,
      "--target-id",
      "tab-a",
      ...(action === "execute"
        ? ["--context-id", "doc-a", "--tool-name", "increment_counter", "--input", '{"amount":2}']
        : []),
    ];
    await program.parseAsync(args, { from: "user" });
    expect(request).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        path: `/webmcp/${action}`,
        query: { profile: "isolated" },
        body: expect.objectContaining({
          targetId: "tab-a",
          ...(action === "execute"
            ? { contextId: "doc-a", toolName: "increment_counter", input: { amount: 2 } }
            : {}),
        }),
      }),
      { timeoutMs: undefined },
    );
    expect(isBrowserMachineOutput({ argv: ["node", "openclaw", ...args] })).toBe(true);
  });
  it("rejects non-object JSON before sending a request", async () => {
    const { program, browser, parentOpts } = createBrowserProgram();
    registerBrowserWebMcpCommands(browser, parentOpts);
    await expect(
      program.parseAsync(
        [
          "browser",
          "webmcp_execute",
          "--target-id",
          "a",
          "--context-id",
          "d",
          "--tool-name",
          "t",
          "--input",
          "[]",
        ],
        { from: "user" },
      ),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("reports unknown execution outcome when the Gateway response is lost", async () => {
    const { program, browser, parentOpts } = createBrowserProgram();
    registerBrowserWebMcpCommands(browser, parentOpts);
    request.mockRejectedValueOnce(new Error("timed out. Retry the browser tool once."));
    await expect(
      program.parseAsync(
        [
          "browser",
          "webmcp_execute",
          "--target-id",
          "tab",
          "--context-id",
          "document",
          "--tool-name",
          "increment_counter",
        ],
        { from: "user" },
      ),
    ).rejects.toThrow();
    expect(defaultRuntime.error).toHaveBeenLastCalledWith(
      expect.stringContaining(
        "WebMCP execution outcome unknown. Inspect the page before retrying.",
      ),
    );
    expect(defaultRuntime.error).not.toHaveBeenLastCalledWith(
      expect.stringContaining("Retry the browser tool once"),
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("keeps invalid CLI timeout errors specific and does not dispatch", async () => {
    const { program, browser, parentOpts } = createBrowserProgram();
    browser.option("--timeout <ms>", "Gateway timeout");
    registerBrowserWebMcpCommands(browser, parentOpts);
    request.mockImplementationOnce(actualRequest);
    await expect(
      program.parseAsync(
        [
          "browser",
          "--timeout",
          "invalid",
          "webmcp_execute",
          "--target-id",
          "tab",
          "--context-id",
          "document",
          "--tool-name",
          "increment_counter",
        ],
        { from: "user" },
      ),
    ).rejects.toThrow();
    expect(defaultRuntime.error).toHaveBeenLastCalledWith(
      expect.stringContaining("--timeout must be a positive integer"),
    );
    expect(request).not.toHaveBeenCalled();
  });
});
