/**
 * Test helpers for Browser CLI manage command suites.
 */
import type { Command } from "commander";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { vi } from "vitest";
import { mockBrowserGateway } from "./browser-cli.test-support.js";

const gatewayMock = mockBrowserGateway();
gatewayMock.mockImplementation(async (_method, _opts, request) =>
  request.path === "/"
    ? {
        enabled: true,
        running: true,
        pid: 1,
        cdpPort: 18800,
        chosenBrowser: "chrome",
        userDataDir: "/tmp/openclaw",
        color: "blue",
        headless: true,
        attachOnly: false,
      }
    : {},
);

const { createBrowserProgram, getBrowserCliRuntime } =
  await import("./browser-cli.test-support.js");
const browserCliRuntime = getBrowserCliRuntime();
vi.spyOn(defaultRuntime, "log").mockImplementation(browserCliRuntime.log);
vi.spyOn(defaultRuntime, "writeJson").mockImplementation(browserCliRuntime.writeJson);
vi.spyOn(defaultRuntime, "error").mockImplementation(browserCliRuntime.error);
vi.spyOn(defaultRuntime, "exit").mockImplementation(browserCliRuntime.exit);

const { registerBrowserManageCommands } = await import("./browser-cli-manage.js");

/** Creates a Browser CLI program with manage commands registered. */
export function createBrowserManageProgram(params?: { withParentTimeout?: boolean }): Command {
  const { program, browser, parentOpts } = createBrowserProgram();
  if (params?.withParentTimeout) {
    browser.option("--timeout <ms>", "Timeout in ms", "30000");
  }
  registerBrowserManageCommands(browser, parentOpts);
  return program;
}

/** Returns the Gateway mock used by manage command tests. */
export function getBrowserManageGatewayMock() {
  return gatewayMock;
}

/** Finds the first mocked Browser manage request for a route path. */
export function findBrowserManageCall(path: string) {
  return gatewayMock.mock.calls.find((call) => call[2].path === path);
}
