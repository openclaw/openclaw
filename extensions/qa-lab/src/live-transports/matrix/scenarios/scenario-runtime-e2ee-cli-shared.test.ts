import { describe, expect, it } from "vitest";
import { parseMatrixQaCliJson } from "./scenario-runtime-e2ee-cli-shared.js";

const args = ["matrix", "verify", "status", "--password", "fixture-password", "--json"];
const command = "openclaw matrix verify status --password [REDACTED] --json";

describe("Matrix QA CLI JSON output", () => {
  it.each([
    { stdout: '  {"success":true}\n', stderr: '{"success":false}', expected: { success: true } },
    { stdout: " false ", stderr: "invalid stderr", expected: false },
    { stdout: "null", stderr: "invalid stderr", expected: null },
    { stdout: '""', stderr: "invalid stderr", expected: "" },
    { stdout: " \n", stderr: " [0,false,null] \t", expected: [0, false, null] },
  ])(
    "parses the selected payload without changing JSON values: %j",
    ({ stdout, stderr, expected }) => {
      expect(parseMatrixQaCliJson({ args, exitCode: 0, stdout, stderr })).toEqual(expected);
    },
  );

  it.each(["stdout", "stderr"] as const)(
    "retains %s failure diagnostics and never tries another payload after invalid JSON",
    (stream) => {
      const payload = "{]\nGET /_matrix/client/v3/sync?access_token=abcdef1234567890ghij";
      let failure: unknown;
      try {
        parseMatrixQaCliJson({
          args,
          exitCode: 1,
          stdout: stream === "stdout" ? `  ${payload}\n` : " \n",
          stderr: stream === "stderr" ? `\t${payload}  ` : '{"fallback":true}',
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      const error = failure as Error;
      expect(error.cause).toBeInstanceOf(SyntaxError);
      expect(error.message).toBe(
        `${command} printed invalid JSON: ${(error.cause as Error).message}\n${stream}:\n{]\nGET /_matrix/client/v3/sync?access_token=abcdef…ghij`,
      );
    },
  );

  it("reports empty output without a JSON parser cause", () => {
    let failure: unknown;
    try {
      parseMatrixQaCliJson({ args, exitCode: 0, stdout: " \n", stderr: "\t " });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ message: `${command} did not print JSON` });
    expect(failure).not.toHaveProperty("cause");
  });
});
