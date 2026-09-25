// Browser tests cover register.files downloads plugin behavior.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as browserPathsModule from "../../browser/paths.js";
import {
  createBrowserProgram,
  mockBrowserGateway,
  getBrowserCliRuntime,
  getBrowserCliRuntimeCapture,
} from "../browser-cli.test-support.js";
import * as cliCoreApiModule from "../core-api.js";

const gatewayMock = mockBrowserGateway();
gatewayMock.mockImplementation(async (_method, _opts, request) =>
  request.path === "/wait/download" || request.path === "/download"
    ? { download: { path: "/tmp/openclaw/downloads/file.txt" } }
    : { ok: true },
);
const browserCliRuntime = getBrowserCliRuntime();
vi.spyOn(cliCoreApiModule.defaultRuntime, "log").mockImplementation(browserCliRuntime.log);
vi.spyOn(cliCoreApiModule.defaultRuntime, "writeJson").mockImplementation(
  browserCliRuntime.writeJson,
);
vi.spyOn(cliCoreApiModule.defaultRuntime, "error").mockImplementation(browserCliRuntime.error);
vi.spyOn(cliCoreApiModule.defaultRuntime, "exit").mockImplementation(browserCliRuntime.exit);
vi.spyOn(browserPathsModule, "resolveExistingUploadPaths").mockResolvedValue({
  ok: true,
  paths: ["/tmp/openclaw/uploads/a.pdf", "/tmp/openclaw/uploads/b.pdf"],
});

const { registerBrowserActionInputCommands } = await import("./register.js");

function createActionInputProgram(): Command {
  const { program, browser, parentOpts } = createBrowserProgram();
  registerBrowserActionInputCommands(browser, parentOpts);
  return program;
}

function getLastRequestOptions(): { timeoutMs?: number } | undefined {
  return gatewayMock.mock.calls.at(-1)?.[2];
}

describe("browser action input file/download commands", () => {
  beforeEach(() => {
    gatewayMock.mockClear();
    vi.mocked(browserPathsModule.resolveExistingUploadPaths).mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
    getBrowserCliRuntime().exit.mockImplementation(() => {});
  });

  it("arms uploads with normalized paths and element targeting options", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(
      [
        "browser",
        "upload",
        "/tmp/openclaw/uploads/a.pdf",
        "media://inbound/b",
        "--input-ref",
        "file-input",
        "--element",
        "input[type=file]",
        "--target-id",
        "tab-1",
        "--timeout-ms",
        "45000",
      ],
      { from: "user" },
    );

    expect(browserPathsModule.resolveExistingUploadPaths).toHaveBeenCalledWith({
      requestedPaths: ["/tmp/openclaw/uploads/a.pdf", "media://inbound/b"],
    });
    const request = gatewayMock.mock.calls.at(-1)?.[2];
    expect(request).toMatchObject({
      path: "/hooks/file-chooser",
      body: {
        paths: ["/tmp/openclaw/uploads/a.pdf", "/tmp/openclaw/uploads/b.pdf"],
        inputRef: "file-input",
        element: "input[type=file]",
        targetId: "tab-1",
        timeoutMs: 45000,
      },
    });
    expect(getLastRequestOptions()?.timeoutMs).toBe(50000);
  });

  it("keeps the outer waitfordownload request open for the advertised default wait", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(["browser", "waitfordownload"], { from: "user" });

    expect(getLastRequestOptions()?.timeoutMs).toBe(125000);
  });

  it("accepts signed and zero-padded download timeouts", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(["browser", "waitfordownload", "--timeout-ms", "+025000"], {
      from: "user",
    });

    expect(getLastRequestOptions()?.timeoutMs).toBe(30000);
  });

  it("uses custom download timeouts as the inner wait plus outer slack", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(
      ["browser", "download", "ref-1", "file.txt", "--timeout-ms", "25000"],
      {
        from: "user",
      },
    );

    expect(getLastRequestOptions()?.timeoutMs).toBe(30000);
  });

  it("rejects non-decimal file and download timeouts before dispatch", async () => {
    const downloadProgram = createActionInputProgram();
    await expect(
      downloadProgram.parseAsync(
        ["browser", "download", "ref-1", "file.txt", "--timeout-ms", "1e3"],
        { from: "user" },
      ),
    ).rejects.toThrow("--timeout-ms must be a positive integer.");

    const waitProgram = createActionInputProgram();
    await expect(
      waitProgram.parseAsync(["browser", "waitfordownload", "--timeout-ms", "0x1000"], {
        from: "user",
      }),
    ).rejects.toThrow("--timeout-ms must be a positive integer.");
    expect(gatewayMock).not.toHaveBeenCalled();
  });

  it("rejects conflicting dialog actions without arming the hook", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(["browser", "dialog", "--accept", "--dismiss"], { from: "user" });

    const errorCall = getBrowserCliRuntime().error.mock.calls.at(-1);
    expect(gatewayMock).not.toHaveBeenCalled();
    expect(String(errorCall?.[0])).toContain("Specify only one of --accept or --dismiss");
    expect(getBrowserCliRuntime().exit).toHaveBeenCalledWith(1);
  });

  it.each(["", "  padded 🦞  "])("preserves prompt response %j", async (prompt) => {
    await createActionInputProgram().parseAsync(
      ["browser", "dialog", "--accept", "--prompt", prompt],
      { from: "user" },
    );
    expect(gatewayMock.mock.calls.at(-1)?.[2]).toMatchObject({
      path: "/hooks/dialog",
      body: { accept: true, promptText: prompt },
    });
  });
});
