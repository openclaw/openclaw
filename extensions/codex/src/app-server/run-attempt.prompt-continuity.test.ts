import fs from "node:fs/promises";
import path from "node:path";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { writeExistingBinding } from "./run-attempt.existing-binding.test-support.js";

setupRunAttemptTestHooks();

describe("Codex prompt continuity", () => {
  it.each([
    { name: "the token fuse rotates it", tokenPressure: true, tools: "[]" },
    { name: "a new thread replaces it without history", tokenPressure: false, tools: '["stale"]' },
  ])("reports a discarded binding as invalidated when $name", async (scenario) => {
    const hook = vi.fn((event: unknown) =>
      (event as { continuity?: { state: string } }).continuity?.state === "invalidated"
        ? { prependContext: "restored notes" }
        : undefined,
    );
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_prompt_build", requiresToolAuthority: true, handler: hook },
      ]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, {
      dynamicToolsFingerprint: scenario.tools,
    });
    if (scenario.tokenPressure) {
      // The bound native rollout reports a full context, so connection setup rotates it.
      const rolloutDir = path.join(agentDir, "codex-home", "sessions");
      await fs.mkdir(rolloutDir, { recursive: true });
      await fs.writeFile(
        path.join(rolloutDir, "rollout-thread-existing.jsonl"),
        `${JSON.stringify({ payload: { type: "token_count", info: { total_token_usage: { total_tokens: 300_000 } } } })}\n`,
      );
    }
    const params = createParams(sessionFile, workspaceDir);
    params.agentDir = agentDir;
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await waitForMethod("turn/start");
    await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    const methods = requests.map((request) => request.method);
    expect(methods).toContain("thread/start");
    expect(methods).not.toContain("thread/resume");
    expect(hook.mock.calls.at(-1)?.[0]).toMatchObject({
      continuity: { state: "invalidated", history: "none" },
    });
    const turnStart = requests.find((request) => request.method === "turn/start")?.params as
      | { input?: Array<{ type: string; text?: string }> }
      | undefined;
    expect(turnStart?.input?.[0]?.text).toContain("restored notes");
  });
});
