import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessContextEngine as ContextEngine } from "openclaw/plugin-sdk/agent-harness-runtime";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
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
import { writeExistingBinding } from "./run-attempt.existing-binding.test-support.js";
import { readCodexAppServerBinding } from "./session-binding.test-helpers.js";

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt native context budget", () => {
  it.each([
    "current request",
    "rendered prompt hook",
    "request after native rotation",
    "late replacement prompt hook",
  ] as const)(
    "rejects an oversized %s before starting inference or binding a cold native thread",
    async (source) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const params = createParams(sessionFile, path.join(tempDir, "workspace"));
      params.agentDir = path.join(tempDir, "agent");
      params.authoredContextTokenCap = 32_000;
      // This is well under the native RPC text limit but over the authored model cap.
      const oversizedText = "Synthetic request with mandatory text. ".repeat(6_000);
      const lateReplacement = source === "late replacement prompt hook";
      if (source === "current request" || source === "request after native rotation") {
        params.prompt = oversizedText;
      } else {
        initializeGlobalHookRunner(
          createMockPluginRegistry([
            {
              hookName: "before_prompt_build",
              ...(lateReplacement ? { requiresToolAuthority: true } : {}),
              handler: (event: unknown) =>
                lateReplacement
                  ? (event as { continuity?: { state: string } }).continuity?.state ===
                    "invalidated"
                    ? { prependContext: oversizedText }
                    : undefined
                  : { prependSystemContext: oversizedText },
            },
          ]),
        );
      }
      if (source === "request after native rotation") {
        await writeExistingBinding(sessionFile, params.workspaceDir);
        const rolloutDir = path.join(params.agentDir, "codex-home", "sessions");
        await fs.mkdir(rolloutDir, { recursive: true });
        await fs.writeFile(
          path.join(rolloutDir, "rollout-thread-existing.jsonl"),
          `${JSON.stringify({ payload: { type: "token_count", info: { total_token_usage: { total_tokens: 300_000 } } } })}\n`,
        );
      }
      if (lateReplacement) {
        await writeExistingBinding(sessionFile, params.workspaceDir, {
          dynamicToolsFingerprint: '["stale"]',
        });
      }
      const predecessor = lateReplacement && (await readCodexAppServerBinding(sessionFile));
      params.hostCapabilities = {
        ...params.hostCapabilities,
        prepareBoundedSeed: async () => [],
      };
      const harness = createStartedThreadHarness(async (method) => {
        if (method === "turn/start") {
          throw new Error("Oversized request reached the synthetic native inference boundary");
        }
        return undefined;
      });

      await expect.soft(runCodexAppServerAttempt(params)).rejects.toThrow(/context budget/i);

      const methods = harness.requests.map(({ method }) => method);
      expect.soft(methods).not.toContain("turn/start");
      expect.soft(methods).not.toContain("thread/start");
      expect.soft(methods).not.toContain("thread/resume");
      await expect(readCodexAppServerBinding(sessionFile)).resolves.toEqual(
        lateReplacement ? predecessor : undefined,
      );
    },
  );

  it("admits current input that fits without reserving optional framing for an empty seed", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const params = createParams(sessionFile, path.join(tempDir, "workspace"));
    params.agentDir = path.join(tempDir, "agent");
    params.authoredContextTokenCap = 32_000;
    params.prompt = "Synthetic request with mandatory text. ".repeat(720);
    const prepareBoundedSeed = vi.fn(async () => []);
    params.hostCapabilities = { ...params.hostCapabilities, prepareBoundedSeed };
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(params);
    await Promise.race([harness.waitForMethod("turn/start"), run]);
    await harness.completeTurn();
    await run;

    expect(prepareBoundedSeed).toHaveBeenCalledWith(expect.objectContaining({ tokenBudget: 1 }));
    expect(harness.requests.map(({ method }) => method)).not.toContain("thread/inject_items");
  });

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
