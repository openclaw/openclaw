import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessContextEngine as ContextEngine } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import { setupRunAttemptTestHooks, tempDir } from "./run-attempt-test-harness.js";
import {
  createContextEngine,
  createParams,
  createStartedThreadHarness,
  makeThreadBootstrapBinding,
  runCodexAppServerAttempt,
  writeCodexAppServerBinding,
} from "./run-attempt.context-engine.test-support.js";

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt native context budget", () => {
  it.each([
    ["matching model", "gpt-5.4-codex", false, undefined, undefined, 258_400],
    ["provider-qualified model", "openai/gpt-5.4-codex", false, undefined, undefined, 258_400],
    ["different model", "gpt-5.4-codex-mini", false, undefined, undefined, undefined],
    ["newer unreported turn", "gpt-5.4-codex", true, undefined, undefined, undefined],
    ["lowered authored cap", "gpt-5.4-codex", false, 32_000, undefined, 32_000],
    ["resolved budget", "gpt-5.4-codex", false, undefined, 80_000, 80_000],
    ["authored cap before observation", undefined, false, 500_000, undefined, 500_000],
    ["unknown window", undefined, false, undefined, undefined, undefined],
  ] as const)(
    "supplies the assembly budget for %s",
    async (
      _case,
      bindingModel,
      newerUnreportedTurn,
      authoredCap,
      resolvedBudget,
      expectedBudget,
    ) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const agentDir = path.join(tempDir, "agent");
      if (bindingModel) {
        await writeCodexAppServerBinding(sessionFile, {
          ...makeThreadBootstrapBinding({
            threadId: "thread-reported-window",
            cwd: workspaceDir,
            policyFingerprint:
              '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"projectionMaxChars":24000}',
            epoch: "epoch-1",
          }),
          model: bindingModel,
          modelProvider: "openai",
        });
        const rolloutDir = path.join(agentDir, "codex-home", "sessions");
        await fs.mkdir(rolloutDir, { recursive: true });
        await fs.writeFile(
          path.join(rolloutDir, "rollout-thread-reported-window.jsonl"),
          [
            { type: "turn_context", payload: { model: "gpt-5.4-codex" } },
            {
              type: "event_msg",
              payload: {
                type: "token_count",
                info: { last_token_usage: { total_tokens: 20_000 }, model_context_window: 258_400 },
              },
            },
            ...(newerUnreportedTurn
              ? [{ type: "turn_context", payload: { model: "gpt-5.4-codex" } }]
              : []),
          ]
            .map((line) => `${JSON.stringify(line)}\n`)
            .join(""),
        );
      }
      const assemble = vi.fn<ContextEngine["assemble"]>(async () => ({
        messages: [],
        estimatedTokens: 0,
      }));
      const contextEngine = createContextEngine({ assemble });
      const params = createParams(sessionFile, workspaceDir);
      params.agentDir = agentDir;
      params.contextEngine = contextEngine;
      params.contextTokenBudget = resolvedBudget;
      params.authoredContextTokenCap = authoredCap;
      const harness = createStartedThreadHarness();

      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");

      expect(assemble).toHaveBeenCalledOnce();
      const assembly = assemble.mock.calls[0]?.[0];
      expect(assembly?.runtimeSettings?.limits.promptTokenBudget).toBe(
        assembly?.tokenBudget ?? null,
      );
      if (authoredCap !== undefined && expectedBudget !== undefined) {
        expect(assembly?.tokenBudget).toBeGreaterThan(0);
        expect(assembly?.tokenBudget).toBeLessThan(expectedBudget);
      } else {
        expect(assembly?.tokenBudget).toBe(expectedBudget);
      }

      await harness.completeTurn();
      await run;
    },
  );
});
