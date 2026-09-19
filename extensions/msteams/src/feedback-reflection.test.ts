import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  PluginStateCompareIntent,
  PluginStateCompareResult,
  PluginStateKeyedStore,
  PluginStateObservation,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storeSessionLearning } from "./feedback-reflection-store.js";
import { runFeedbackReflection } from "./feedback-reflection.js";
import type { MSTeamsApp } from "./sdk.js";

type LearningEntry = { sessionKey: string; learnings: string[]; updatedAt: number };
type ComparisonStore = Pick<PluginStateKeyedStore<LearningEntry>, "observe" | "compareAndApply">;

const mocks = vi.hoisted(() => {
  const observe = vi.fn<(key: string) => Promise<PluginStateObservation<LearningEntry>>>();
  const compareAndApply =
    vi.fn<
      (
        key: string,
        comparison: string,
        intent: PluginStateCompareIntent<LearningEntry>,
      ) => Promise<PluginStateCompareResult<LearningEntry>>
    >();
  return {
    observe,
    compareAndApply,
    openKeyedStore: vi.fn<() => ComparisonStore>(),
    reflect: vi.fn(),
    send: vi.fn(),
  };
});

vi.mock("./runtime.js", () => ({
  getMSTeamsRuntime: () => ({ state: { openKeyedStore: mocks.openKeyedStore } }),
}));
vi.mock("openclaw/plugin-sdk/channel-inbound", () => ({
  DEFAULT_CHANNEL_FEEDBACK_REFLECTION_COOLDOWN_MS: 300_000,
  runChannelFeedbackReflection: mocks.reflect,
}));
vi.mock("./sdk-proactive.js", () => ({ sendMSTeamsActivityWithReference: mocks.send }));
vi.mock("./messenger.js", () => ({ buildConversationReference: (value: unknown) => value }));

const params = { storePath: "/synthetic/sessions", sessionKey: "session", learning: "repeat" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.observe.mockResolvedValue({ value: undefined, comparison: "absent" });
  mocks.compareAndApply.mockResolvedValue({ status: "applied" });
  mocks.openKeyedStore.mockReturnValue({
    observe: mocks.observe,
    compareAndApply: mocks.compareAndApply,
  });
});
afterEach(() => vi.restoreAllMocks());

describe("MSTeams feedback learning persistence", () => {
  it("rebases an append after conflict, retaining ten entries and duplicate learnings", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValue(200);
    const current = {
      sessionKey: "session",
      learnings: [...Array.from({ length: 9 }, (_, index) => String(index)), "repeat"],
      updatedAt: 90,
    };
    mocks.compareAndApply.mockResolvedValueOnce({
      status: "conflict",
      current: { value: current, comparison: "current" },
    });

    await storeSessionLearning(params);

    expect(mocks.compareAndApply).toHaveBeenLastCalledWith(expect.any(String), "current", {
      operation: "update",
      action: "set",
      value: {
        sessionKey: "session",
        learnings: [...current.learnings.slice(1), "repeat"],
        updatedAt: 100,
      },
    });
  });

  it("still writes when appending leaves the bounded value unchanged", async () => {
    vi.spyOn(Date, "now").mockReturnValue(100);
    const current = {
      sessionKey: "session",
      learnings: Array<string>(10).fill("repeat"),
      updatedAt: 100,
    };
    mocks.observe.mockResolvedValue({ value: current, comparison: "current" });

    await storeSessionLearning(params);

    expect(mocks.compareAndApply).toHaveBeenCalledWith(expect.any(String), "current", {
      operation: "update",
      action: "set",
      value: current,
    });
  });

  it("propagates an unknown write outcome without repeating the append", async () => {
    const failure = new Error("worker result unavailable");
    mocks.compareAndApply.mockRejectedValue(failure);

    await expect(storeSessionLearning(params)).rejects.toBe(failure);
    expect(mocks.compareAndApply).toHaveBeenCalledOnce();
  });

  it.each(["observe", "compareAndApply"] as const)("requires %s support", async (method) => {
    const store: ComparisonStore = {
      observe: mocks.observe,
      compareAndApply: mocks.compareAndApply,
    };
    store[method] = undefined;
    mocks.openKeyedStore.mockReturnValue(store);

    await expect(storeSessionLearning(params)).rejects.toThrow("atomic comparison is unavailable");
    expect(mocks.observe).not.toHaveBeenCalled();
    expect(mocks.compareAndApply).not.toHaveBeenCalled();
  });
});

describe("MSTeams reflection completion", () => {
  it.each(["applied", "failed"] as const)(
    "waits for the %s storage outcome before its optional follow-up",
    async (outcome) => {
      const admitted = createDeferred<void>();
      const pending = createDeferred<PluginStateCompareResult<LearningEntry>>();
      mocks.compareAndApply
        .mockResolvedValueOnce({
          status: "conflict",
          current: {
            value: { sessionKey: "session", learnings: ["earlier"], updatedAt: 1 },
            comparison: "current",
          },
        })
        .mockImplementation(() => {
          admitted.resolve();
          return pending.promise;
        });
      mocks.reflect.mockResolvedValue({
        status: "complete",
        storePath: params.storePath,
        learning: params.learning,
        responseLength: 6,
        followUp: true,
        userMessage: "Synthetic follow-up",
      });
      const log = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };
      const operation = runFeedbackReflection({
        cfg: {},
        app: {} as MSTeamsApp,
        conversationRef: { conversation: { id: "conversation", conversationType: "personal" } },
        sessionKey: "session",
        agentId: "main",
        conversationId: "conversation",
        conversationKind: "direct",
        log,
      });
      try {
        await admitted.promise;
        expect(mocks.send).not.toHaveBeenCalled();
        if (outcome === "applied") {
          pending.resolve({ status: "applied" });
        } else {
          pending.reject(new Error("state unavailable"));
        }
        await operation;
      } finally {
        pending.resolve({ status: "applied" });
        await operation;
      }

      expect(mocks.reflect).toHaveBeenCalledOnce();
      expect(mocks.compareAndApply).toHaveBeenCalledTimes(2);
      expect(mocks.send).toHaveBeenCalledOnce();
      if (outcome === "failed") {
        expect(log.debug).toHaveBeenCalledWith("failed to store reflection learning", {
          error: "state unavailable",
        });
      }
    },
  );
});
