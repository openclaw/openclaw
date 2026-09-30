import { describe, expect, it, vi } from "vitest";
import {
  hasRecallIntent,
  resolveRecallEscalationDecision,
  resolveRecallEscalationDecisionWithDecider,
} from "./escalation.js";

describe("active-memory escalation", () => {
  it.each([
    "Do you remember what we decided to deploy tomorrow?",
    "What did we discuss last time?",
    "Which database did we choose?",
    "Summarize the conversations from January",
    "¿Qué decidimos para mañana?",
    "¿Cuál fue la última vez que hablamos?",
    "Can you remind me what seat I prefer?",
    "What happened two weeks ago?",
    "你记得数据库配置吗？",
    "你还记得我们上周决定明天部署的方案吗？",
    "你還記得我們上週決定明天部署的方案嗎？",
    "幫我找一下之前的聊天記錄",
    "上次，讨论的那个方案",
    "之前  讨论过的那个方案",
    "我们之前决定过的部署方案是什么？",
    "この設定を覚えてますか？",
    "以前話していた設定は何ですか？",
    "先週相談した明日の予定を覚えてる？",
    "지난 번에 우리가 이야기했던 설정은 뭐였어?",
    "그 설정 기억나지요?",
    "그 설정 기억나ㅋㅋ",
    "지난 주에 논의했던 다음 배포 일정 기억나죠?",
    "Помнишь, что мы решили вчера?",
    "Что мы обсуждали на прошлой неделе?",
    "Напомни, о чём мы договорились в прошлый раз",
    "Ты помнишь, о чём мы говорили раньше?",
    "Помнишь, что мы решили развернуть завтра?",
    "Что я говорил вчера?",
    "Что ты решил в прошлый раз?",
    "Напомни, что мы решили развернуть завтра?",
    "Напомни, что было вчера",
    "Вспомни, что мы решили вчера",
    "Напомни, что мы сегодня решили",
    "Напомни, что мы решили на завтра",
    "Напомни, о чём мы договорились вчера вечером",
    "Напомни, что мы решили развернуть в пятницу",
    "Помнишь, что мы решили вчера? Напомни мне завтра, что нужно отправить отчёт",
    "Пожалуйста, напомни, о чём мы договорились в прошлый раз",
    "Помнишь, как отправить отчёт?",
  ])("recognizes recall intent in %j", (message) => {
    expect(hasRecallIntent(message)).toBe(true);
  });

  it.each([
    "How do I configure SQLite?",
    "Before we deploy, run the tests",
    "Remember to send the report",
    "Remind me tomorrow",
    "How does prior authorization work?",
    "部署之前先讨论方案",
    "部署之前先整理聊天记录",
    "部署之前整理的资料",
    "你记得明天发送报告吗？",
    "你還記得明天發送報告嗎？",
    "你记得上周的报告明天发送吗？",
    "记住这个配置",
    "医生说过敏反应很严重",
    "讨论过期证书怎么更新",
    "上次天气不错",
    "この設定を覚えておいて",
    "前回は晴れだった",
    "以前より話しやすくなった",
    "以前より話したい",
    "以前のように話したくない",
    "以前のように話したがる",
    "以前会話したい",
    "以前話していただけますか",
    "この設定を覚えているように設定して",
    "この設定を覚えている状態にして",
    "覚えていることにして",
    "覚えてるままにして",
    "今晩覚えてますか？",
    "前回の設定を明日覚えてますか？",
    "明日その予定を思い出させて",
    "이 설정을 기억해줘",
    "내일 기억나요?",
    "지난번 설정을 내일 기억나요?",
    "지난번 날씨가 좋았어",
    "내일 기억나게 알려줘",
    "Напомни мне завтра отправить отчёт",
    "Давай обсудим это на следующей неделе",
    "Запомни эту настройку",
    "Запомните эту настройку",
    "Привет, как дела?",
    "Напомни мне завтра о вчерашней встрече",
    "Ты помнишь завтра отправить отчёт?",
    "Ты помнишь, что нужно сегодня отправить отчёт?",
    "Ты помнишь через два часа отправить отчёт?",
    "Ты помнишь через неделю отправить отчёт?",
    "Ты помнишь, что нужно будет отправить отчёт?",
  ])("does not mistake ordinary or future-facing %j for recall intent", (message) => {
    expect(hasRecallIntent(message)).toBe(false);
  });

  it("requires recall intent and a weak deterministic lane in escalate mode", () => {
    expect(
      resolveRecallEscalationDecision({
        mode: "escalate",
        message: "What did we decide last time?",
        hasStrongLaneOneHit: false,
      }),
    ).toBe("recall");
    expect(
      resolveRecallEscalationDecision({
        mode: "escalate",
        message: "What did we decide last time?",
        hasStrongLaneOneHit: true,
      }),
    ).toBe("strong-lane-one-hit");
    expect(
      resolveRecallEscalationDecision({
        mode: "escalate",
        message: "Explain the current configuration",
        hasStrongLaneOneHit: false,
      }),
    ).toBe("no-recall-intent");
  });

  it("preserves always mode and disables escalation in off mode", () => {
    expect(
      resolveRecallEscalationDecision({
        mode: "always",
        message: "No recall phrasing here",
        hasStrongLaneOneHit: true,
      }),
    ).toBe("recall");
    expect(
      resolveRecallEscalationDecision({
        mode: "off",
        message: "Do you remember this?",
        hasStrongLaneOneHit: false,
      }),
    ).toBe("mode-off");
  });

  it.each([
    ["recall", "Explain the current configuration", "recall"],
    ["skip", "What did we decide last time?", "decision-skip"],
    ["abstain", "What did we decide last time?", "recall"],
    ["abstain", "Explain the current configuration", "no-recall-intent"],
  ] as const)(
    "lets a decider result of %s resolve %j as %s",
    async (deciderResult, message, expected) => {
      const signal = new AbortController().signal;
      await expect(
        resolveRecallEscalationDecisionWithDecider({
          mode: "escalate",
          message,
          searchQuery: `recent context\n${message}`,
          hasStrongLaneOneHit: false,
          decider: {
            decide: async (params) => {
              expect(params).toEqual({
                message,
                searchQuery: `recent context\n${message}`,
                signal: expect.any(AbortSignal),
                timeoutMs: 1_000,
              });
              expect(params.signal.aborted).toBe(false);
              return deciderResult;
            },
          },
          signal,
        }),
      ).resolves.toBe(expected);
    },
  );

  it("accepts a synchronous decider result", async () => {
    await expect(
      resolveRecallEscalationDecisionWithDecider({
        mode: "escalate",
        message: "Explain the current configuration",
        searchQuery: "Explain the current configuration",
        hasStrongLaneOneHit: false,
        decider: { decide: () => "recall" },
        signal: new AbortController().signal,
      }),
    ).resolves.toBe("recall");
  });

  it.each(["synchronous", "asynchronous"] as const)(
    "rejects an overdue %s decision before the timeout callback runs",
    async (kind) => {
      const now = vi.spyOn(performance, "now").mockReturnValue(0);
      const fallbacks: string[] = [];
      let deciderSignal: AbortSignal | undefined;
      try {
        await expect(
          resolveRecallEscalationDecisionWithDecider({
            mode: "escalate",
            message: "What did we decide last time?",
            searchQuery: "What did we decide last time?",
            hasStrongLaneOneHit: false,
            decider: {
              decide: ({ signal }) => {
                deciderSignal = signal;
                // Computation advances the clock without yielding to timers.
                now.mockReturnValue(1_001);
                return kind === "asynchronous" ? Promise.resolve("skip" as const) : "skip";
              },
            },
            signal: new AbortController().signal,
            onDeciderFallback: (reason) => fallbacks.push(reason),
          }),
        ).resolves.toBe("recall");
        expect(fallbacks).toEqual(["timeout"]);
        expect(deciderSignal?.aborted).toBe(true);
      } finally {
        now.mockRestore();
      }
    },
  );

  it.each([
    ["off", false, "mode-off"],
    ["always", false, "recall"],
    ["escalate", true, "strong-lane-one-hit"],
  ] as const)(
    "does not call the decider in mode=%s with strongLaneOne=%s",
    async (mode, hasStrongLaneOneHit, expected) => {
      let calls = 0;
      await expect(
        resolveRecallEscalationDecisionWithDecider({
          mode,
          message: "What did we decide last time?",
          searchQuery: "What did we decide last time?",
          hasStrongLaneOneHit,
          decider: {
            decide: async () => {
              calls += 1;
              return "skip" as const;
            },
          },
          signal: new AbortController().signal,
        }),
      ).resolves.toBe(expected);
      expect(calls).toBe(0);
    },
  );

  it.each([
    ["invalid", async () => "invalid" as never, "invalid-result"],
    [
      "times out",
      async ({ signal }: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return "skip" as const;
      },
      "timeout",
    ],
    ["ignores abort", async () => await new Promise<"skip">(() => {}), "timeout"],
  ] as const)(
    "falls back to the built-in matcher when the decider %s",
    async (_label, decide, expectedReason) => {
      const fallbacks: string[] = [];
      await expect(
        resolveRecallEscalationDecisionWithDecider({
          mode: "escalate",
          message: "What did we decide last time?",
          searchQuery: "What did we decide last time?",
          hasStrongLaneOneHit: false,
          decider: { decide },
          signal: new AbortController().signal,
          timeoutMs: 5,
          onDeciderFallback: (reason) => fallbacks.push(reason),
        }),
      ).resolves.toBe("recall");
      expect(fallbacks).toEqual([expectedReason]);
    },
  );

  it.each(["synchronous", "asynchronous", "caller-abort"] as const)(
    "does not start fallback after %s rejection",
    async (kind) => {
      const controller = new AbortController();
      const error = new Error("Decision consumer authority closed.");
      const onFallback = vi.fn();
      await expect(
        resolveRecallEscalationDecisionWithDecider({
          mode: "escalate",
          message: "What did we decide last time?",
          searchQuery: "earlier decision",
          hasStrongLaneOneHit: false,
          signal: controller.signal,
          onDeciderFallback: onFallback,
          decider: {
            decide: () => {
              if (kind === "caller-abort") {
                controller.abort(error);
                return "abstain";
              }
              if (kind === "asynchronous") {
                return Promise.reject(error);
              }
              throw error;
            },
          },
        }),
      ).rejects.toBe(error);
      expect(onFallback).not.toHaveBeenCalled();
    },
  );

  it("keeps the full message for built-in fallback while bounding decider input", async () => {
    const fullMessage = `${"context ".repeat(70)} What did we decide last time?`;
    const deciderMessage = fullMessage.slice(0, 480);
    let observedMessage: string | undefined;

    await expect(
      resolveRecallEscalationDecisionWithDecider({
        mode: "escalate",
        message: fullMessage,
        deciderMessage,
        searchQuery: deciderMessage,
        hasStrongLaneOneHit: false,
        decider: {
          decide: async ({ message }) => {
            observedMessage = message;
            return "abstain" as const;
          },
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toBe("recall");
    expect(observedMessage).toBe(deciderMessage);

    await expect(
      resolveRecallEscalationDecisionWithDecider({
        mode: "escalate",
        message: fullMessage,
        deciderMessage,
        searchQuery: deciderMessage,
        hasStrongLaneOneHit: false,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe("recall");
  });
});
