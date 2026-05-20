import type { Command } from "commander";
import { vi } from "vitest";
import * as browserCliResizeModule from "../browser-cli-resize.js";
import * as browserCliSharedModule from "../browser-cli-shared.js";
import {
  createBrowserProgram,
  getBrowserCliRuntime,
  getBrowserCliRuntimeCapture,
} from "../browser-cli.test-support.js";
import * as cliCoreApiModule from "../core-api.js";

export type BrowserActionRequest = Parameters<typeof browserCliSharedModule.callBrowserRequest>[1];

export type BrowserActionRuntimeOptions = Parameters<
  typeof browserCliSharedModule.callBrowserRequest
>[2];

type BrowserActionCall = [
  unknown,
  BrowserActionRequest | undefined,
  BrowserActionRuntimeOptions | undefined,
];

const actionInputMocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn<
    (
      _opts?: unknown,
      _req?: BrowserActionRequest,
      _extra?: BrowserActionRuntimeOptions,
    ) => Promise<Record<string, unknown>>
  >(async (_opts, req) => ({
    download: { path: "/tmp/openclaw/downloads/file.txt" },
    ok: true,
    result: true,
    url:
      req?.path === "/navigate"
        ? "https://example.test/after-navigation"
        : "https://example.test/after-action",
  })),
  runBrowserResizeWithOutput: vi.fn(async (_params: unknown) => {}),
}));

vi.spyOn(browserCliSharedModule, "callBrowserRequest").mockImplementation(
  actionInputMocks.callBrowserRequest,
);
vi.spyOn(browserCliResizeModule, "runBrowserResizeWithOutput").mockImplementation(
  actionInputMocks.runBrowserResizeWithOutput,
);

const browserCliRuntime = getBrowserCliRuntime();
vi.spyOn(cliCoreApiModule.defaultRuntime, "log").mockImplementation(browserCliRuntime.log);
vi.spyOn(cliCoreApiModule.defaultRuntime, "writeJson").mockImplementation(
  browserCliRuntime.writeJson,
);
vi.spyOn(cliCoreApiModule.defaultRuntime, "writeStdout").mockImplementation(
  browserCliRuntime.writeStdout,
);
vi.spyOn(cliCoreApiModule.defaultRuntime, "error").mockImplementation(browserCliRuntime.error);
vi.spyOn(cliCoreApiModule.defaultRuntime, "exit").mockImplementation(browserCliRuntime.exit);

const { registerBrowserActionInputCommands } = await import("./register.js");

export function createActionInputProgram(): Command {
  const { program, browser, parentOpts } = createBrowserProgram();
  registerBrowserActionInputCommands(browser, parentOpts);
  return program;
}

export function getActionInputCallBrowserRequestMock() {
  return actionInputMocks.callBrowserRequest;
}

export function getActionInputResizeMock() {
  return actionInputMocks.runBrowserResizeWithOutput;
}

export function getLastActionInputRequest(): BrowserActionRequest {
  const call = actionInputMocks.callBrowserRequest.mock.calls.at(-1) as
    | BrowserActionCall
    | undefined;
  if (!call) {
    throw new Error("expected browser request call");
  }
  if (!call[1]) {
    throw new Error("expected browser request params");
  }
  return call[1];
}

export function getLastActionInputOptions(): BrowserActionRuntimeOptions | undefined {
  return (
    actionInputMocks.callBrowserRequest.mock.calls.at(-1) as BrowserActionCall | undefined
  )?.[2];
}

export function resetActionInputTestState() {
  actionInputMocks.callBrowserRequest.mockClear();
  actionInputMocks.runBrowserResizeWithOutput.mockClear();
  getBrowserCliRuntimeCapture().resetRuntimeCapture();

  const runtime = getBrowserCliRuntime();
  runtime.log.mockClear();
  runtime.error.mockClear();
  runtime.exit.mockClear();
  runtime.writeJson.mockClear();
  runtime.writeStdout.mockClear();
  runtime.exit.mockImplementation(() => {});
}
