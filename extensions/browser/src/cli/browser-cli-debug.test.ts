import { beforeEach, describe, expect, it } from "vitest";
import {
  createBrowserProgram,
  mockBrowserGateway,
  mockBrowserCliRuntime,
  getBrowserCliRuntimeCapture,
} from "./browser-cli.test-support.js";

const gatewayMock = mockBrowserGateway();
mockBrowserCliRuntime();

const { registerBrowserDebugCommands } = await import("./browser-cli-debug.js");

describe("browser debug command timeouts", () => {
  beforeEach(() => {
    gatewayMock.mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
  });

  it.each([
    { args: ["highlight", "e1"], path: "/highlight" },
    { args: ["errors"], path: "/errors" },
    { args: ["requests"], path: "/requests" },
    { args: ["trace", "start"], path: "/trace/start" },
    { args: ["trace", "stop", "--out", " trace.zip "], path: "/trace/stop" },
  ])("inherits the parent timeout for $path", async ({ args, path }) => {
    for (const timeout of ["30000", "60000"]) {
      const { program, browser, parentOpts } = createBrowserProgram();
      browser.option("--timeout <ms>", "Timeout in ms", "30000");
      registerBrowserDebugCommands(browser, parentOpts);
      const parentArgs = timeout === "30000" ? ["--json"] : ["--json", "--timeout", timeout];

      await program.parseAsync(["browser", ...parentArgs, ...args], { from: "user" });

      expect(gatewayMock).toHaveBeenLastCalledWith(
        "browser.request",
        expect.objectContaining({ timeout: String(Number(timeout) + 130_000) }),
        expect.objectContaining({ path, timeoutMs: Number(timeout) }),
        expect.objectContaining({ scopes: ["operator.admin"] }),
      );
      if (path === "/trace/stop") {
        expect(gatewayMock.mock.calls.at(-1)?.[2].body).toMatchObject({ path: " trace.zip " });
      }
    }
  });
});
