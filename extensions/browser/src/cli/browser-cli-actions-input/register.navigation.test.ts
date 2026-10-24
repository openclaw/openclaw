import { beforeEach, describe, expect, it } from "vitest";
import {
  createBrowserProgram,
  mockBrowserCliRuntime,
  getBrowserCliRuntimeCapture,
  mockBrowserGateway,
} from "../browser-cli.test-support.js";

const gatewayMock = mockBrowserGateway();
const capture = getBrowserCliRuntimeCapture();
mockBrowserCliRuntime();

const { registerBrowserActionInputCommands } = await import("./register.js");

function run(...args: string[]) {
  const { program, browser, parentOpts } = createBrowserProgram();
  browser.option("--timeout <ms>", "Timeout in ms", "30000");
  registerBrowserActionInputCommands(browser, parentOpts);
  return program.parseAsync(["browser", ...args], { from: "user" });
}

describe("browser navigation commands", () => {
  beforeEach(() => {
    gatewayMock.mockClear();
    gatewayMock.mockResolvedValue({ url: "https://example.test/landing" });
    capture.resetRuntimeCapture();
  });

  it.each(["30000", "60000"])(
    "sends navigate requests with the URL, target id, and inherited %s ms timeout",
    async (timeout) => {
      const parentArgs = timeout === "30000" ? [] : ["--timeout", timeout];

      await run(...parentArgs, "navigate", "https://example.test/page", "--target-id", "tab-1");

      expect(gatewayMock).toHaveBeenLastCalledWith(
        "browser.request",
        expect.objectContaining({ timeout: String(Number(timeout) + 130_000) }),
        expect.objectContaining({
          method: "POST",
          path: "/navigate",
          body: { url: "https://example.test/page", targetId: "tab-1" },
          timeoutMs: Number(timeout),
        }),
        expect.objectContaining({ scopes: ["operator.admin"] }),
      );
      expect(capture.runtimeLogs).toContain("navigated to https://example.test/landing");
    },
  );

  it("sends normalized resize dimensions and target id with the inherited timeout", async () => {
    await run(
      "--timeout=60000",
      "--browser-profile=work",
      "resize",
      "1024",
      "768",
      "--target-id=tab-2",
    );

    expect(gatewayMock).toHaveBeenLastCalledWith(
      "browser.request",
      expect.objectContaining({ timeout: "190000" }),
      expect.objectContaining({
        method: "POST",
        path: "/act",
        query: { profile: "work" },
        body: { kind: "resize", width: 1024, height: 768, targetId: "tab-2" },
        timeoutMs: 60000,
      }),
      expect.objectContaining({ scopes: ["operator.admin"] }),
    );
    expect(capture.runtimeLogs).toContain("resized to 1024x768");
  });

  it.each([
    ["1e3", "must be a positive integer"],
    ["8193", "maximum is 8192"],
  ])("rejects invalid resize width %s before dispatch", async (width, error) => {
    await expect(run("resize", width, "768")).rejects.toThrow("__exit__:1");
    expect(capture.runtimeErrors.join("\n")).toContain(`Invalid width: ${error}`);
    expect(gatewayMock).not.toHaveBeenCalled();
  });
});
