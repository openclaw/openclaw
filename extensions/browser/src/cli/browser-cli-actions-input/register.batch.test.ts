import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { createNonExitingRuntime, defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as browserCliSharedModule from "../browser-cli-shared.js";
import {
  createBrowserProgram,
  mockBrowserCliRuntime,
  getBrowserCliRuntimeCapture,
  mockBrowserGateway,
} from "../browser-cli.test-support.js";

const request = vi
  .spyOn(browserCliSharedModule, "callBrowserRequest")
  .mockResolvedValue({ results: [{ ok: true }] });
const realpath = vi.spyOn(fs, "realpath");
mockBrowserCliRuntime();

const { registerBrowserActionInputCommands } = await import("./register.js");

function run(...args: string[]) {
  const { program, browser, parentOpts } = createBrowserProgram();
  browser.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerBrowserActionInputCommands(browser, parentOpts);
  return program.parseAsync(["browser", ...args], { from: "user" });
}

function getLastActionBody(): Record<string, unknown> | undefined {
  return (request.mock.calls.at(-1)?.[1] as { body?: Record<string, unknown> })?.body;
}

const SAMPLE_ACTIONS = [
  { kind: "open", url: "https://example.com" },
  { kind: "click", ref: "12" },
];
const actionsJson = JSON.stringify(SAMPLE_ACTIONS);
const capture = getBrowserCliRuntimeCapture();

function runBatch(options: string[] = [], parentOptions: string[] = []) {
  return run(...parentOptions, "batch", "--actions", actionsJson, ...options);
}

describe("browser action input batch command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    request.mockResolvedValue({ results: [{ ok: true }] });
    capture.resetRuntimeCapture();
  });

  it("sends normalized batch body with inline actions and target id", async () => {
    await runBatch(["--target-id", "tab-1"]);
    expect(getLastActionBody()).toMatchObject({
      kind: "batch",
      actions: SAMPLE_ACTIONS,
      targetId: "tab-1",
    });
    expect(request.mock.calls.at(-1)?.[2]).toEqual({ timeoutMs: 65_000 });
  });

  it("sets stopOnError=false when --continue is passed", async () => {
    await runBatch(["--continue"]);
    expect(getLastActionBody()).toMatchObject({ kind: "batch", stopOnError: false });
  });

  it.each([undefined, "work", " work ", "-work"])(
    "keeps the selected profile %s when replaying a modal recovery hint",
    async (profile) => {
      const gateway = mockBrowserGateway();
      request.mockResolvedValueOnce({
        ok: true,
        blockedByDialog: true,
        browserState: { dialogs: { pending: [{ id: "d1" }] } },
      });
      const args = profile === undefined ? [] : ["--browser-profile", profile];
      await run(...args, "click", "e1");

      const hint = capture.runtimeLogs.join("\n");
      const command = expectDefined(
        hint.match(/Use (openclaw browser .+) to continue\./)?.[1],
        "modal recovery command",
      );
      const replay = command
        .replace("--accept or --dismiss", "--accept")
        .replace("--dialog-id <id>", "--dialog-id d1");
      await run(...replay.split(/\s+/).slice(2));

      expect(request).toHaveBeenCalledTimes(1);
      expect(gateway).toHaveBeenCalledTimes(1);
      expect(gateway.mock.calls[0]?.[2]).toMatchObject({
        method: "POST",
        path: "/hooks/dialog",
        query: profile ? { profile: profile.trim() } : undefined,
        body: { accept: true, dialogId: "d1" },
      });
    },
  );

  it("reports actions skipped after closed", async () => {
    const result = {
      ok: true,
      results: [{ ok: true }],
      aborted: { reason: "closed", afterAction: 1, skipped: 1, url: "https://example.com/next" },
    };
    request.mockResolvedValueOnce(result);
    await runBatch();
    const text = capture.runtimeLogs.join("\n");
    expect(text).toContain("stopped after action 1");
    expect(text).toContain("1 action(s) skipped");
    expect(text).not.toContain("batch ran 2");
    expect(capture.defaultRuntime.exit).not.toHaveBeenCalled();

    capture.resetRuntimeCapture();
    vi.clearAllMocks();
    request.mockResolvedValueOnce(result);
    await runBatch([], ["--json"]);
    expect(capture.defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith(result);
    expect(capture.runtimeLogs).toEqual([JSON.stringify(result, null, 2)]);
  });

  it("retains the child error and interruption when an action fails during navigation", async () => {
    const result = {
      ok: true,
      results: [{ ok: false, error: "Synthetic failure" }],
      aborted: {
        reason: "navigation",
        afterAction: 1,
        skipped: 1,
        url: "https://example.com/next",
      },
    };
    request.mockResolvedValueOnce(result);
    vi.mocked(defaultRuntime.exit).mockImplementationOnce(createNonExitingRuntime().exit);
    await expect(runBatch()).rejects.toMatchObject({ name: "ExitError", code: 1 });
    expect(capture.runtimeErrors).toEqual(["batch failed: action 1: Synthetic failure"]);
    expect(capture.runtimeLogs.join("\n")).toContain("1 action(s) skipped");
    expect(capture.runtimeLogs.join("\n")).not.toContain("batch ran");
  });

  it("rejects conflicting inline and file actions before reading either source", async () => {
    await expect(
      run("batch", "--actions", "[]", "--actions-file", "/tmp/browser-actions.json"),
    ).rejects.toThrow("Specify only one of --actions or --actions-file");
    expect(request).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalled();
  });

  it.each([
    ["NOT JSON {{{", "actions must be valid JSON"],
    ['{"kind":"click"}', "actions must be a JSON array"],
    ["[]", "actions must contain at least one entry"],
  ])("rejects invalid actions %s before dispatch", async (payload, message) => {
    await expect(run("batch", "--actions", payload)).rejects.toThrow("__exit__:1");
    expect(capture.runtimeErrors.join("\n")).toContain(message);
    expect(request).not.toHaveBeenCalled();
  });

  it("requires actions from --actions, --actions-file, or stdin", async () => {
    await expect(run("batch")).rejects.toThrow(
      "Provide --actions, --actions-file, or --actions-file -",
    );
    expect(request).not.toHaveBeenCalled();
  });
});

describe("browser element commands", () => {
  beforeEach(() => {
    request.mockClear().mockResolvedValue({ url: "https://example.test" });
    capture.resetRuntimeCapture();
  });

  it.each([
    [
      ["--browser-profile", "user", "click", " ref-1 ", "--modifiers", "Shift, Alt"],
      { kind: "click", ref: "ref-1", modifiers: ["Shift", "Alt"] },
    ],
    [
      ["click-coords", "12.5", "42", "--delay-ms", "25"],
      { kind: "clickCoords", x: 12.5, y: 42, delayMs: 25 },
    ],
    [
      ["type", "input-1", "hello", "--submit", "--slowly"],
      { kind: "type", ref: "input-1", text: "hello", submit: true, slowly: true },
    ],
    [["hover", "node-1"], { kind: "hover", ref: "node-1" }],
    [["drag", "start-1", "end-1"], { kind: "drag", startRef: "start-1", endRef: "end-1" }],
    [
      ["select", "select-1", "alpha", "beta"],
      { kind: "select", ref: "select-1", values: ["alpha", "beta"] },
    ],
  ] satisfies [string[], Record<string, unknown>][])(
    "sends the expected action body for %j",
    async (argv, expectedBody) => {
      const options = ["--target-id", "tab-1"];
      const isClick = argv.includes("click") || argv.includes("click-coords");
      const button = argv[0] === "click-coords" ? "middle" : "right";
      if (isClick) {
        options.push("--double", "--button", button);
      }
      await run(...argv, ...options);
      expect(getLastActionBody()).toMatchObject({
        ...expectedBody,
        targetId: "tab-1",
        ...(isClick ? { doubleClick: true, button } : {}),
      });
      expect(request.mock.calls.at(-1)?.[2]).toEqual({ timeoutMs: 126_250 });
    },
  );

  it.each([
    [["click", "   "], "ref is required"],
    [["click-coords", "0x10", "20"], "Invalid x: must be a finite number"],
  ] satisfies [string[], string][])(
    "rejects invalid arguments %j before dispatch",
    async (args, message) => {
      await expect(run(...args)).rejects.toThrow(message);
      expect(capture.runtimeErrors).toEqual([]);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("rejects an invalid --button for click-coords before dispatch", async () => {
    await expect(run("click-coords", "10", "20", "--button", "Left")).rejects.toMatchObject({
      code: "commander.invalidArgument",
      exitCode: 1,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("leaves button undefined for click when omitted", async () => {
    await run("click", "ref-1");
    expect(getLastActionBody()?.button).toBeUndefined();
  });

  it("accepts signed and zero-padded integer action options", async () => {
    await run("click-coords", "10", "20", "--delay-ms", "+0005");
    expect(getLastActionBody()?.delayMs).toBe(5);
    await run("scrollintoview", "ref-1", "--timeout-ms", "+020000");
    expect(getLastActionBody()?.timeoutMs).toBe(20_000);
    expect(request.mock.calls.at(-1)?.[2]?.timeoutMs).toBe(126_250);
  });
});
