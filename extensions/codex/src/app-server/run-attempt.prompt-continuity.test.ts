import fs from "node:fs/promises";
import path from "node:path";
import { openFileBackedSessionManagerForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  assistantMessage,
  createParams,
  createResumeHarness,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  userMessage,
} from "./run-attempt-test-harness.js";
import { writeExistingBinding } from "./run-attempt.existing-binding.test-support.js";
import { readCodexAppServerBinding } from "./session-binding.test-helpers.js";

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

// Codex -> Gemini/Claude -> Codex: the host seed covers fresh threads only, so a resumed
// thread must still receive the turns another model added while Codex was not selected.
it("injects only turns from another model when selected history resumes a Codex thread", async () => {
  const sessionFile = path.join(tempDir, "session.jsonl");
  const workspaceDir = path.join(tempDir, "workspace");
  const params = createParams(sessionFile, workspaceDir);
  await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
  const coveredThrough = Date.parse(
    (await readCodexAppServerBinding(sessionFile))?.historyCoveredThrough ?? "",
  );
  const session = openFileBackedSessionManagerForTest(sessionFile, { sessionId: "session-1" });
  session.appendMessage(userMessage("old native-owned context", coveredThrough - 2_000));
  session.appendMessage(
    userMessage("GEMINI_DELTA_USER: pick the blue rollout", coveredThrough + 1_000),
  );
  session.appendMessage({
    ...assistantMessage("GEMINI_DELTA_ASSISTANT: blue rollout chosen", coveredThrough + 2_000),
    provider: "google",
    model: "gemini-3-pro",
  });
  const prepareBoundedSeed = vi.fn(async () => []);
  params.hostCapabilities = { ...params.hostCapabilities, prepareBoundedSeed };
  params.contextTokenBudget = 200_000;
  params.prompt = "continue on Codex";
  const harness = createResumeHarness();

  const run = runCodexAppServerAttempt(params);
  await harness.waitForMethod("turn/start");
  await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
  await run;

  const methods = harness.requests.map((request) => request.method);
  expect(methods).toContain("thread/resume");
  expect(methods).not.toContain("thread/start");
  expect(prepareBoundedSeed).not.toHaveBeenCalled();
  const injected = JSON.stringify(
    harness.requests.filter((request) => request.method === "thread/inject_items"),
  );
  expect(injected).toContain("GEMINI_DELTA_USER: pick the blue rollout");
  expect(injected).toContain("GEMINI_DELTA_ASSISTANT: blue rollout chosen");
  expect(injected).not.toContain("old native-owned context");
  const turnStart = JSON.stringify(
    harness.requests.find((request) => request.method === "turn/start")?.params,
  );
  expect(turnStart).not.toContain("GEMINI_DELTA");
});
