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

const request = vi.spyOn(shared, "callBrowserRequest").mockResolvedValue({ ok: true });
const runtime = getBrowserCliRuntime();
vi.spyOn(defaultRuntime, "writeJson").mockImplementation(runtime.writeJson);
vi.spyOn(defaultRuntime, "error").mockImplementation(runtime.error);
vi.spyOn(defaultRuntime, "exit").mockImplementation(runtime.exit);
describe("WebMCP CLI", () => {
  beforeEach(() => {
    request.mockClear();
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
});
