export type AskMode = "single" | "grill";

export type AskUiType = "button" | "select" | "modal";

export type AskOption = {
  label: string;
  value: string;
};

export type AskSessionStatus = "open" | "answered" | "expired" | "rejected";

export type AskAnswer = {
  actorId?: string;
  interactionId?: string;
  interactionMessageId?: string;
  kind: AskUiType;
  values?: string[];
  fields?: Array<{ id: string; name: string; values: string[] }>;
  answeredAt: number;
};

export type AskSession = {
  askId: string;
  mode: AskMode;
  createdAt: number;
  expiresAt: number;
  requesterUserId?: string;
  sourceChannel: string;
  sourceChannelId?: string | number;
  sourceThreadId?: string | number;
  threadParentId?: string;
  accountId?: string;
  sessionKey?: string;
  questionText: string;
  uiType: AskUiType;
  options: AskOption[];
  allowedUsers: string[];
  reusable: false;
  status: AskSessionStatus;
  interactionMessageId?: string;
  result?: AskAnswer;
  nextActionPolicy: "log_only";
  requiresSecondGo: true;
  actionScope: "answer_capture_only";
  grill?: AskGrillState;
};

export type AskGrillAnswer = {
  stepId: string;
  question: string;
  answer: string;
  answeredAt: number;
};

export type AskGrillState = {
  initialRequest: string;
  currentStepIndex: number;
  answers: AskGrillAnswer[];
};

export type AskFeedbackEvent = {
  askId: string;
  eventId: string;
  type:
    | "answered"
    | "unauthorized"
    | "expired"
    | "duplicate"
    | "missing_session"
    | "invalid_payload";
  actorId?: string;
  interactionId?: string;
  interactionMessageId?: string;
  createdAt: number;
  detail?: string;
};
