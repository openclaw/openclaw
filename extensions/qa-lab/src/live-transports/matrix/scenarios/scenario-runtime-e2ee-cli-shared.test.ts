import { readFileSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { describe, expect, it, vi } from "vitest";
import type { MatrixQaCliRunResult } from "./scenario-runtime-cli.js";
import { parseMatrixQaCliJson } from "./scenario-runtime-e2ee-cli-shared.js";
import {
  runMatrixQaCliJson,
  type MatrixQaCliRuntime,
} from "./scenario-runtime-e2ee-destructive-recovery.js";

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

describe("Matrix QA destructive CLI JSON boundary", () => {
  const rawDetail = "GET /_matrix/client/v3/sync?access_token=abcdef1234567890ghij";
  const redactedDetail = "GET /_matrix/client/v3/sync?access_token=abcdef…ghij";
  const stdout = ` {"values":[0,false,null,""],"detail":"${rawDetail}"}\n`;
  const redactedStdout = ` {"values":[0,false,null,""],"detail":"${redactedDetail}"}\n`;
  const stderr = `{"fallback":true,"detail":"${rawDetail}"}`;
  const redactedStderr = `{"fallback":true,"detail":"${redactedDetail}"}`;

  it.each([
    {
      name: "decodes authoritative stdout after both redacted artifacts are written",
      outcome: "success",
      stdout,
      stderr,
      expectedStdout: redactedStdout,
      expectedStderr: redactedStderr,
    },
    {
      name: "rejects malformed stdout without falling back to valid stderr",
      outcome: "stdout",
      stdout: `  {]\n${rawDetail}\n`,
      stderr,
      expectedStdout: `  {]\n${redactedDetail}\n`,
      expectedStderr: redactedStderr,
    },
    {
      name: "labels malformed stderr when stdout is blank",
      outcome: "stderr",
      stdout: " \n",
      stderr: `\t{]\n${rawDetail}  `,
      expectedStdout: " \n",
      expectedStderr: `\t{]\n${redactedDetail}  `,
    },
    {
      name: "rejects empty streams without decoding or a JSON parser cause",
      outcome: "empty",
      stdout: " \n",
      stderr: "\t ",
      expectedStdout: " \n",
      expectedStderr: "\t ",
    },
  ])(
    "$name",
    async ({ outcome, stdout: output, stderr: errorOutput, expectedStdout, expectedStderr }) => {
      const root = await mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "matrix-qa-json-"));
      try {
        const artifactDir = path.join(root, "artifacts");
        const artifacts = {
          stdoutPath: path.join(artifactDir, "json-output.stdout.txt"),
          stderrPath: path.join(artifactDir, "json-output.stderr.txt"),
        };
        const result: MatrixQaCliRunResult = {
          args,
          exitCode: 7,
          stdout: output,
          stderr: errorOutput,
        };
        const run = vi.fn<MatrixQaCliRuntime["run"]>().mockResolvedValue(result);
        const runtime: MatrixQaCliRuntime = {
          artifactDir,
          configPath: path.join(root, "config.json"),
          stateDir: path.join(root, "state"),
          dispose: async () => undefined,
          run,
          start: () => {
            throw new Error("The JSON wrapper must not start an interactive CLI session");
          },
        };
        const decoded = { marker: "decoded" };
        const decode = vi.fn((payload: unknown) => {
          expect(payload).toEqual({ values: [0, false, null, ""], detail: rawDetail });
          expect(readFileSync(artifacts.stdoutPath, "utf8")).toBe(expectedStdout);
          expect(readFileSync(artifacts.stderrPath, "utf8")).toBe(expectedStderr);
          return decoded;
        });
        const pending = runMatrixQaCliJson({
          args,
          allowNonZero: true,
          stdin: "fixture-input\n",
          timeoutMs: 1_234,
          label: "json-output",
          runtime,
          decode,
        });
        if (outcome === "success") {
          const actual = await pending;
          expect(actual.result).toBe(result);
          expect(actual.payload).toBe(decoded);
          expect(actual.artifacts).toEqual(artifacts);
          expect(decode).toHaveBeenCalledTimes(1);
        } else {
          const failure = await pending.catch((caught: unknown) => caught);
          expect(readFileSync(artifacts.stdoutPath, "utf8")).toBe(expectedStdout);
          expect(readFileSync(artifacts.stderrPath, "utf8")).toBe(expectedStderr);
          expect(failure).toBeInstanceOf(Error);
          const error = failure as Error;
          expect(decode).not.toHaveBeenCalled();
          if (outcome === "empty") {
            expect(error.message).toBe(`${command} did not print JSON`);
            expect(error).not.toHaveProperty("cause");
          } else {
            expect(error.cause).toBeInstanceOf(SyntaxError);
            expect(error.message).toBe(
              `${command} printed invalid JSON: ${(error.cause as Error).message}\n${outcome}:\n{]\n${redactedDetail}`,
            );
          }
        }
        expect(run).toHaveBeenCalledExactlyOnceWith(args, {
          allowNonZero: true,
          stdin: "fixture-input\n",
          timeoutMs: 1_234,
        });
        if (process.platform !== "win32") {
          expect((await stat(artifactDir)).mode & 0o777).toBe(0o700);
          expect((await stat(artifacts.stdoutPath)).mode & 0o777).toBe(0o600);
          expect((await stat(artifacts.stderrPath)).mode & 0o777).toBe(0o600);
        }
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
  );
});
