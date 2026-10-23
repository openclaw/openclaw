import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import type { MatrixQaCliRunResult } from "./scenario-runtime-cli.js";
import { parseMatrixQaCliJson } from "./scenario-runtime-e2ee-cli-shared.js";
import {
  runMatrixQaCliJson,
  type MatrixQaCliRuntime,
} from "./scenario-runtime-e2ee-destructive-recovery.js";

const args = ["matrix", "verify", "status", "--password", "fixture-password", "--json"];
const command = "openclaw matrix verify status --password [REDACTED] --json";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  [" false ", "invalid stderr", false],
  [" \n", " null \t", null],
] as const)("parses selected JSON without changing its value: %j", (stdout, stderr, expected) => {
  expect(parseMatrixQaCliJson({ args, exitCode: 0, stdout, stderr })).toEqual(expected);
});

const rawDetail = "GET /_matrix/client/v3/sync?access_token=abcdef1234567890ghij";
const redactedDetail = "GET /_matrix/client/v3/sync?access_token=abcdef…ghij";
const stdout = ` {"success":false,"backup":{"matchesDecryptionKey":null,"extra":false},"imported":0,"values":[0,false,null,""],"detail":"${rawDetail}"}\n`;
const stderr = `{"fallback":true,"detail":"${rawDetail}"}`;

it.each([
  ["returns authoritative stdout and redacted artifacts", "success", stdout, stderr],
  ["rejects malformed stdout despite valid stderr", "stdout", `  {]\n${rawDetail}\n`, stderr],
  ["labels malformed stderr when stdout is blank", "stderr", " \n", `\t{]\n${rawDetail}  `],
  [
    "rejects malformed status fields after preserving redacted artifacts",
    "status",
    `{"backup":{"decryptionKeyCached":"yes"},"detail":"${rawDetail}"}`,
    stderr,
  ],
  ["rejects empty streams without a JSON parser cause", "empty", " \n", "\t "],
])("%s", async (_name, outcome, output, errorOutput) => {
  const root = tempDirs.make("matrix-qa-json-");
  const artifactDir = path.join(root, "artifacts");
  const artifacts = {
    stdoutPath: path.join(artifactDir, "json-output.stdout.txt"),
    stderrPath: path.join(artifactDir, "json-output.stderr.txt"),
  };
  const result: MatrixQaCliRunResult = { args, exitCode: 7, stdout: output, stderr: errorOutput };
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
  const pending = runMatrixQaCliJson({
    args,
    allowNonZero: true,
    stdin: "fixture-input\n",
    timeoutMs: 1_234,
    label: "json-output",
    runtime,
  });
  if (outcome === "success") {
    const actual = await pending;
    expect(actual.result).toBe(result);
    expect(actual.payload).toStrictEqual({
      success: false,
      backup: { matchesDecryptionKey: null, extra: false },
      imported: 0,
      values: [0, false, null, ""],
      detail: rawDetail,
    });
    expect(actual.artifacts).toEqual(artifacts);
  } else {
    const failure = await pending.catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(Error);
    const error = failure as Error;
    if (outcome === "status") {
      expect(error).toMatchObject({
        name: "ZodError",
        issues: [{ code: "invalid_type", path: ["backup", "decryptionKeyCached"] }],
      });
    } else if (outcome === "empty") {
      expect(error.message).toBe(`${command} did not print JSON`);
      expect(error).not.toHaveProperty("cause");
    } else {
      expect(error.cause).toBeInstanceOf(SyntaxError);
      expect(error.message).toBe(
        `${command} printed invalid JSON: ${(error.cause as Error).message}\n${outcome}:\n{]\n${redactedDetail}`,
      );
    }
  }
  expect(readFileSync(artifacts.stdoutPath, "utf8")).toBe(
    output.replaceAll(rawDetail, redactedDetail),
  );
  expect(readFileSync(artifacts.stderrPath, "utf8")).toBe(
    errorOutput.replaceAll(rawDetail, redactedDetail),
  );
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
});
