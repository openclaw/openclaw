import { afterEach, describe, expect, it, vi } from "vitest";
import { buildContext } from "./execute-events.tool-result-args.test-support.js";
import { executePreparedCliRun as executePreparedCliRunImpl } from "./execute.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";
import { cliBackendLog, CLI_BACKEND_LOG_OUTPUT_ENV } from "./log.js";

// mock-isolation: The supervisor fixture owns execution; never spawn host CLI processes.
vi.mock("../../process/supervisor/adapters/child.js", () => ({
  createChildAdapter: vi.fn(),
}));

const executePreparedCliRun = wrapPreparedCliRunWithTestAdmission(executePreparedCliRunImpl);
const CLI_RUNNER_OUTPUT_TAIL_BYTES = 64 * 1024;
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);
const MULTIBYTE_CHARACTER = String.fromCodePoint(0x1f642);

afterEach(() => {
  supervisorSpawnMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.each(["stdout", "stderr"] as const)("CLI %s diagnostic tail", (stream) => {
  it.each([
    {
      name: "a large chunk",
      chunks: [
        `${"x".repeat(10)}${MULTIBYTE_CHARACTER}${"y".repeat(CLI_RUNNER_OUTPUT_TAIL_BYTES - 3)}`,
      ],
      expected: "y".repeat(CLI_RUNNER_OUTPUT_TAIL_BYTES - 3),
    },
    {
      name: "rolling overflow",
      chunks: [
        `${"x".repeat(10)}${MULTIBYTE_CHARACTER}${"y".repeat(CLI_RUNNER_OUTPUT_TAIL_BYTES - 14)}`,
        "z".repeat(11),
      ],
      expected: `${"y".repeat(CLI_RUNNER_OUTPUT_TAIL_BYTES - 14)}${"z".repeat(11)}`,
    },
  ])(
    "keeps $name UTF-8 safe when truncation starts inside a character",
    async ({ chunks, expected }) => {
      vi.stubEnv(CLI_BACKEND_LOG_OUTPUT_ENV, "1");
      const info = vi.spyOn(cliBackendLog, "info").mockImplementation(() => {});
      const context = buildContext(`output-tail-${stream}`);
      Object.assign(context.preparedBackend.backend, { output: "text", serialize: false });
      supervisorSpawnMock.mockImplementationOnce(async (input) => {
        expect(input.captureOutput).toBe(false);
        if (stream === "stderr") {
          input.onStdout?.("done");
        }
        for (const chunk of chunks) {
          if (stream === "stdout") {
            input.onStdout?.(chunk);
          } else {
            input.onStderr?.(chunk);
          }
        }
        return createManagedRun(createSuccessfulProcessExit());
      });

      await executePreparedCliRun(context);

      const prefix = `cli ${stream}:\n`;
      const messages = info.mock.calls
        .map(([message]) => message)
        .filter((message) => message.startsWith(prefix));
      expect(messages).toHaveLength(1);
      const output = messages[0]!.slice(prefix.length);
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(CLI_RUNNER_OUTPUT_TAIL_BYTES);
      expect(output).not.toContain(REPLACEMENT_CHARACTER);
      expect(output).toBe(expected);
    },
  );
});
