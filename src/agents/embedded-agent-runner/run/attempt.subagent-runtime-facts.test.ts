import { existsSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import { resolvePhysicalSessionStorePath } from "../../../config/sessions/session-store-path.js";
import { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../../internal-runtime-context.js";
import type { SubagentRunRecord } from "../../subagents/registry/subagent-registry.types.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { useContextEngineAttemptHarness } from "./attempt-context-engine.test-support.js";
import { resetEmbeddedAttemptHarness } from "./attempt-spawn-workspace.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionKey = "agent:main:runtime-facts";
const { hoisted, runAttempt } = useContextEngineAttemptHarness(sessionKey);
let registry: typeof import("../../subagents/registry/subagent-registry.test-helpers.js");

async function captureAttempt(sessionStore: string) {
  resetEmbeddedAttemptHarness();
  const config = { session: { store: sessionStore } };
  setRuntimeConfigSnapshot(config);
  hoisted.createOpenClawCodingToolsMock.mockReturnValue([createStubTool("sessions_spawn")]);
  let captured: { systemPrompt: string | undefined; messages: unknown[] } | undefined;
  const result = await runAttempt({
    attemptOverrides: {
      config,
      sessionTarget: {
        agentId: "main",
        sessionId: "embedded-session",
        sessionKey,
        storePath: sessionStore,
      },
      codeModeOverride: true,
      disableTools: false,
      trigger: "user",
      sessionPersistence: "detached",
    },
    sessionPrompt: async (session) => {
      captured = {
        systemPrompt: session.agent.state.systemPrompt,
        messages: structuredClone(session.messages),
      };
    },
  });
  expect(result.terminal).toMatchObject({ kind: "ok" });
  return expectDefined(captured, "provider submission after history and prompt preparation");
}

function expectSubagentCarrier(messages: unknown[], state: string | RegExp) {
  expect(messages.at(-1)).toMatchObject({
    role: "custom",
    customType: OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
    display: false,
    content:
      typeof state === "string" ? expect.stringContaining(state) : expect.stringMatching(state),
  });
}

beforeAll(async () => {
  registry = await import("../../subagents/registry/subagent-registry.test-helpers.js");
});
beforeEach(() => registry.resetSubagentRegistryForTests({ persist: false }));
afterEach(async () => {
  await registry.resetSubagentRegistryForTests({ persist: false });
  clearRuntimeConfigSnapshot();
});

it("preserves the complete system prompt across child state in code mode", async () => {
  const sessionStore = path.join(tempDirs.make("subagent-facts-"), "sessions.json");
  const storePath = resolvePhysicalSessionStorePath({ sessionKey, storePath: sessionStore });
  const run = {
    runId: "run-worker",
    childSessionKey: "agent:main:subagent:worker",
    controllerSessionKey: sessionKey,
    requesterSessionKey: sessionKey,
    requesterStorePath: storePath,
    controllerStorePath: storePath,
    requesterDisplayKey: "main",
    task: "Inspect fixtures",
    cleanup: "keep",
    createdAt: Date.now(),
    execution: { status: "queued" },
  } satisfies SubagentRunRecord;
  registry.seedSubagentRunForReadTest(run);
  const queued = await captureAttempt(sessionStore);
  expect(existsSync(storePath)).toBe(false);
  registry.seedSubagentRunForReadTest({
    ...run,
    execution: { status: "running", startedAt: Date.now() },
  });
  const running = await captureAttempt(sessionStore);
  await registry.resetSubagentRegistryForTests({ persist: false });
  const empty = await captureAttempt(sessionStore);

  expect(queued.systemPrompt).toContain("system prompt");
  expect(running.systemPrompt).toBe(queued.systemPrompt);
  expect(empty.systemPrompt).toBe(queued.systemPrompt);
  expect(queued.systemPrompt).not.toContain("run-worker");
  expectSubagentCarrier(queued.messages, "status=queued");
  expectSubagentCarrier(running.messages, "status=running");
  expectSubagentCarrier(
    empty.messages,
    /^## Temporal Context\nCurrent date: \d{4}-\d{2}-\d{2}\nTime zone: [^\n]+$/,
  );
});
