import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import type { WorkshopChange } from "openclaw/plugin-sdk/skill-workshop-host-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExperienceReviewCandidate } from "./experience-review-scheduler.js";
import { runSkillExperienceReview } from "./experience-review.js";
import { setWorkshopRuntime } from "./runtime.js";

// The fork mechanics (admission, fencing, drain, source effects) belong to the host's
// runForkedTurn and its own tests; these cover what the plugin does around one fork.
const mocks = vi.hoisted(() => ({
  listWorkshopChanges: vi.fn(),
  postWorkshopChangeNotice: vi.fn(async () => {}),
}));
vi.mock("openclaw/plugin-sdk/skill-workshop-host-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/skill-workshop-host-runtime")>()),
  listWorkshopChanges: mocks.listWorkshopChanges,
}));
vi.mock("./review-outcome.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./review-outcome.js")>()),
  postWorkshopChangeNotice: mocks.postWorkshopChangeNotice,
}));

type ForkParams = Parameters<PluginRuntime["subagent"]["runForkedTurn"]>[0];
type Outcome = Parameters<ForkParams["onSettled"]>[0];

const committed: WorkshopChange = {
  id: "c1",
  agentId: "main",
  skillName: "actual-budget-operations",
  action: "patch",
  actor: "review",
  summary: "tightened reconciliation step",
  createdAtMs: 1,
};
const candidate: ExperienceReviewCandidate = {
  ctx: { runId: "run-1" },
  config: {},
  source: {
    agentId: "main",
    sessionKey: "agent:main:telegram:direct:42",
    sessionId: "session-1",
    entryId: "entry-1",
  },
};
const generation = {
  agentId: "main",
  storePath: "/sessions",
  sessionKey: candidate.source.sessionKey,
  sessionId: "session-1",
  lifecycleRevision: "rev-1",
};
let config: OpenClawConfig;
let forks: ForkParams[];
let outcome: Outcome | "refused";

beforeEach(() => {
  config = {};
  forks = [];
  outcome = { runId: "", ok: true, source: { sessionId: "session-1", lifecycleRevision: "rev-2" } };
  mocks.listWorkshopChanges.mockReset().mockResolvedValue([]);
  mocks.postWorkshopChangeNotice.mockReset().mockResolvedValue(undefined);
  setWorkshopRuntime({
    config: { current: () => config },
    agent: { resolveAgentTimeoutMs: () => 600_000 },
    system: { captureSessionGeneration: vi.fn(async () => generation) },
    subagent: {
      runForkedTurn: async (params: ForkParams) => {
        forks.push(params);
        if (outcome === "refused") {
          return { status: "refused", reason: "tool_policy" };
        }
        const runId = params.runId ?? "";
        return { status: "settled", runId, value: await params.onSettled({ ...outcome, runId }) };
      },
    },
  } as unknown as PluginRuntime); // SAFETY: the review reads only these runtime members.
});
afterEach(() => {
  vi.restoreAllMocks();
});

it("forks the finished turn with only skill_workshop and the agent's run timeout", async () => {
  await runSkillExperienceReview(candidate);
  expect(forks).toHaveLength(1);
  expect(forks[0]).toMatchObject({
    sessionKey: candidate.source.sessionKey,
    through: { sessionId: "session-1", entryId: "entry-1" },
    tools: ["skill_workshop"],
    timeoutMs: 600_000,
  });
  expect(forks[0]?.runId).toMatch(/^skill-workshop-review:/);
});

it("announces changes committed before the review run failed, to the admitted generation", async () => {
  mocks.listWorkshopChanges.mockResolvedValue([committed]);
  outcome = {
    runId: "",
    ok: false,
    cancelled: false,
    error: new Error("model request timed out"),
    source: { sessionId: "session-1", lifecycleRevision: "rev-2" },
  };
  await expect(runSkillExperienceReview(candidate)).rejects.toThrow("model request timed out");
  expect(mocks.listWorkshopChanges).toHaveBeenCalledWith("main", { runId: forks[0]?.runId });
  expect(mocks.postWorkshopChangeNotice).toHaveBeenCalledWith(
    expect.objectContaining({
      generation: { ...generation, lifecycleRevision: "rev-2" },
      runId: forks[0]?.runId,
      changes: [committed],
    }),
  );
});

it("keeps a cleanup failure visible, apart from an expected cancellation", async () => {
  mocks.postWorkshopChangeNotice.mockRejectedValue(new Error("notice failed"));
  outcome = {
    runId: "",
    ok: false,
    cancelled: true,
    error: new Error("aborted"),
    source: { sessionId: "session-1", lifecycleRevision: null },
  };
  await expect(runSkillExperienceReview(candidate)).rejects.toBeInstanceOf(AggregateError);
  mocks.postWorkshopChangeNotice.mockResolvedValue(undefined);
  await expect(runSkillExperienceReview(candidate)).rejects.toMatchObject({ name: "AbortError" });
});

it.each(["off", "replaced", "refused"] as const)("runs nothing visible when %s", async (cause) => {
  if (cause === "off") {
    config = {
      plugins: { entries: { "skill-workshop": { config: { autonomous: { mode: "off" } } } } },
    };
  } else if (cause === "replaced") {
    generation.sessionId = "session-2";
  } else {
    outcome = "refused";
  }
  try {
    await runSkillExperienceReview(candidate);
  } finally {
    generation.sessionId = "session-1";
  }
  expect(forks).toHaveLength(cause === "refused" ? 1 : 0);
  expect(mocks.postWorkshopChangeNotice).not.toHaveBeenCalled();
});

it("stops the running review model when learning is turned off", async () => {
  vi.useFakeTimers();
  try {
    const started = Promise.withResolvers<void>();
    let stopped: unknown;
    setWorkshopRuntime({
      config: { current: () => config },
      agent: { resolveAgentTimeoutMs: () => 600_000 },
      system: { captureSessionGeneration: vi.fn(async () => generation) },
      subagent: {
        runForkedTurn: async (params: ForkParams) => {
          forks.push(params);
          started.resolve();
          // The model run ends only when its signal aborts.
          const error = await new Promise<unknown>((resolve) => {
            params.signal?.addEventListener("abort", () => resolve(params.signal?.reason), {
              once: true,
            });
          });
          stopped = error;
          const runId = params.runId ?? "";
          return {
            status: "settled",
            runId,
            value: await params.onSettled({ runId, ok: false, cancelled: true, error }),
          };
        },
      },
    } as unknown as PluginRuntime); // SAFETY: the review reads only these runtime members.
    const review = runSkillExperienceReview(candidate);
    const settled = expect(review).rejects.toMatchObject({
      name: "AbortError",
      message: "Skill Workshop was turned off during review.",
    });
    await started.promise;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stopped).toBeUndefined();
    config = {
      plugins: { entries: { "skill-workshop": { config: { autonomous: { mode: "off" } } } } },
    };
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
    expect(stopped).toMatchObject({ name: "AbortError" });
  } finally {
    vi.useRealTimers();
  }
});
