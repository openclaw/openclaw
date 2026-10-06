import { afterEach, describe, expect, it } from "vitest";
import { rotateAgentRunRegistryLifecycleGeneration } from "../infra/agent-run-registry.js";
import {
  clearGeneratedMediaTaskActivity,
  createMediaGenerationOperation,
  getActiveMediaGenerationRunCount,
  getGeneratedMediaTaskIdsForSessionKey,
  hasNewGeneratedMediaTaskForSessionKey,
  hasPendingGeneratedMediaTaskForSessionKey,
  isMediaGenerationOperationCurrent,
  listMediaGenerationOperations,
  updateMediaGenerationOperation,
} from "./media-generation-activity.js";
import { resetGeneratedMediaTaskActivityForTests } from "./media-generation-activity.test-support.js";
import { recordRecentMediaGenerationTaskStartForSession } from "./media-generation-task-status-shared.js";
import { resetRecentMediaGenerationDuplicateGuardsForTests } from "./media-generation-task-status-shared.test-support.js";
import { findDuplicateGuardImageGenerationTaskForSession } from "./media-generation-task-status.js";
afterEach(() => {
  resetGeneratedMediaTaskActivityForTests();
  resetRecentMediaGenerationDuplicateGuardsForTests();
});
describe("native media operation lifetime", () => {
  it("keeps shared bare session keys agent-scoped and retires stale process ownership", async () => {
    const before = getGeneratedMediaTaskIdsForSessionKey("shared", "one");
    for (const agent of ["one", "two"]) {
      createMediaGenerationOperation({
        taskId: agent,
        runId: agent,
        requesterSessionKey: "shared",
        requesterAgentId: agent,
        taskKind: "image_generation",
        sourceId: "image_generate:synthetic",
        task: "a synthetic lighthouse",
        status: "running",
        createdAt: Date.now(),
      });
    }
    expect(listMediaGenerationOperations("shared")).toEqual([]);
    expect(
      listMediaGenerationOperations("shared", "one").map((operation) => operation.taskId),
    ).toEqual(["one"]);
    expect(getGeneratedMediaTaskIdsForSessionKey("shared", "one")).not.toContain("two");
    expect(hasNewGeneratedMediaTaskForSessionKey("shared", before, "one")).toBe(true);
    expect(hasNewGeneratedMediaTaskForSessionKey("shared", before)).toBe(false);
    const oneAdmissions = getGeneratedMediaTaskIdsForSessionKey("shared", "one");
    expect(hasNewGeneratedMediaTaskForSessionKey("shared", oneAdmissions, "one")).toBe(false);
    expect(hasNewGeneratedMediaTaskForSessionKey("shared", oneAdmissions, "two")).toBe(true);
    expect(getActiveMediaGenerationRunCount()).toBe(2);
    recordRecentMediaGenerationTaskStartForSession({
      sessionKey: "shared",
      agentId: "one",
      taskKind: "image_generation",
      sourcePrefix: "image_generate",
      taskId: "one",
      runId: "one",
      taskLabel: "a synthetic lighthouse",
      requestKey: "same-request",
      progressSummary: "generating",
    });
    expect(
      await findDuplicateGuardImageGenerationTaskForSession("shared", {
        agentId: "one",
        prompt: "a synthetic lighthouse",
        requestKey: "same-request",
      }),
    ).toMatchObject({ runId: "one", status: "running" });
    rotateAgentRunRegistryLifecycleGeneration();
    expect(isMediaGenerationOperationCurrent("one")).toBe(false);
    expect(getActiveMediaGenerationRunCount()).toBe(0);
    expect(listMediaGenerationOperations("shared", "one")).toEqual([]);
    expect(
      await findDuplicateGuardImageGenerationTaskForSession("shared", {
        agentId: "one",
        prompt: "a synthetic lighthouse",
        requestKey: "same-request",
      }),
    ).toBeUndefined();
  });
  it("blocks duplicate provider work, retains attempt admission after completion, and releases restart custody", async () => {
    const sessionKey = "agent:main:cron:media:run:one";
    const before = getGeneratedMediaTaskIdsForSessionKey(sessionKey);
    const operation = createMediaGenerationOperation({
      taskId: "image:1",
      runId: "image:1",
      taskKind: "image_generation",
      sourceId: "image_generate:test",
      requesterSessionKey: sessionKey,
      requesterAgentId: "main",
      task: "draw a tree",
      status: "running",
      createdAt: Date.now(),
    });
    recordRecentMediaGenerationTaskStartForSession({
      sessionKey,
      agentId: "main",
      taskKind: "image_generation",
      sourcePrefix: "image_generate",
      taskId: operation.taskId,
      runId: operation.runId,
      taskLabel: "draw a tree",
      requestKey: "same-request",
      progressSummary: "generating",
    });
    expect(
      await findDuplicateGuardImageGenerationTaskForSession(sessionKey, {
        prompt: "draw a tree",
        agentId: "main",
      }),
    ).toBe(operation);
    expect(getActiveMediaGenerationRunCount()).toBe(1);
    expect(hasPendingGeneratedMediaTaskForSessionKey(sessionKey)).toBe(true);
    updateMediaGenerationOperation("image:1", { status: "succeeded", endedAt: Date.now() });
    clearGeneratedMediaTaskActivity("image:1");
    expect(getActiveMediaGenerationRunCount()).toBe(0);
    expect(hasPendingGeneratedMediaTaskForSessionKey(sessionKey)).toBe(false);
    expect(hasNewGeneratedMediaTaskForSessionKey(sessionKey, before)).toBe(true);
    expect(
      await findDuplicateGuardImageGenerationTaskForSession(sessionKey, {
        prompt: "draw a tree",
        requestKey: "same-request",
        agentId: "main",
      }),
    ).toBe(operation);
    expect(
      await findDuplicateGuardImageGenerationTaskForSession(sessionKey, {
        prompt: "draw something different",
        requestKey: "different-request",
        agentId: "main",
      }),
    ).toBeUndefined();
  });
});
