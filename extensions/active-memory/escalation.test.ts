import { describe, expect, it } from "vitest";
import { hasRecallIntent, resolveRecallEscalationDecision } from "./escalation.js";

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
    "Qual foi a causa raiz do problema que investigamos hoje?",
    "Sem olhar a conversa atual: o que decidimos sobre o upgrade?",
    "O que a gente discutiu ontem sobre memória?",
    "Você lembra o que combinamos na semana passada?",
    "O que decidimos da última vez?",
    "Lembra-se do que conversamos outro dia?",
    "Você lembra o que decidimos para amanhã?",
    "Lembra o que discutimos para a próxima semana?",
    "Voce lembra o que combinamos no mes passado?",
    "O que decidimos da ultima vez?",
    "Você recorda o que combinamos na semana passada?",
    "Lembra o que discutimos para a proxima semana?",
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
    "Lembre de enviar o relatório amanhã",
    "Me lembre amanhã",
    "Lembra de configurar isso",
    "Amanhã vamos decidir o upgrade",
    "Lembra de enviar o relatório amanhã?",
    "Lembra de enviar o relatório hoje à noite",
    "Lembra de configurar isso?",
    "Falamos inglês.",
    "Discutimos o problema.",
    "Você lembra o que fazer semana que vem?",
    "Lembra o que vamos decidir mês que vem?",
    "O relatório contém o que precisamos hoje.",
    "A lembrança de ontem é boa.",
    "Lembra o que fazer hoje a noite?",
    "Lembra o que fazer amanha?",
    "Esse arquivo relembra como configurar o serviço.",
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
});
