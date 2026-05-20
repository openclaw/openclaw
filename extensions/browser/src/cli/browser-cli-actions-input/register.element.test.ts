import { beforeEach, describe, expect, it } from "vitest";
import { getBrowserCliRuntime } from "../browser-cli.test-support.js";
import {
  createActionInputProgram,
  getActionInputCallBrowserRequestMock,
  getLastActionInputOptions,
  getLastActionInputRequest,
  resetActionInputTestState,
} from "./register.test-helpers.js";

describe("browser action input element commands", () => {
  beforeEach(() => {
    resetActionInputTestState();
  });

  it("sends click bodies with ref, modifiers, target, and profile", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(
      [
        "browser",
        "--browser-profile",
        "work",
        "click",
        "ref-1",
        "--target-id",
        "tab-1",
        "--double",
        "--button",
        "right",
        "--modifiers",
        "Shift, Alt,,",
      ],
      { from: "user" },
    );

    expect(getLastActionInputRequest()).toMatchObject({
      method: "POST",
      path: "/act",
      query: { profile: "work" },
      body: {
        kind: "click",
        ref: "ref-1",
        targetId: "tab-1",
        doubleClick: true,
        button: "right",
        modifiers: ["Shift", "Alt"],
      },
    });
  });

  it.each([
    { command: "click", argv: ["browser", "click", "   "] },
    { command: "type", argv: ["browser", "type", "   ", "hello"] },
    { command: "scrollintoview", argv: ["browser", "scrollintoview", "   "] },
  ])("rejects blank $command refs before sending a browser action", async ({ argv }) => {
    const program = createActionInputProgram();

    await program.parseAsync(argv, { from: "user" });

    expect(getActionInputCallBrowserRequestMock()).not.toHaveBeenCalled();
    expect(String(getBrowserCliRuntime().error.mock.calls.at(-1)?.[0])).toContain(
      "ref is required",
    );
    expect(getBrowserCliRuntime().exit).toHaveBeenLastCalledWith(1);
  });

  it.each([
    {
      name: "click-coords",
      argv: [
        "browser",
        "click-coords",
        "12",
        "34",
        "--target-id",
        "tab-2",
        "--double",
        "--button",
        "middle",
        "--delay-ms",
        "75",
      ],
      expectedBody: {
        kind: "clickCoords",
        x: 12,
        y: 34,
        targetId: "tab-2",
        doubleClick: true,
        button: "middle",
        delayMs: 75,
      },
    },
    {
      name: "type",
      argv: ["browser", "type", "ref-2", "hello", "--submit", "--slowly", "--target-id", "tab-3"],
      expectedBody: {
        kind: "type",
        ref: "ref-2",
        text: "hello",
        submit: true,
        slowly: true,
        targetId: "tab-3",
      },
    },
    {
      name: "press",
      argv: ["browser", "press", "Enter", "--target-id", "tab-4"],
      expectedBody: { kind: "press", key: "Enter", targetId: "tab-4" },
    },
    {
      name: "hover",
      argv: ["browser", "hover", "ref-3", "--target-id", "tab-5"],
      expectedBody: { kind: "hover", ref: "ref-3", targetId: "tab-5" },
    },
    {
      name: "drag",
      argv: ["browser", "drag", "start-ref", "end-ref", "--target-id", "tab-7"],
      expectedBody: {
        kind: "drag",
        startRef: "start-ref",
        endRef: "end-ref",
        targetId: "tab-7",
      },
    },
    {
      name: "select",
      argv: ["browser", "select", "ref-8", "one", "two", "--target-id", "tab-8"],
      expectedBody: { kind: "select", ref: "ref-8", values: ["one", "two"], targetId: "tab-8" },
    },
  ])("sends $name action bodies", async ({ argv, expectedBody }) => {
    const program = createActionInputProgram();

    await program.parseAsync(argv, { from: "user" });

    expect(getLastActionInputRequest()).toMatchObject({
      method: "POST",
      path: "/act",
      body: expectedBody,
    });
  });

  it("sends scrollintoview timeouts on the action body and outer request", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(
      ["browser", "scrollintoview", "ref-4", "--target-id", "tab-6", "--timeout-ms", "1234"],
      { from: "user" },
    );

    expect(getLastActionInputRequest()).toMatchObject({
      method: "POST",
      path: "/act",
      body: {
        kind: "scrollIntoView",
        ref: "ref-4",
        targetId: "tab-6",
        timeoutMs: 1234,
      },
    });
    expect(getLastActionInputOptions()?.timeoutMs).toBe(6234);
  });
});
