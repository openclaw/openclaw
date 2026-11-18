import { afterEach, describe, expect, it, vi } from "vitest";
import { rotateAgentRunRegistryLifecycleGeneration } from "../infra/agent-run-registry.js";
import {
  clearGeneratedMediaTaskActivity,
  createMediaGenerationOperation,
  getActiveMediaGenerationRunCount as activeCount,
  getGeneratedMediaTaskIdsForSessionKey as taskIds,
  hasNewGeneratedMediaTaskForSessionKey as hasNewTask,
  hasPendingGeneratedMediaTaskForSessionKey as hasPendingTask,
  isMediaGenerationOperationCurrent,
  listMediaGenerationOperations as listOperations,
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
  it.each(["shared", "agent:one:main"])(
    "isolates owners and retires stale work for %s",
    async (key) => {
      const scoped = key !== "shared";
      const before = taskIds(key, "one");
      const one = createOperation("one", key, { requesterAgentId: scoped ? undefined : "one" });
      const two = createOperation("two", key, { requesterAgentId: "two" });
      expect(listOperations(key)).toEqual(scoped ? [one] : []);
      expect(listOperations(key, "one")).toEqual([one]);
      expect(listOperations(key, "two")).toEqual([two]);
      expect(Reflect.apply(listOperations, undefined, [key, null])).toEqual(scoped ? [one] : []);
      expect(taskIds(key, "one")).not.toContain("two");
      expect(hasNewTask(key, before, "one")).toBe(true);
      expect(hasNewTask(key, before)).toBe(scoped);
      const admissions = taskIds(key, "one");
      expect(hasNewTask(key, admissions, "one")).toBe(false);
      expect(hasNewTask(key, admissions, "two")).toBe(true);
      expect(activeCount()).toBe(2);
      expect(await findDuplicate(key, "draw a tree", "same-request", "one")).toBe(one);
      rotateAgentRunRegistryLifecycleGeneration();
      expect(isMediaGenerationOperationCurrent("one")).toBe(false);
      expect(activeCount()).toBe(0);
      expect(listOperations(key)).toEqual([]);
      expect(listOperations(key, "one")).toEqual([]);
      expect(await findDuplicate(key, "draw a tree", "same-request", "one")).toBeUndefined();
    },
  );
  it("blocks duplicate provider work, retains attempt admission after completion, and releases restart custody", async () => {
    const sessionKey = "agent:main:cron:media:run:one";
    const before = taskIds(sessionKey);
    const operation = createOperation("image:1", sessionKey);
    expect(
      await findDuplicateGuardImageGenerationTaskForSession(sessionKey, {
        prompt: "draw a tree",
        agentId: "main",
      }),
    ).toBe(operation);
    expect(activeCount()).toBe(1);
    expect(hasPendingTask(sessionKey)).toBe(true);
    updateMediaGenerationOperation("image:1", { status: "succeeded", endedAt: Date.now() });
    clearGeneratedMediaTaskActivity("image:1");
    expect(activeCount()).toBe(0);
    expect(hasPendingTask(sessionKey)).toBe(false);
    expect(hasNewTask(sessionKey, before)).toBe(true);
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
