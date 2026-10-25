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
import * as batchSharedModule from "./shared.js";

const mocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn<
    typeof browserCliSharedModule.callBrowserRequest<Record<string, unknown>>
  >(async () => ({ results: [{ ok: true }] })),
  readActionsPayload: vi.fn(async () => ""),
}));

vi.spyOn(browserCliSharedModule, "callBrowserRequest").mockImplementation(mocks.callBrowserRequest);
vi.spyOn(batchSharedModule, "readActionsPayload").mockImplementation(mocks.readActionsPayload);
mockBrowserCliRuntime();

const { registerBrowserActionInputCommands } = await import("./register.js");

function run(...args: string[]) {
  const { program, browser, parentOpts } = createBrowserProgram();
  registerBrowserActionInputCommands(browser, parentOpts);
  return program.parseAsync(["browser", ...args], { from: "user" });
}

function getLastActionBody(): Record<string, unknown> | undefined {
  return (mocks.callBrowserRequest.mock.calls.at(-1)?.[1] as { body?: Record<string, unknown> })
    ?.body;
}

const SAMPLE_ACTIONS = [
  { kind: "open", url: "https://example.com" },
  { kind: "click", ref: "12" },
];
const actionsJson = JSON.stringify(SAMPLE_ACTIONS);
const capture = getBrowserCliRuntimeCapture();

function runBatch(options: string[] = [], parentOptions: string[] = []) {
  mocks.readActionsPayload.mockResolvedValueOnce(actionsJson);
  return run(...parentOptions, "batch", "--actions", actionsJson, ...options);
}

async function expectRejected(args: string[], message: string) {
  await expect(run("batch", ...args)).rejects.toThrow("__exit__:1");
  expect(capture.runtimeErrors.join("\n")).toContain(message);
  expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
}

describe("browser action input batch command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capture.resetRuntimeCapture();
  });

  it("sends normalized batch body with inline actions and target id", async () => {
    await runBatch(["--target-id", "tab-1"]);
    expect(getLastActionBody()).toMatchObject({
      kind: "batch",
      actions: SAMPLE_ACTIONS,
      targetId: "tab-1",
    });
    expect(mocks.callBrowserRequest.mock.calls.at(-1)?.[2]).toEqual({ timeoutMs: 65_000 });
  });

  it("sets stopOnError=false when --continue is passed", async () => {
    await runBatch(["--continue"]);
    expect(getLastActionBody()).toMatchObject({ kind: "batch", stopOnError: false });
  });

  it.each([undefined, "work", " work ", "-work"])(
    "keeps the selected profile %s when replaying a modal recovery hint",
    async (profile) => {
      const gateway = mockBrowserGateway();
      mocks.callBrowserRequest.mockResolvedValueOnce({
        ok: true,
        blockedByDialog: true,
        browserState: { dialogs: { pending: [{ id: "d1" }] } },
      });
      const args: string[] = [];
      if (profile !== undefined) {
        args.push("--browser-profile", profile);
      }
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

      expect(mocks.callBrowserRequest).toHaveBeenCalledTimes(1);
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
    mocks.callBrowserRequest.mockResolvedValueOnce(result);
    await runBatch();
    const text = capture.runtimeLogs.join("\n");
    expect(text).toContain("stopped after action 1");
    expect(text).toContain("1 action(s) skipped");
    expect(text).not.toContain("batch ran 2");
    expect(capture.defaultRuntime.exit).not.toHaveBeenCalled();

    capture.resetRuntimeCapture();
    vi.clearAllMocks();
    mocks.callBrowserRequest.mockResolvedValueOnce(result);
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
    mocks.callBrowserRequest.mockResolvedValueOnce(result);
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
    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
    expect(mocks.readActionsPayload).not.toHaveBeenCalled();
  });

  it("rejects malformed actions JSON before dispatch", async () => {
    mocks.readActionsPayload.mockResolvedValueOnce("NOT JSON {{{");
    await expectRejected(["--actions", "NOT JSON {{{"], "actions must be valid JSON");
  });

  it("rejects non-array actions before dispatch", async () => {
    const payload = JSON.stringify({ kind: "click" });
    mocks.readActionsPayload.mockResolvedValueOnce(payload);
    await expectRejected(["--actions", payload], "actions must be a JSON array");
  });

  it("rejects empty actions before dispatch", async () => {
    mocks.readActionsPayload.mockResolvedValueOnce("[]");
    await expectRejected(["--actions", "[]"], "actions must contain at least one entry");
  });

  it("requires actions from --actions, --actions-file, or stdin", async () => {
    await expect(run("batch")).rejects.toThrow(
      "Provide --actions, --actions-file, or --actions-file -",
    );
    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
  });
});
