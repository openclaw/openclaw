import type { AskAnswer, AskGrillState, AskSession } from "./types.js";

const GRILL_STEPS: Array<{ id: string; title: string; question: string; label: string }> = [
  {
    id: "goal",
    title: "Goal",
    question: "この依頼で最終的に何が変われば成功ですか？",
    label: "成功状態・目的",
  },
  {
    id: "context",
    title: "Context",
    question: "前提・背景・対象ユーザー・既存制約で重要なものは何ですか？",
    label: "前提・背景",
  },
  {
    id: "scope",
    title: "Scope",
    question: "今回やること / やらないことの境界はどこですか？",
    label: "スコープ境界",
  },
  {
    id: "risk",
    title: "Risk",
    question: "失敗すると困るリスク、HITLが必要な操作、濫用されると困る点は何ですか？",
    label: "リスク・HITL",
  },
  {
    id: "acceptance",
    title: "Acceptance",
    question: "完了条件とテスト・確認方法は何ですか？",
    label: "完了条件・検証",
  },
  {
    id: "output",
    title: "Output",
    question: "最終アウトプットは SPEC / GOAL / 実装タスク / 提案メモのどれに寄せますか？",
    label: "アウトプット形式",
  },
];

export const ASK_GRILL_STEP_COUNT = GRILL_STEPS.length;

export function createAskGrillState(initialRequest: string): AskGrillState {
  return {
    initialRequest: initialRequest.trim() || "未指定の依頼",
    currentStepIndex: 0,
    answers: [],
  };
}

export function getAskGrillCurrentStep(state: AskGrillState) {
  return GRILL_STEPS[state.currentStepIndex] ?? GRILL_STEPS[GRILL_STEPS.length - 1];
}

export function isAskGrillSession(session: AskSession): boolean {
  return session.mode === "grill" && Boolean(session.grill);
}

export function formatAskGrillQuestion(session: AskSession): string {
  const grill = session.grill;
  if (!grill) {
    return session.questionText;
  }
  const step = getAskGrillCurrentStep(grill);
  return [
    `**/ask grill** ${step.title} (${grill.currentStepIndex + 1}/${ASK_GRILL_STEP_COUNT})`,
    `依頼: ${sanitizeDiscordDisplayText(grill.initialRequest, 300)}`,
    "",
    step.question,
    "-# 1問ずつ仕様を固めます。回答は記録のみで、実装・送信・設定変更には別GOが必要です。",
  ].join("\n");
}

export function advanceAskGrillSession(
  session: AskSession,
  answer: AskAnswer,
  now: number,
): { session: AskSession; completed: boolean } {
  const grill = session.grill;
  if (!grill) {
    return { session: { ...session, status: "answered", result: answer }, completed: true };
  }
  const step = getAskGrillCurrentStep(grill);
  const answerText = summarizeAskAnswerText(answer);
  const answers = [
    ...grill.answers,
    {
      stepId: step.id,
      question: step.question,
      answer: answerText,
      answeredAt: now,
    },
  ];
  const nextStepIndex = grill.currentStepIndex + 1;
  if (nextStepIndex >= ASK_GRILL_STEP_COUNT) {
    return {
      completed: true,
      session: {
        ...session,
        status: "answered",
        result: answer,
        grill: {
          ...grill,
          currentStepIndex: grill.currentStepIndex,
          answers,
        },
      },
    };
  }
  const nextGrill = {
    ...grill,
    currentStepIndex: nextStepIndex,
    answers,
  };
  const nextStep = getAskGrillCurrentStep(nextGrill);
  return {
    completed: false,
    session: {
      ...session,
      status: "open",
      result: undefined,
      questionText: nextStep.question,
      uiType: "modal",
      options: [],
      grill: nextGrill,
    },
  };
}

export function formatAskGrillSummary(session: AskSession): string {
  const grill = session.grill;
  if (!grill) {
    return "✅ /ask grill complete.";
  }
  const answerById = new Map(grill.answers.map((entry) => [entry.stepId, entry.answer]));
  return [
    "✅ /ask grill complete",
    "",
    "**GOAL**",
    safeAnswer(answerById.get("goal")),
    "",
    "**SPEC**",
    `- Initial request: ${sanitizeDiscordDisplayText(grill.initialRequest, 300)}`,
    `- Context: ${safeAnswer(answerById.get("context"))}`,
    `- Scope: ${safeAnswer(answerById.get("scope"))}`,
    "",
    "**RISKS / HITL**",
    safeAnswer(answerById.get("risk")),
    "",
    "**ACCEPTANCE**",
    safeAnswer(answerById.get("acceptance")),
    "",
    "**NEXT TASK / MEMO FORMAT**",
    safeAnswer(answerById.get("output")),
    "",
    "-# 記録のみ完了。実装・外部送信・削除・上書き・課金・本番反映には別GOが必要です。",
  ].join("\n");
}

export function sanitizeDiscordDisplayText(value: string, maxLength = 500): string {
  const sanitized = value
    .replace(/@/gu, "@\u200b")
    .replace(/<@/gu, "<@\u200b")
    .replace(/<#/gu, "<#\u200b")
    .replace(/<@&/gu, "<@&\u200b")
    .trim();
  if (sanitized.length <= maxLength) {
    return sanitized || "未回答";
  }
  return `${sanitized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function safeAnswer(value: string | undefined): string {
  return sanitizeDiscordDisplayText(value ?? "未回答", 700);
}

function summarizeAskAnswerText(answer: AskAnswer): string {
  if (answer.fields?.length) {
    return answer.fields
      .flatMap((field) => field.values)
      .map((value) => value.trim())
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (answer.values?.length) {
    return answer.values.join(", ");
  }
  return answer.kind;
}
