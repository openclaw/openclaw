import { afterEach, describe, expect, it, vi } from "vitest";
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
import { findDuplicateGuardImageGenerationTaskForSession } from "./media-generation-task-status.js";

function createOperation(
  taskId: string,
  requesterSessionKey: string,
  overrides: Partial<Parameters<typeof createMediaGenerationOperation>[0]> = {},
) {
  return createMediaGenerationOperation({
    taskId,
    runId: taskId,
    requesterSessionKey,
    requesterAgentId: "main",
    taskKind: "image_generation",
    sourceId: "image_generate:test",
    task: "draw a tree",
    requestKey: "same-request",
    status: "running",
    ...overrides,
  });
}
const findDuplicate = (
  sessionKey: string,
  prompt = "draw a tree",
  requestKey = "same-request",
  agentId = "main",
) => findDuplicateGuardImageGenerationTaskForSession(sessionKey, { prompt, requestKey, agentId });

afterEach(() => {
  resetGeneratedMediaTaskActivityForTests();
  vi.restoreAllMocks();
});
describe("native media operation lifetime", () => {
  it("keeps shared bare session keys agent-scoped and retires stale process ownership", async () => {
    const before = getGeneratedMediaTaskIdsForSessionKey("shared", "one");
    for (const agent of ["one", "two"]) {
      createOperation(agent, "shared", {
        requesterAgentId: agent,
        sourceId: "image_generate:synthetic",
        task: "a synthetic lighthouse",
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
    expect(
      await findDuplicate("shared", "a synthetic lighthouse", "same-request", "one"),
    ).toMatchObject({ runId: "one", status: "running" });
    rotateAgentRunRegistryLifecycleGeneration();
    expect(isMediaGenerationOperationCurrent("one")).toBe(false);
    expect(getActiveMediaGenerationRunCount()).toBe(0);
    expect(listMediaGenerationOperations("shared", "one")).toEqual([]);
    expect(
      await findDuplicate("shared", "a synthetic lighthouse", "same-request", "one"),
    ).toBeUndefined();
  });
  it("blocks duplicate provider work, retains attempt admission after completion, and releases restart custody", async () => {
    const sessionKey = "agent:main:cron:media:run:one";
    const before = getGeneratedMediaTaskIdsForSessionKey(sessionKey);
    const operation = createOperation("image:1", sessionKey);
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
    expect(await findDuplicate(sessionKey)).toBe(operation);
    expect(
      await findDuplicate(sessionKey, "draw something different", "different-request"),
    ).toBeUndefined();
  });
  it.each([
    { age: 120_001, retained: false },
    { age: 1_000, retained: true },
  ])("owns recent completion expiry at $age ms", async ({ age, retained }) => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const operation = createOperation("image:recent", "agent:main:main", {
      status: "succeeded",
      endedAt: now - age,
    });
    expect(
      await findDuplicateGuardImageGenerationTaskForSession("agent:main:main", {
        requestKey: "same-request",
        agentId: "main",
      }),
    ).toBe(retained ? operation : undefined);
  });
});
