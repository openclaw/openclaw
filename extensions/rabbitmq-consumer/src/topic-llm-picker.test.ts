import { describe, expect, it, vi } from "vitest";
import type { PluginLogger } from "../api.js";
import { pickTopicByLlm } from "./topic-llm-picker.js";
import type { TopicInfo } from "./topic-resolver.js";

const t = (topicId: number, topicName: string | null): TopicInfo => ({
  topicId,
  useSlaveTopic: false,
  masterId: topicId,
  topicName,
});

const TOPICS: TopicInfo[] = [
  t(89, "广汽本田"),
  t(204, "南方基金"),
  t(358, "涉深舆情-网络动态参阅"),
  t(411, "农业银行深圳市分行"),
];

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as PluginLogger;

/** Build a subagent mock whose run resolves to the given assistant text. */
function subagentReturning(
  assistantText: string | null,
  overrides: Partial<{
    waitStatus: "ok" | "error" | "timeout";
    runThrows: boolean;
    captureRun: (args: Record<string, unknown>) => void;
    deleteSession: ReturnType<typeof vi.fn>;
  }> = {},
) {
  const messages =
    assistantText === null
      ? [{ role: "user", content: "x" }]
      : [
          { role: "user", content: "x" },
          { role: "assistant", content: assistantText },
        ];
  return {
    run: vi.fn(async (args: Record<string, unknown>) => {
      overrides.captureRun?.(args);
      if (overrides.runThrows) {
        throw new Error("run boom");
      }
      return { runId: "run-1" };
    }),
    waitForRun: vi.fn(async () => ({ status: overrides.waitStatus ?? ("ok" as const) })),
    getSessionMessages: vi.fn(async () => ({ messages })),
    deleteSession: overrides.deleteSession ?? vi.fn(async () => {}),
  };
}

describe("pickTopicByLlm", () => {
  it("returns the topic whose id the model selected", async () => {
    const subagent = subagentReturning('{"topicId": 204}');
    const match = await pickTopicByLlm({
      requirement: "做一个南方基金6月的报告",
      topics: TOPICS,
      subagent: subagent as never,
      userId: "126",
      token: 7,
      logger,
    });
    expect(match?.topicId).toBe(204);
  });

  it("understands an abbreviation the substring matcher would miss (农行→农业银行)", async () => {
    // The model is mocked, but this pins the contract: when the LLM resolves
    // "深圳农行" to the full-name project, pickTopicByLlm returns it — the exact
    // case the substring matcher mis-routed to "涉深舆情-网络动态参阅".
    const subagent = subagentReturning('好的，应该是 {"topicId": 411}');
    const match = await pickTopicByLlm({
      requirement: "请你给我出一份6月8日的深圳农行的舆情日报",
      topics: TOPICS,
      subagent: subagent as never,
      userId: "126",
      token: 8,
      logger,
    });
    expect(match?.topicId).toBe(411);
  });

  it("parses the JSON even when wrapped in prose and a code fence", async () => {
    const subagent = subagentReturning('分析如下：\n```json\n{"topicId": 89}\n```\n仅供参考');
    const match = await pickTopicByLlm({
      requirement: "广汽本田的报告",
      topics: TOPICS,
      subagent: subagent as never,
      userId: "1",
      token: 1,
      logger,
    });
    expect(match?.topicId).toBe(89);
  });

  it("returns null when the model is unsure (topicId: null) so the caller can fall back", async () => {
    const subagent = subagentReturning('{"topicId": null}');
    const match = await pickTopicByLlm({
      requirement: "随便来一份报告",
      topics: TOPICS,
      subagent: subagent as never,
      userId: "1",
      token: 1,
      logger,
    });
    expect(match).toBeNull();
  });

  it("rejects a topicId outside the authorized set (never reaches an unowned project)", async () => {
    const subagent = subagentReturning('{"topicId": 99999}');
    const match = await pickTopicByLlm({
      requirement: "做个报告",
      topics: TOPICS,
      subagent: subagent as never,
      userId: "1",
      token: 1,
      logger,
    });
    expect(match).toBeNull();
  });

  it("returns null on a non-ok run (timeout/error) so the caller falls back", async () => {
    const subagent = subagentReturning('{"topicId": 204}', { waitStatus: "timeout" });
    const match = await pickTopicByLlm({
      requirement: "南方基金报告",
      topics: TOPICS,
      subagent: subagent as never,
      userId: "1",
      token: 1,
      logger,
    });
    expect(match).toBeNull();
  });

  it("returns null when the run throws", async () => {
    const subagent = subagentReturning(null, { runThrows: true });
    const match = await pickTopicByLlm({
      requirement: "南方基金报告",
      topics: TOPICS,
      subagent: subagent as never,
      userId: "1",
      token: 1,
      logger,
    });
    expect(match).toBeNull();
  });

  it("does not call the model when fewer than two named candidates exist", async () => {
    const subagent = subagentReturning('{"topicId": 204}');
    const match = await pickTopicByLlm({
      requirement: "南方基金报告",
      topics: [t(204, "南方基金"), t(357, null)],
      subagent: subagent as never,
      userId: "1",
      token: 1,
      logger,
    });
    expect(match).toBeNull();
    expect(subagent.run).not.toHaveBeenCalled();
  });

  it("runs an isolated, non-delivered session and cleans it up afterwards", async () => {
    const captured: Record<string, unknown>[] = [];
    const deleteSession = vi.fn(async () => {});
    const subagent = subagentReturning('{"topicId": 204}', {
      captureRun: (args) => captured.push(args),
      deleteSession,
    });
    await pickTopicByLlm({
      requirement: "南方基金报告",
      topics: TOPICS,
      subagent: subagent as never,
      userId: "126",
      token: 42,
      logger,
    });

    const runArgs = captured[0];
    expect(runArgs.deliver).toBe(false);
    // Isolated session key, distinct from the user's chat session.
    expect(String(runArgs.sessionKey)).toContain("topic-pick");
    expect(String(runArgs.sessionKey)).toContain("126");
    expect(String(runArgs.sessionKey)).toContain("42");
    // Cleaned up so a throwaway classification session never lingers.
    expect(deleteSession).toHaveBeenCalledTimes(1);
  });

  it("tolerates a runtime without deleteSession", async () => {
    const subagent = subagentReturning('{"topicId": 204}');
    // Simulate an older runtime surface lacking deleteSession.
    const { deleteSession: _omit, ...withoutDelete } = subagent;
    const match = await pickTopicByLlm({
      requirement: "南方基金报告",
      topics: TOPICS,
      subagent: withoutDelete as never,
      userId: "1",
      token: 1,
      logger,
    });
    expect(match?.topicId).toBe(204);
  });
});
