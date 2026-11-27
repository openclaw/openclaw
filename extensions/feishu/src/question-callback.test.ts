import { describe, expect, it } from "vitest";
import {
  buildFeishuQuestionButtonEnvelope,
  FEISHU_QUESTION_ACTION,
  parseFeishuQuestionEnvelope,
  resolveFeishuQuestionCardBinding,
} from "./question-callback.js";

const QUESTION_ID = "ask_0123456789abcdef0123456789abcdef";
const optionIndices = new Map([
  [
    QUESTION_ID,
    new Map([
      ["yes", 0],
      ["no", 1],
    ]),
  ],
]);

describe("buildFeishuQuestionButtonEnvelope", () => {
  it("encodes the Gateway-owned option index for a choice button", () => {
    const envelope = buildFeishuQuestionButtonEnvelope({
      button: {
        label: "No",
        action: { type: "question", questionId: QUESTION_ID, optionValue: "No" },
      },
      questionOptionIndices: optionIndices,
    });
    expect(envelope).toEqual({
      oc: "ocf1",
      k: "button",
      a: FEISHU_QUESTION_ACTION,
      m: { questionId: QUESTION_ID, optionIndex: 1 },
    });
    expect(parseFeishuQuestionEnvelope(envelope!)).toEqual({
      questionId: QUESTION_ID,
      optionIndex: 1,
    });
  });

  it("encodes the custom-input intent", () => {
    const envelope = buildFeishuQuestionButtonEnvelope({
      button: {
        label: "Other",
        action: { type: "question", questionId: QUESTION_ID, intent: "custom-input" },
      },
      questionOptionIndices: optionIndices,
    });
    expect(parseFeishuQuestionEnvelope(envelope!)).toEqual({
      questionId: QUESTION_ID,
      customInput: true,
    });
  });

  it("refuses unknown option values so no misleading button is rendered", () => {
    expect(
      buildFeishuQuestionButtonEnvelope({
        button: {
          label: "Maybe",
          action: { type: "question", questionId: QUESTION_ID, optionValue: "Maybe" },
        },
        questionOptionIndices: optionIndices,
      }),
    ).toBeUndefined();
  });

  it("refuses ids outside the Gateway question record format", () => {
    expect(
      buildFeishuQuestionButtonEnvelope({
        button: {
          label: "Yes",
          action: { type: "question", questionId: "ask_short", optionValue: "Yes" },
        },
        questionOptionIndices: optionIndices,
      }),
    ).toBeUndefined();
  });
});

describe("parseFeishuQuestionEnvelope", () => {
  it("ignores envelopes from other interactions", () => {
    expect(
      parseFeishuQuestionEnvelope({ oc: "ocf1", k: "quick", a: "feishu.payload.button" }),
    ).toBeUndefined();
  });

  it("rejects malformed option indexes", () => {
    expect(
      parseFeishuQuestionEnvelope({
        oc: "ocf1",
        k: "button",
        a: FEISHU_QUESTION_ACTION,
        m: { questionId: QUESTION_ID, optionIndex: -1 },
      }),
    ).toBeUndefined();
    expect(
      parseFeishuQuestionEnvelope({
        oc: "ocf1",
        k: "button",
        a: FEISHU_QUESTION_ACTION,
        m: { questionId: QUESTION_ID, optionIndex: 1.5 },
      }),
    ).toBeUndefined();
  });
});

describe("resolveFeishuQuestionCardBinding", () => {
  it("binds DM questions to the user and group questions to the chat", () => {
    expect(resolveFeishuQuestionCardBinding("user:ou_abc")).toEqual({
      userId: "ou_abc",
      chatType: "p2p",
    });
    expect(resolveFeishuQuestionCardBinding("chat:oc_abc")).toEqual({
      chatId: "oc_abc",
      chatType: "group",
    });
    expect(resolveFeishuQuestionCardBinding("")).toBeUndefined();
  });
});

describe("question card binding", () => {
  it("carries the conversation binding into the envelope", () => {
    const envelope = buildFeishuQuestionButtonEnvelope({
      button: {
        label: "Yes",
        action: { type: "question", questionId: QUESTION_ID, optionValue: "Yes" },
      },
      questionOptionIndices: optionIndices,
      binding: { chatId: "oc_chat", chatType: "group" },
    });
    expect(envelope?.c).toEqual({ h: "oc_chat", t: "group" });
  });
});
