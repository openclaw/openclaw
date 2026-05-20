import { beforeEach, describe, expect, it } from "vitest";
import { getBrowserCliRuntime } from "../browser-cli.test-support.js";
import {
  createActionInputProgram,
  getActionInputCallBrowserRequestMock,
  getLastActionInputOptions,
  getLastActionInputRequest,
  resetActionInputTestState,
} from "./register.test-helpers.js";

describe("browser action input wait command", () => {
  beforeEach(() => {
    resetActionInputTestState();
  });

  it("sends time-only waits on the action body and keeps the outer request open", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(["browser", "wait", "--time", "25000", "--target-id", "tab-time"], {
      from: "user",
    });

    expect(getLastActionInputRequest()).toMatchObject({
      method: "POST",
      path: "/act",
      body: {
        kind: "wait",
        timeMs: 25000,
        targetId: "tab-time",
      },
    });
    expect(getLastActionInputOptions()?.timeoutMs).toBe(30000);
  });

  it("sends conditional wait fields and exact timeout slack", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(
      [
        "browser",
        "--browser-profile",
        "work",
        "wait",
        "main.ready",
        "--time",
        "25000",
        "--text",
        "Ready",
        "--url",
        "**/dash",
        "--load",
        "networkidle",
        "--fn",
        "() => window.ready === true",
        "--target-id",
        "tab-wait",
        "--timeout-ms",
        "7000",
      ],
      { from: "user" },
    );

    expect(getLastActionInputRequest()).toMatchObject({
      method: "POST",
      path: "/act",
      query: { profile: "work" },
      body: {
        kind: "wait",
        timeMs: 25000,
        selector: "main.ready",
        text: "Ready",
        url: "**/dash",
        loadState: "networkidle",
        fn: "() => window.ready === true",
        targetId: "tab-wait",
        timeoutMs: 7000,
      },
    });
    expect(getLastActionInputOptions()?.timeoutMs).toBe(65000);
  });

  it("sends text-gone wait fields and timeout slack", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(
      [
        "browser",
        "wait",
        "--text-gone",
        "Loading",
        "--target-id",
        "tab-gone",
        "--timeout-ms",
        "9000",
      ],
      { from: "user" },
    );

    expect(getLastActionInputRequest()).toMatchObject({
      method: "POST",
      path: "/act",
      body: {
        kind: "wait",
        textGone: "Loading",
        targetId: "tab-gone",
        timeoutMs: 9000,
      },
    });
    expect(getLastActionInputOptions()?.timeoutMs).toBe(14000);
  });
});

describe("browser action input fill command", () => {
  beforeEach(() => {
    resetActionInputTestState();
  });

  it("sends fill fields and target id to the browser action endpoint", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(
      [
        "browser",
        "fill",
        "--fields",
        '[{"ref":"email","type":"textbox","value":"hello@example.test"}]',
        "--target-id",
        "tab-1",
      ],
      { from: "user" },
    );

    expect(getLastActionInputRequest().body).toMatchObject({
      kind: "fill",
      fields: [{ ref: "email", type: "textbox", value: "hello@example.test" }],
      targetId: "tab-1",
    });
  });
});

describe("browser action input evaluate command", () => {
  beforeEach(() => {
    resetActionInputTestState();
  });

  it("passes fn, ref, target, and timeout through to the evaluate action", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(
      [
        "browser",
        "evaluate",
        "--fn",
        "(el) => el.textContent",
        "--ref",
        "ref-1",
        "--target-id",
        "tab-2",
        "--timeout-ms",
        "30000",
      ],
      { from: "user" },
    );

    expect(getLastActionInputRequest().body).toMatchObject({
      kind: "evaluate",
      fn: "(el) => el.textContent",
      ref: "ref-1",
      targetId: "tab-2",
      timeoutMs: 30000,
    });
    expect(getLastActionInputOptions()?.timeoutMs).toBe(35000);
  });

  it("rejects evaluate without --fn before sending a browser action", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(["browser", "evaluate", "--target-id", "tab-2"], { from: "user" });

    expect(getActionInputCallBrowserRequestMock()).not.toHaveBeenCalled();
    expect(String(getBrowserCliRuntime().error.mock.calls.at(-1)?.[0])).toContain("Missing --fn");
    expect(getBrowserCliRuntime().exit).toHaveBeenLastCalledWith(1);
  });
});
