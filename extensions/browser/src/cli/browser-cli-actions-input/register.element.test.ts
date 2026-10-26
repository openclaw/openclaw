import { beforeEach, describe, expect, it, vi } from "vitest";
import * as browserCliSharedModule from "../browser-cli-shared.js";
import {
  createBrowserProgram,
  mockBrowserCliRuntime,
  getBrowserCliRuntimeCapture,
} from "../browser-cli.test-support.js";

const mocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn<
    typeof browserCliSharedModule.callBrowserRequest<Record<string, unknown>>
  >(async () => ({ url: "https://example.test" })),
}));

vi.spyOn(browserCliSharedModule, "callBrowserRequest").mockImplementation(mocks.callBrowserRequest);
mockBrowserCliRuntime();

const { registerBrowserActionInputCommands } = await import("./register.js");

function run(...args: string[]) {
  const { program, browser, parentOpts } = createBrowserProgram();
  browser.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerBrowserActionInputCommands(browser, parentOpts);
  return program.parseAsync(["browser", ...args], { from: "user" });
}

function getLastActionBody(): Record<string, unknown> | undefined {
  return (mocks.callBrowserRequest.mock.calls.at(-1)?.[1] as { body?: Record<string, unknown> })
    ?.body;
}

describe("browser element commands", () => {
  beforeEach(() => {
    mocks.callBrowserRequest.mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
  });

  it.each([
    [
      [
        "--browser-profile",
        "user",
        "click",
        " ref-1 ",
        "--target-id",
        "tab-1",
        "--double",
        "--button",
        "right",
        "--modifiers",
        "Shift, Alt",
      ],
      {
        kind: "click",
        ref: "ref-1",
        targetId: "tab-1",
        doubleClick: true,
        button: "right",
        modifiers: ["Shift", "Alt"],
      },
    ],
    [
      [
        "click-coords",
        "12.5",
        "42",
        "--target-id",
        "tab-2",
        "--double",
        "--button",
        "middle",
        "--delay-ms",
        "25",
      ],
      {
        kind: "clickCoords",
        x: 12.5,
        y: 42,
        targetId: "tab-2",
        doubleClick: true,
        button: "middle",
        delayMs: 25,
      },
    ],
    [
      ["type", "input-1", "hello", "--submit", "--slowly", "--target-id", "tab-2"],
      {
        kind: "type",
        ref: "input-1",
        text: "hello",
        submit: true,
        slowly: true,
        targetId: "tab-2",
      },
    ],
    [
      ["hover", "node-1", "--target-id", "tab-4"],
      { kind: "hover", ref: "node-1", targetId: "tab-4" },
    ],
    [
      ["drag", "start-1", "end-1", "--target-id", "tab-6"],
      { kind: "drag", startRef: "start-1", endRef: "end-1", targetId: "tab-6" },
    ],
    [
      ["select", "select-1", "alpha", "beta", "--target-id", "tab-7"],
      { kind: "select", ref: "select-1", values: ["alpha", "beta"], targetId: "tab-7" },
    ],
  ] satisfies [string[], Record<string, unknown>][])(
    "sends the expected action body for %j",
    async (argv, expectedBody) => {
      await run(...argv);
      expect(getLastActionBody()).toMatchObject(expectedBody);
      expect(mocks.callBrowserRequest.mock.calls.at(-1)?.[2]).toEqual({ timeoutMs: 126_250 });
    },
  );

  it("rejects a blank required ref before dispatch", async () => {
    await expect(run("click", "   ")).rejects.toThrow("ref is required");

    const capture = getBrowserCliRuntimeCapture();
    expect(capture.runtimeErrors).toEqual([]);
    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
  });

  it("rejects an invalid --button for click-coords before dispatch", async () => {
    await expect(run("click-coords", "10", "20", "--button", "Left")).rejects.toMatchObject({
      code: "commander.invalidArgument",
      exitCode: 1,
    });

    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
  });

  it("leaves button undefined for click when omitted", async () => {
    await run("click", "ref-1");
    expect(getLastActionBody()?.button).toBeUndefined();
  });

  it("rejects non-decimal coordinate values before dispatch", async () => {
    await expect(run("click-coords", "0x10", "20")).rejects.toThrow(
      "Invalid x: must be a finite number",
    );

    const capture = getBrowserCliRuntimeCapture();
    expect(capture.runtimeErrors).toEqual([]);
    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
  });

  it("accepts signed and zero-padded integer action options", async () => {
    await run("click-coords", "10", "20", "--delay-ms", "+0005");
    expect(getLastActionBody()?.delayMs).toBe(5);
    await run("scrollintoview", "ref-1", "--timeout-ms", "+020000");
    expect(getLastActionBody()?.timeoutMs).toBe(20_000);
    expect(mocks.callBrowserRequest.mock.calls.at(-1)?.[2]?.timeoutMs).toBe(126_250);
  });
});
