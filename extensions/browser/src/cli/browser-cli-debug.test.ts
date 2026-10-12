import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserProgram,
  mockBrowserGateway,
  getBrowserCliRuntime,
  getBrowserCliRuntimeCapture,
} from "./browser-cli.test-support.js";

const gatewayMock = mockBrowserGateway();
const browserCliRuntime = getBrowserCliRuntime();
vi.spyOn(defaultRuntime, "writeJson").mockImplementation(browserCliRuntime.writeJson);
vi.spyOn(defaultRuntime, "error").mockImplementation(browserCliRuntime.error);
vi.spyOn(defaultRuntime, "exit").mockImplementation(browserCliRuntime.exit);

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
    { args: ["trace", "stop"], path: "/trace/stop" },
  ])("inherits the parent timeout for $path", async ({ args, path }) => {
    for (const timeout of ["30000", "60000"]) {
      const { program, browser, parentOpts } = createBrowserProgram();
      browser.option("--timeout <ms>", "Timeout in ms", "30000");
      registerBrowserDebugCommands(browser, parentOpts);
      const parentArgs = timeout === "30000" ? ["--json"] : ["--json", "--timeout", timeout];

      await program.parseAsync(["browser", ...parentArgs, ...args], { from: "user" });

      expect(gatewayMock).toHaveBeenLastCalledWith(
        "browser.request",
        expect.objectContaining({ timeout: String(Number(timeout) + 10_000) }),
        expect.objectContaining({ path, timeoutMs: Number(timeout) }),
        expect.objectContaining({ scopes: ["operator.admin"] }),
      );
    }
  });
});
