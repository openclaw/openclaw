// Browser tests cover register.navigation plugin behavior.
import { Command } from "commander";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserProgram,
  getBrowserCliRuntime,
  getBrowserCliRuntimeCapture,
  mockBrowserGateway,
} from "../browser-cli.test-support.js";

const gatewayMock = mockBrowserGateway();
const browserCliRuntime = getBrowserCliRuntime();
vi.spyOn(defaultRuntime, "log").mockImplementation(browserCliRuntime.log);
vi.spyOn(defaultRuntime, "writeJson").mockImplementation(browserCliRuntime.writeJson);
vi.spyOn(defaultRuntime, "error").mockImplementation(browserCliRuntime.error);
vi.spyOn(defaultRuntime, "exit").mockImplementation(browserCliRuntime.exit);

const { registerBrowserNavigationCommands } = await import("./register.navigation.js");

function createNavigationProgram(): Command {
  const { program, browser, parentOpts } = createBrowserProgram();
  browser.option("--timeout <ms>", "Timeout in ms", "30000");
  registerBrowserNavigationCommands(browser, parentOpts);
  return program;
}

describe("browser navigation commands", () => {
  beforeEach(() => {
    gatewayMock.mockClear();
    gatewayMock.mockResolvedValue({ url: "https://example.test/landing" });
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
  });

  it.each(["30000", "60000"])(
    "sends navigate requests with the URL, target id, and inherited %s ms timeout",
    async (timeout) => {
      const program = createNavigationProgram();
      const parentArgs = timeout === "30000" ? [] : ["--timeout", timeout];

      await program.parseAsync(
        ["browser", ...parentArgs, "navigate", "https://example.test/page", "--target-id", "tab-1"],
        { from: "user" },
      );

      expect(gatewayMock).toHaveBeenLastCalledWith(
        "browser.request",
        expect.objectContaining({ timeout: String(Number(timeout) + 10_000) }),
        expect.objectContaining({
          method: "POST",
          path: "/navigate",
          body: { url: "https://example.test/page", targetId: "tab-1" },
          timeoutMs: Number(timeout),
        }),
        expect.objectContaining({ scopes: ["operator.admin"] }),
      );
      expect(getBrowserCliRuntimeCapture().runtimeLogs).toContain(
        "navigated to https://example.test/landing",
      );
    },
  );

  it("sends normalized resize dimensions and target id with the inherited timeout", async () => {
    const program = createNavigationProgram();

    await program.parseAsync(
      [
        "browser",
        "--timeout",
        "60000",
        "--browser-profile",
        "work",
        "resize",
        "1024",
        "768",
        "--target-id",
        "tab-2",
      ],
      {
        from: "user",
      },
    );

    expect(gatewayMock).toHaveBeenLastCalledWith(
      "browser.request",
      expect.objectContaining({ timeout: "70000" }),
      expect.objectContaining({
        method: "POST",
        path: "/act",
        query: { profile: "work" },
        body: { kind: "resize", width: 1024, height: 768, targetId: "tab-2" },
        timeoutMs: 60000,
      }),
      expect.objectContaining({ scopes: ["operator.admin"] }),
    );
    expect(getBrowserCliRuntimeCapture().runtimeLogs).toContain("resized to 1024x768");
  });

  it("rejects non-decimal resize dimensions before dispatch", async () => {
    const program = createNavigationProgram();

    await expect(
      program.parseAsync(["browser", "resize", "1e3", "768"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    const capture = getBrowserCliRuntimeCapture();
    expect(capture.runtimeErrors.join("\n")).toContain("Invalid width: must be a positive integer");
    expect(gatewayMock).not.toHaveBeenCalled();
  });

  it("rejects excessive resize dimensions before dispatch", async () => {
    const program = createNavigationProgram();

    await expect(
      program.parseAsync(["browser", "resize", "8193", "768"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    const capture = getBrowserCliRuntimeCapture();
    expect(capture.runtimeErrors.join("\n")).toContain("Invalid width: maximum is 8192");
    expect(gatewayMock).not.toHaveBeenCalled();
  });

  it("navigate and resize commands are registered after removing dead import (#83878)", async () => {
    const program = createNavigationProgram();
    const browserCmd = program.commands.find((c) => c.name() === "browser");
    expect(browserCmd).toBeDefined();

    const cmds = browserCmd!.commands.map((c) => c.name());
    expect(cmds).toContain("resize");
    expect(cmds).toContain("navigate");

    // Verify the shared module still exports requireRef (used by other modules)
    const shared = await import("./shared.js");
    expect(typeof shared.requireRef).toBe("function");
  });
});
