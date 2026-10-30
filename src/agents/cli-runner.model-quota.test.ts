import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { CURRENT_SESSION_VERSION } from "../config/sessions/version.js";
import { wrapRunWithTestPreparedAdmission } from "./admitted-run-context.test-support.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import { runCliAgent } from "./cli-runner.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
});

describe("CLI model quota failures", () => {
  it.each([
    [
      "You've reached your Fable limit. Switch to another model, or manage usage credits to continue.",
      "rate_limit",
    ],
    ["You've reached your Sonnet 4.6 limit. Switch to another model to continue.", "rate_limit"],
    ["You've reached your turn limit.", "unknown"],
  ] as const)(
    "classifies real subprocess output %s as %s with the requested model",
    async (error, reason) => {
      const dir = tempDirs.make("openclaw-cli-model-quota-");
      const scriptPath = path.join(dir, "quota.mjs");
      const sessionFile = path.join(dir, "agents", "main", "sessions", "session-test.jsonl");
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(
        sessionFile,
        `${JSON.stringify({
          type: "session",
          version: CURRENT_SESSION_VERSION,
          id: "session-test",
          timestamp: new Date(0).toISOString(),
          cwd: dir,
        })}\n`,
      );
      fs.writeFileSync(
        scriptPath,
        `process.stdout.write(${JSON.stringify(JSON.stringify({ type: "result", is_error: true, errors: [error] }) + "\n")});`,
      );
      cliBackendsTesting.setDepsForTest({
        resolveRuntimeCliBackends: () => [
          {
            id: "fixture-cli",
            pluginId: "fixture",
            config: {
              command: process.execPath,
              args: [scriptPath],
              output: "jsonl",
              jsonlDialect: "claude-stream-json",
              input: "arg",
              sessionMode: "none",
              systemPromptWhen: "never",
            },
          },
        ],
      });
      await expect(
        wrapRunWithTestPreparedAdmission(runCliAgent)({
          sessionId: "session-test",
          sessionKey: "agent:main:quota-fixture",
          sessionFile,
          workspaceDir: dir,
          prompt: "quota fixture",
          provider: "fixture-cli",
          model: "claude-fable-5-1",
          timeoutMs: 5_000,
          runId: "run-model-quota",
          config: { agents: { defaults: { workspace: dir } } },
        }),
      ).rejects.toMatchObject({ reason, model: "claude-fable-5-1" });
    },
  );
});
