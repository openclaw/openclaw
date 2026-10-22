import { afterEach, describe, expect, it, vi } from "vitest";
import { azLoginDeviceCodeWithOptions } from "./cli.js";

const runUtf8CommandWithTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>();
  return { ...actual, runUtf8CommandWithTimeout: runUtf8CommandWithTimeoutMock };
});

describe("azLoginDeviceCodeWithOptions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    runUtf8CommandWithTimeoutMock.mockReset();
  });

  it("forwards split-byte live output and reports the decoded captured error", async () => {
    runUtf8CommandWithTimeoutMock.mockImplementationOnce(
      async (
        _argv: string[],
        options: {
          onOutputChunk?: (chunk: Buffer, stream: "stdout" | "stderr") => void;
        },
      ) => {
        const writeSplitUtf8 = (stream: "stdout" | "stderr", text: string) => {
          const bytes = Buffer.from(text);
          options.onOutputChunk?.(bytes.subarray(0, 2), stream);
          options.onOutputChunk?.(bytes.subarray(2), stream);
        };
        writeSplitUtf8("stderr", "😊");
        writeSplitUtf8("stdout", "🚀");
        return {
          stdout: "🚀",
          stderr: "😊",
          code: 1,
          signal: null,
          killed: false,
          termination: "exit",
          noOutputTimedOut: false,
        };
      },
    );
    const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const err = await azLoginDeviceCodeWithOptions({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("az login exited with code 1: 😊🚀");
    for (const [write, expected] of [
      [stdoutWriteSpy, "🚀"],
      [stderrWriteSpy, "😊"],
    ] as const) {
      const bytes = write.mock.calls.map(([chunk]) =>
        typeof chunk === "string" ? Buffer.from(chunk) : chunk,
      );
      expect(Buffer.concat(bytes).toString("utf8")).toBe(expected);
    }
  });

  it("allows post-auth work after the 15-minute device-code lifetime", async () => {
    runUtf8CommandWithTimeoutMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      code: 124,
      signal: null,
      killed: true,
      termination: "timeout",
      noOutputTimedOut: false,
    });

    const err = await azLoginDeviceCodeWithOptions({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("az login timed out after 20 minutes");
    expect(runUtf8CommandWithTimeoutMock).toHaveBeenCalledWith(
      ["az", "login", "--use-device-code"],
      expect.objectContaining({
        killProcessTree: true,
        outputCapture: "tail",
        maxOutputBytes: 8_000,
        timeoutMs: 20 * 60 * 1000,
      }),
    );
  });
});
