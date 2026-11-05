// The durable-text decision for a repaired orphan must be observed through the production
// prompt assembly (prepareEmbeddedAttemptPromptAssembly), not through the helper alone: the
// helper can be correct while its caller wires the wrong prompt into the persisted turn.
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { forgetPromptBuildDrainCacheForRun } from "../../plugin-turn-context.js";
import {
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { resolveOrphanRepairPlan } from "./attempt-orphan-repair.js";
import { prepareEmbeddedAttemptPromptAssembly } from "./attempt-prompt-build.js";

type PromptAssemblyInput = Parameters<typeof prepareEmbeddedAttemptPromptAssembly>[0];

registerAgentSessionLoopTestLifecycle();

afterEach(() => {
  clearRuntimeConfigSnapshot();
});

const ORPHAN_TEXT = "orphan wake";
const NEW_TEXT = "new request";

async function assembleWithPersistedOrphan(options: { excludeFromContext?: boolean } = {}) {
  const runId = "orphan-durable-prompt-test";
  setRuntimeConfigSnapshot({});
  const { session, sessionManager } = await createTestSession({
    customTools: [createStubTool("read")],
  });
  const admission = prepareSystemAgentRunAdmission({}, runId, "main", runId);
  onTestFinished(() => {
    admission.close();
    forgetPromptBuildDrainCacheForRun(runId);
  });
  // A persisted-but-unanswered user row: the exact leaf the boundary repair plans against.
  await sessionManager.appendMessageAsync({
    role: "user",
    content: ORPHAN_TEXT,
    timestamp: 1,
    ...(options.excludeFromContext ? { excludeFromContext: true } : {}),
  });
  const orphanRepair = resolveOrphanRepairPlan({
    sessionManager,
    prompt: NEW_TEXT,
    preserveLeaf: false,
    currentTurnPersisted: false,
  });
  const attempt: PromptAssemblyInput["attempt"] = {
    admittedRunContext: await admission.admit("embedded"),
    config: {},
    model: testModel,
    provider: testModel.provider,
    prompt: NEW_TEXT,
    transcriptPrompt: NEW_TEXT,
    runId,
    sessionId: runId,
    sessionKey: `agent:main:${runId}`,
    sessionPersistence: "detached",
    trigger: "user",
    workspaceDir: "/tmp/orphan-durable-prompt-test",
  };
  const assembly = await prepareEmbeddedAttemptPromptAssembly({
    attempt,
    activeSession: session,
    sessionManager,
    hookRunner: null,
    hookAgentId: "main",
    diagnosticTrace: { traceId: "11111111111111111111111111111111" },
    isRawModelRun: false,
    sessionAgentId: "main",
    runtimeModel: testModel.id,
    systemPromptText: "Base system prompt",
    runAbortSignal: new AbortController().signal,
    hasBaselineTools: () => session.getActiveToolNames().length > 0,
    applyPromptBuildToolsAllow: () => [],
    setActiveSessionSystemPrompt: () => {},
    orphanRepair,
  });
  return { orphanRepair, assembly };
}

describe("orphan repair durable text through production prompt assembly", () => {
  it("persists only the new turn text when the merged external leaf is preserved", async () => {
    const { orphanRepair, assembly } = await assembleWithPersistedOrphan();

    expect(orphanRepair?.removeLeaf).toBe(false);
    expect(orphanRepair?.durableLeafCarriesMergedText).toBe(true);
    // The preserved leaf already shows the orphan text in history, so the durable row
    // for the new turn must not repeat it, while the model prompt carries it exactly once.
    expect(assembly.effectiveTranscriptPrompt).toBe(NEW_TEXT);
    expect(assembly.effectivePrompt.match(new RegExp(ORPHAN_TEXT, "g"))).toHaveLength(1);
    expect(assembly.effectivePrompt).toContain(NEW_TEXT);
  });

  it("merges the orphan text into the durable row when the leaf is removed", async () => {
    const { orphanRepair, assembly } = await assembleWithPersistedOrphan({
      excludeFromContext: true,
    });

    expect(orphanRepair?.removeLeaf).toBe(true);
    expect(orphanRepair?.durableLeafCarriesMergedText).toBe(false);
    // The removed leaf's text survives only through the replacement durable row.
    expect(assembly.effectiveTranscriptPrompt).toContain(ORPHAN_TEXT);
    expect(assembly.effectiveTranscriptPrompt).toContain(NEW_TEXT);
  });
});
