import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { CURRENT_SESSION_VERSION } from "../config/sessions/version.js";
import { wrapRunWithTestPreparedAdmission } from "./admitted-run-context.test-support.js";
import { saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import type { AuthProfileCredential } from "./auth-profiles/types.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import { runCliAgent } from "./cli-runner.js";
import { isFailoverError } from "./failover-error.js";
import { renderBillingReplyCopy } from "./failover/user-copy.js";
import { recordFailedCandidateAttempt } from "./model-fallback-attempt.js";
import type { FallbackAttempt } from "./model-fallback.types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  vi.unstubAllEnvs();
});

describe("CLI billing recovery", () => {
  it.each([
    { label: "native Claude login", provider: "claude-cli", authMode: "cli", plugin: false },
    { label: "selected OAuth profile", provider: "fixture-cli", authMode: "oauth", plugin: false },
    { label: "selected token profile", provider: "fixture-cli", authMode: "token", plugin: false },
    {
      label: "selected API key profile",
      provider: "fixture-cli",
      authMode: "api_key",
      plugin: false,
    },
    { label: "native Claude plugin login", provider: "claude-cli", authMode: "cli", plugin: true },
  ] as const)(
    "preserves $label facts from preparation through a backend failure",
    async ({ provider, authMode, plugin }) => {
      const dir = tempDirs.make("openclaw-cli-billing-");
      vi.stubEnv("OPENCLAW_STATE_DIR", dir);
      const agentDir = path.join(dir, "agents", "main", "agent");
      const sessionFile = path.join(dir, "session.jsonl");
      const scriptPath = path.join(dir, "billing.mjs");
      fs.writeFileSync(
        sessionFile,
        `${JSON.stringify({
          type: "session",
          version: CURRENT_SESSION_VERSION,
          id: "billing-session",
          timestamp: new Date(0).toISOString(),
          cwd: dir,
        })}\n`,
      );
      fs.writeFileSync(
        scriptPath,
        'process.stderr.write("Credit balance is too low"); process.exitCode = 1;\n',
      );
      const authProfileId = authMode === "cli" ? undefined : `${provider}:selected`;
      if (authProfileId) {
        const credential: AuthProfileCredential =
          authMode === "oauth"
            ? {
                type: "oauth",
                provider,
                access: "fixture-access",
                refresh: "fixture-refresh",
                expires: Date.now() + 3_600_000,
              }
            : authMode === "token"
              ? { type: "token", provider, token: "fixture-token" }
              : { type: "api_key", provider, key: "fixture-key" };
        saveAuthProfileStore({ version: 1, profiles: { [authProfileId]: credential } }, agentDir);
      }
      cliBackendsTesting.setDepsForTest({
        resolveRuntimeCliBackends: () => [
          {
            id: provider,
            pluginId: "billing-fixture",
            autoSelectAuthProfile: false,
            ...(plugin
              ? {
                  prepareExecution: async () => ({
                    execute: async function* () {
                      yield { type: "result", is_error: true, result: "Credit balance is too low" };
                    },
                  }),
                }
              : {}),
            config: {
              command: process.execPath,
              args: [scriptPath],
              output: plugin ? "jsonl" : "text",
              input: "arg",
              sessionMode: "none",
              systemPromptWhen: "never",
            },
          },
        ],
      });

      const error: unknown = await wrapRunWithTestPreparedAdmission(runCliAgent)({
        sessionId: "billing-session",
        sessionKey: "agent:main:billing",
        sessionFile,
        workspaceDir: dir,
        agentDir,
        authProfileId,
        prompt: "hello",
        provider,
        model: "fixture-model",
        timeoutMs: 5_000,
        runId: "billing-run",
        config: { agents: { defaults: { workspace: dir } } },
      }).catch((error: unknown) => error);
      expect(isFailoverError(error)).toBe(true);
      expect(error).toMatchObject({ reason: "billing", authMode });
      const attempts: FallbackAttempt[] = [];
      recordFailedCandidateAttempt({
        attempts,
        candidate: { provider, model: "fixture-model" },
        error,
        attempt: 1,
        total: 1,
        isPrimary: true,
        requestedModelMatched: true,
        fallbackConfigured: false,
      });
      expect(attempts[0]).toMatchObject({ reason: "billing", authMode });
      const reply = renderBillingReplyCopy({ attempts });
      if (authMode === "api_key") {
        expect(reply).toContain("your API key has run out of credits");
      } else {
        expect(reply).not.toContain("API key");
        expect(reply).toContain(
          authMode === "cli" ? "account used by this CLI" : "subscription or usage limits",
        );
      }
    },
  );
});
