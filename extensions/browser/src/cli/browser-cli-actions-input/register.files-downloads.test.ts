import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getBrowserCliRuntime } from "../browser-cli.test-support.js";
import * as cliCoreApiModule from "../core-api.js";
import {
  createActionInputProgram,
  getActionInputCallBrowserRequestMock,
  getLastActionInputOptions,
  getLastActionInputRequest,
  resetActionInputTestState,
} from "./register.test-helpers.js";

describe("browser action input file/download commands", () => {
  beforeEach(() => {
    resetActionInputTestState();
  });

  it("sends waitfordownload path, target, and timeout to the download wait endpoint", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(
      [
        "browser",
        "waitfordownload",
        "downloads/report.pdf",
        "--target-id",
        "tab-download",
        "--timeout-ms",
        "45000",
      ],
      { from: "user" },
    );

    expect(getLastActionInputRequest()).toMatchObject({
      method: "POST",
      path: "/wait/download",
      body: {
        path: "downloads/report.pdf",
        targetId: "tab-download",
        timeoutMs: 45000,
      },
    });
    expect(getLastActionInputOptions()?.timeoutMs).toBe(50000);
  });

  it("sends download ref, path, target, and timeout to the download endpoint", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(
      [
        "browser",
        "download",
        "ref-1",
        "file.txt",
        "--target-id",
        "tab-click-download",
        "--timeout-ms",
        "25000",
      ],
      {
        from: "user",
      },
    );

    expect(getLastActionInputRequest()).toMatchObject({
      method: "POST",
      path: "/download",
      body: {
        ref: "ref-1",
        path: "file.txt",
        targetId: "tab-click-download",
        timeoutMs: 25000,
      },
    });
    expect(getLastActionInputOptions()?.timeoutMs).toBe(30000);
  });

  it("sends upload paths and selectors to the file chooser hook", async () => {
    const program = createActionInputProgram();
    const uploadPath = path.join(
      cliCoreApiModule.DEFAULT_UPLOAD_DIR,
      `vitest-upload-${process.pid}-${randomUUID()}.txt`,
    );
    await fs.mkdir(cliCoreApiModule.DEFAULT_UPLOAD_DIR, { recursive: true });
    await fs.writeFile(uploadPath, "upload body");
    const canonicalUploadPath = await fs.realpath(uploadPath);

    try {
      await program.parseAsync(
        [
          "browser",
          "upload",
          uploadPath,
          "--ref",
          "button-ref",
          "--input-ref",
          "input-ref",
          "--element",
          "input[type=file]",
          "--target-id",
          "tab-1",
          "--timeout-ms",
          "15000",
        ],
        { from: "user" },
      );
    } finally {
      await fs.rm(uploadPath, { force: true });
    }

    expect(getLastActionInputRequest()).toMatchObject({
      path: "/hooks/file-chooser",
      body: {
        paths: [canonicalUploadPath],
        ref: "button-ref",
        inputRef: "input-ref",
        element: "input[type=file]",
        targetId: "tab-1",
        timeoutMs: 15000,
      },
    });
    expect(getLastActionInputOptions()?.timeoutMs).toBe(20000);
  });

  it("sends dialog actions to the dialog hook", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(
      [
        "browser",
        "dialog",
        "--accept",
        "--prompt",
        "approved",
        "--dialog-id",
        "dialog-1",
        "--target-id",
        "tab-dialog",
        "--timeout-ms",
        "16000",
      ],
      { from: "user" },
    );

    expect(getLastActionInputRequest()).toMatchObject({
      method: "POST",
      path: "/hooks/dialog",
      body: {
        accept: true,
        promptText: "approved",
        dialogId: "dialog-1",
        targetId: "tab-dialog",
        timeoutMs: 16000,
      },
    });
    expect(getLastActionInputOptions()?.timeoutMs).toBe(21000);
  });

  it("sends dismiss dialog actions to the dialog hook", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(
      ["browser", "dialog", "--dismiss", "--dialog-id", "dialog-2", "--target-id", "tab-dialog"],
      { from: "user" },
    );

    expect(getLastActionInputRequest()).toMatchObject({
      method: "POST",
      path: "/hooks/dialog",
      body: {
        accept: false,
        dialogId: "dialog-2",
        targetId: "tab-dialog",
      },
    });
    expect(getLastActionInputOptions()?.timeoutMs).toBe(125000);
  });

  it("rejects missing dialog actions without arming the hook", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(["browser", "dialog"], { from: "user" });

    const errorCall = getBrowserCliRuntime().error.mock.calls.at(-1);
    expect(getActionInputCallBrowserRequestMock()).not.toHaveBeenCalled();
    expect(String(errorCall?.[0])).toContain("Specify --accept or --dismiss");
    expect(getBrowserCliRuntime().exit).toHaveBeenLastCalledWith(1);
  });

  it("rejects conflicting dialog actions without arming the hook", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(["browser", "dialog", "--accept", "--dismiss"], { from: "user" });

    const errorCall = getBrowserCliRuntime().error.mock.calls.at(-1);
    expect(getActionInputCallBrowserRequestMock()).not.toHaveBeenCalled();
    expect(String(errorCall?.[0])).toContain("Specify only one of --accept or --dismiss");
    expect(getBrowserCliRuntime().exit).toHaveBeenLastCalledWith(1);
  });
});
