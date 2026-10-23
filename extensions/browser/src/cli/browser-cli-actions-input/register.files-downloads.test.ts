import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as browserPathsModule from "../../browser/paths.js";
import {
  createBrowserProgram,
  mockBrowserGateway,
  getBrowserCliRuntime,
  getBrowserCliRuntimeCapture,
} from "../browser-cli.test-support.js";

const gatewayMock = mockBrowserGateway();
gatewayMock.mockImplementation(async (_method, _opts, request) =>
  request.path === "/wait/download" || request.path === "/download"
    ? { download: { path: "/tmp/openclaw/downloads/file.txt" } }
    : { ok: true },
);
const browserCliRuntime = getBrowserCliRuntime();
vi.spyOn(defaultRuntime, "log").mockImplementation(browserCliRuntime.log);
vi.spyOn(defaultRuntime, "writeJson").mockImplementation(browserCliRuntime.writeJson);
vi.spyOn(defaultRuntime, "error").mockImplementation(browserCliRuntime.error);
vi.spyOn(defaultRuntime, "exit").mockImplementation(browserCliRuntime.exit);
vi.spyOn(browserPathsModule, "resolveExistingUploadPaths").mockResolvedValue({
  ok: true,
  paths: ["/tmp/openclaw/uploads/a.pdf", "/tmp/openclaw/uploads/b.pdf"],
});

const { registerBrowserActionInputCommands } = await import("./register.js");

function run(...args: string[]) {
  const { program, browser, parentOpts } = createBrowserProgram();
  registerBrowserActionInputCommands(browser, parentOpts);
  return program.parseAsync(["browser", ...args], { from: "user" });
}

const lastRequest = () => gatewayMock.mock.calls.at(-1)?.[2];

describe("browser action input file/download commands", () => {
  beforeEach(() => {
    gatewayMock.mockClear();
    vi.mocked(browserPathsModule.resolveExistingUploadPaths).mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
    getBrowserCliRuntime().exit.mockImplementation(() => {});
  });

  it("arms uploads with normalized paths and element targeting options", async () => {
    await run(
      "upload",
      "/tmp/openclaw/uploads/a.pdf",
      "media://inbound/b",
      "--input-ref=file-input",
      "--element=input[type=file]",
      "--target-id=tab-1",
      "--timeout-ms=45000",
    );

    expect(browserPathsModule.resolveExistingUploadPaths).toHaveBeenCalledWith({
      requestedPaths: ["/tmp/openclaw/uploads/a.pdf", "media://inbound/b"],
    });
    expect(lastRequest()).toMatchObject({
      path: "/hooks/file-chooser",
      body: {
        paths: ["/tmp/openclaw/uploads/a.pdf", "/tmp/openclaw/uploads/b.pdf"],
        inputRef: "file-input",
        element: "input[type=file]",
        targetId: "tab-1",
        timeoutMs: 45000,
      },
    });
    expect(lastRequest()?.timeoutMs).toBe(50000);
  });

  it("accepts signed and zero-padded download timeouts", async () => {
    await run("waitfordownload", "--timeout-ms", "+025000");
    expect(lastRequest()?.timeoutMs).toBe(30000);
  });

  it("uses custom download timeouts as the inner wait plus outer slack", async () => {
    await run("download", "ref-1", "file.txt", "--timeout-ms", "25000");
    expect(lastRequest()?.timeoutMs).toBe(30000);
  });

  it("rejects conflicting dialog actions without arming the hook", async () => {
    await expect(run("dialog", "--accept", "--dismiss")).rejects.toThrow(
      "Specify only one of --accept or --dismiss",
    );
    expect(gatewayMock).not.toHaveBeenCalled();
    expect(browserCliRuntime.error).not.toHaveBeenCalled();
    expect(browserCliRuntime.exit).not.toHaveBeenCalled();
  });

  it("preserves an empty prompt response", async () => {
    await run("dialog", "--accept", "--prompt", "");
    expect(lastRequest()).toMatchObject({
      path: "/hooks/dialog",
      body: { accept: true, promptText: "" },
    });
  });
});
