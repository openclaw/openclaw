import { describe, expect, it } from "vitest";
import { hasRecallIntent, resolveRecallEscalationDecision } from "./escalation.js";

describe("active-memory escalation", () => {
  const decide = (
    mode: Parameters<typeof resolveRecallEscalationDecision>[0]["mode"],
    message: string,
    hasStrongLaneOneHit = false,
  ) => resolveRecallEscalationDecision({ mode, message, hasStrongLaneOneHit });

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
    "你還記得我們上週決定明天部署的方案嗎？",
    "幫我找一下之前的聊天記錄",
    "之前  讨论过的那个方案",
    "我们之前决定过的部署方案是什么？",
    "この設定を覚えてますか？",
    "以前話していた設定は何ですか？",
    "先週相談した明日の予定を覚えてる？",
    "지난 번에 우리가 이야기했던 설정은 뭐였어?",
    "그 설정 기억나ㅋㅋ",
    "지난 주에 논의했던 다음 배포 일정 기억나죠?",
    "Что мы обсуждали на прошлой неделе?",
    "Напомни, о чём мы договорились в прошлый раз",
    "Помнишь, что мы решили развернуть завтра?",
    "Вспомни, что мы решили вчера",
    "Помнишь, что мы решили вчера? Напомни мне завтра, что нужно отправить отчёт",
    "Помнишь, как отправить отчёт?",
    "Qual foi a causa raiz do problema que investigamos hoje?",
    "Sem olhar a conversa atual: o que decidimos sobre o upgrade?",
    "O que a gente discutiu ontem sobre memória?",
    "Você lembra o que combinamos na semana passada?",
    "Lembra-se do que conversamos outro dia?",
    "Você lembra o que decidimos para amanhã?",
    "Voce lembra o que combinamos no mes passado?",
    "Você recorda o que combinamos na semana passada?",
    "Tu te rappelles ce que je t'ai dit sur mon genou ?",
    "Te souviens-tu du restaurant dont on a parlé ?",
    "Tu t’en souviens ?",
    "Rappelle-moi ce qu'on avait décidé pour le PC",
    "Qu'est-ce qu'on a décidé pour le budget ?",
    "On a décidé quoi pour le modèle ?",
    "De quoi avons-nous parlé la semaine dernière ?",
    "Qu'avons-nous décidé ?",
    "On en a déjà parlé, non ?",
    "Je t'ai déjà dit que je préfère les chats",
    "Comme je te l'avais dit, le budget est serré",
    "Tu m'as conseillé un livre, c'était lequel ?",
    "La dernière fois qu'on a parlé de Kyoto, tu m'as suggéré un parc",
    "L'autre jour on a discuté du serveur",
    "Il y a deux semaines on a choisi un hébergeur",
    "Tu te souviens de ce qu'on a décidé pour demain ?",
    "Hier je t'ai dit que je partais demain",
    "tu te souviens de ce quon a decide la semaine derniere ?",
    "Qu’est-ce qu’on a dit pour Kyoto ?",
    "Tu te souviens de Roger ?",
    "Vous vous rappelez de Gauthier ?",
    "Tu te souviens d'envoyer le rapport ?",
  ])("recognizes recall intent in %j", (message) => {
    expect(hasRecallIntent(message)).toBe(true);
  });

  it.each([
    "Remember to send the report",
    "How does prior authorization work?",
    "部署之前先整理聊天记录",
    "你還記得明天發送報告嗎？",
    "你记得上周的报告明天发送吗？",
    "医生说过敏反应很严重",
    "讨论过期证书怎么更新",
    "上次天气不错",
    "この設定を覚えておいて",
    "以前より話しやすくなった",
    "以前のように話したくない",
    "以前会話したい",
    "以前話していただけますか",
    "この設定を覚えているように設定して",
    "この設定を覚えている状態にして",
    "覚えていることにして",
    "覚えてるままにして",
    "今晩覚えてますか？",
    "지난번 설정을 내일 기억나요?",
    "지난번 날씨가 좋았어",
    "Напомни мне завтра о вчерашней встрече",
    "Ты помнишь, что нужно сегодня отправить отчёт?",
    "Ты помнишь через неделю отправить отчёт?",
    "Ты помнишь, что нужно будет отправить отчёт?",
    "Amanhã vamos decidir o upgrade",
    "Lembra de enviar o relatório amanhã?",
    "Lembra de configurar isso?",
    "Falamos inglês.",
    "Você lembra o que fazer semana que vem?",
    "A lembrança de ontem é boa.",
    "Lembra o que fazer amanha?",
    "Esse arquivo relembra como configurar o serviço.",
    "Rappelle-moi de sortir les poubelles demain",
    "Tu te souviens d'envoyer le rapport demain ?",
    "On a décidé d'aller au cinéma ce soir.",
    "J'ai parlé à mon patron aujourd'hui.",
    "Rappelle-moi dans une heure de rappeler Ting",
    "Hier on a fait un audit.",
    "J'ai dit que mon cahier était plein.",
  ])("does not mistake ordinary or future-facing %j for recall intent", (message) => {
    expect(hasRecallIntent(message)).toBe(false);
  });

  it("requires recall intent and a weak deterministic lane in escalate mode", () => {
    const message = "What did we decide last time?";
    expect(decide("escalate", message)).toBe("recall");
    expect(decide("escalate", message, true)).toBe("strong-lane-one-hit");
    expect(decide("escalate", "Explain the current configuration")).toBe("no-recall-intent");
  });

  it("preserves always mode and disables escalation in off mode", () => {
    expect(decide("always", "No recall phrasing here", true)).toBe("recall");
    expect(decide("off", "Do you remember this?")).toBe("mode-off");
  });
});
