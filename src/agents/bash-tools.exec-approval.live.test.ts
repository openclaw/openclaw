import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { saveExecApprovals } from "../infra/exec-approvals.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { createModelExecAutoReviewer } from "./exec-auto-reviewer.js";
import { isLiveTestEnabled } from "./live-test-helpers.js";

const live = isLiveTestEnabled(["ANTHROPIC_LIVE_TEST"]) && Boolean(process.env.ANTHROPIC_API_KEY);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(!live || process.platform === "win32")("exec approval with a live reviewer", () => {
  it("executes the reviewed glob despite shell startup customization", async () => {
    const root = tempDirs.make("exec-approval-live-");
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is required");
    }
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: root, model: "anthropic/claude-sonnet-4-6" } },
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            api: "anthropic-messages",
            apiKey,
            // This lane owns approval behavior, independently of refreshable catalog state.
            models: [
              {
                id: "claude-sonnet-4-6",
                name: "Claude Sonnet 4.6",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200_000,
                maxTokens: 64_000,
              },
            ],
          },
        },
      },
    };
    // Keep the credential in the provider configuration, out of the exec environment.
    await withEnvAsync(
      {
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_HOME: root,
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        ZDOTDIR: root,
        SHELL: "/bin/bash",
        PATH: "/usr/bin:/bin",
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_OAUTH_TOKEN: undefined,
        OPENCLAW_EXEC_SHELL_SNAPSHOT: "1",
      },
      async () => {
        fs.writeFileSync(path.join(root, "approved.txt"), "fixture");
        fs.writeFileSync(path.join(root, ".bashrc"), "ls() { printf 'UNREVIEWED_FUNCTION\\n'; }\n");
        saveExecApprovals({
          version: 1,
          defaults: { security: "allowlist", ask: "on-miss", askFallback: "deny" },
          agents: {},
        });
        const scope = new AsyncWorkScope();
        let reviews = 0;
        let decision: string | undefined;
        let rationale: string | undefined;
        const reviewer = createModelExecAutoReviewer({
          cfg,
          agentId: "main",
          reviewer: { timeoutMs: 60_000 },
        });
        const tool = createExecTool({
          config: cfg,
          agentId: "main",
          host: "gateway",
          mode: "auto",
          safeBins: [],
          cwd: root,
          notifyOnExit: false,
          nonInteractiveApproval: true,
          autoReviewer: async (input) => {
            reviews += 1;
            const reviewed = await reviewer(input);
            decision = reviewed.decision;
            rationale = reviewed.rationale;
            return reviewed;
          },
          reviewTranscript: () => ({
            entries: [
              {
                kind: "user",
                origin: "operator",
                text: "List the approved text files in this temporary working directory.",
              },
            ],
            omittedEntries: 0,
            truncated: false,
          }),
        });
        try {
          const result = await scope.track(() =>
            tool.execute("live-approved-listing", { command: "ls *.txt" }),
          );
          console.log(JSON.stringify({ reviews, decision, rationale }));
          expect(reviews).toBe(1);
          expect(decision).toBe("allow-once");
          if (result.details.status !== "completed") {
            throw new Error(`Unexpected exec status: ${result.details.status}`);
          }
          expect(result.details.exitCode).toBe(0);
          expect(result.details.aggregated).toBe("approved.txt");
          console.log(
            JSON.stringify({
              reviews,
              decision,
              exitCode: result.details.exitCode,
              stdout: result.details.aggregated,
            }),
          );
        } finally {
          await scope.drain();
          resetProcessRegistryForTests();
          closeOpenClawStateDatabaseForTest();
        }
      },
    );
  }, 150_000);
});
