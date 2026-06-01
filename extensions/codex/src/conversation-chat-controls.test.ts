import { normalizeMessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  answerCodexUserInputCallback,
  buildCodexPlanDecisionReply,
  consumeCodexPlanDecision,
  createCodexUserInputPrompt,
  hasCodexProposedPlan,
  parseCodexPlanDecisionCallback,
  resolveCodexUserInputCallback,
  resetCodexConversationChatControlsForTests,
} from "./conversation-chat-controls.js";

type TestButton = {
  label: string;
  value?: string;
  action?: { type?: string; value?: string };
};

const scope = {
  sessionFile: "/tmp/session.jsonl",
  threadId: "thread-1",
  channel: "telegram",
  senderId: "user-1",
  accountId: "default",
  sessionKey: "session-key",
  messageThreadId: "chat-1",
};

const ctx = {
  channel: "telegram",
  senderId: "user-1",
  accountId: "default",
  sessionKey: "session-key",
  messageThreadId: "chat-1",
};

describe("codex conversation chat controls", () => {
  afterEach(() => {
    resetCodexConversationChatControlsForTests();
  });

  it("detects proposed plan markup and creates scoped approve/stay buttons", () => {
    expect(hasCodexProposedPlan("before <proposed_plan>do this</proposed_plan> after")).toBe(true);
    expect(hasCodexProposedPlan("do this")).toBe(false);

    const reply = buildCodexPlanDecisionReply({
      text: "<proposed_plan>do this</proposed_plan>",
      scope,
    });
    const buttons = readButtons(reply);
    expect(reply.text).toBe("<proposed_plan>do this</proposed_plan>");
    expect(buttons.map((button) => button.label)).toEqual([
      "Approve and execute",
      "Approve and execute with clean context",
      "Stay in plan mode",
    ]);
    expect(normalizeMessagePresentation(reply.presentation)).toBeDefined();
    expect(buttons.map((button) => button.action?.type)).toEqual([
      "callback",
      "callback",
      "callback",
    ]);
    expect(
      buttons.map((button) => parseCodexPlanDecisionCallback(button.action?.value ?? "")?.action),
    ).toEqual(["approve", "approve-clean", "stay"]);

    const token = parseCodexPlanDecisionCallback(buttons[0]?.action?.value ?? "")?.token ?? "";
    expect(consumeCodexPlanDecision({ token, ctx, sessionFile: scope.sessionFile })).toEqual({
      ok: true,
      sessionFile: scope.sessionFile,
      threadId: scope.threadId,
      planText: "do this",
    });
    expect(consumeCodexPlanDecision({ token, ctx, sessionFile: scope.sessionFile })).toEqual({
      ok: false,
      message: "No pending Codex plan decision was found. The request may have expired.",
    });
  });

  it("rejects plan controls from a different sender scope", () => {
    const reply = buildCodexPlanDecisionReply({
      text: "<proposed_plan>do this</proposed_plan>",
      scope,
    });
    const token =
      parseCodexPlanDecisionCallback(readButtons(reply)[0]?.action?.value ?? "")?.token ?? "";

    expect(
      consumeCodexPlanDecision({
        token,
        ctx: { ...ctx, senderId: "user-2" },
        sessionFile: scope.sessionFile,
      }),
    ).toEqual({
      ok: false,
      message: "Only the user who received this Codex control can use it.",
    });
  });

  it("creates option buttons for a single visible question and resolves selected answers", async () => {
    let resolveText: (text: string) => void = () => undefined;
    const answered = new Promise<string>((resolve) => {
      resolveText = resolve;
    });
    const reply = createCodexUserInputPrompt({
      scope,
      resolveText,
      questions: [
        {
          id: "q1",
          header: "Mode",
          question: "Pick a mode",
          isOther: false,
          isSecret: false,
          options: [
            { label: "Execute", description: "Run now" },
            { label: "Plan", description: "Stay in planning" },
          ],
        },
      ],
    });
    const buttons = readButtons(reply);
    expect(buttons.map((button) => button.label)).toEqual(["Execute", "Plan"]);
    expect(normalizeMessagePresentation(reply.presentation)).toBeDefined();
    expect(buttons.map((button) => button.value?.split(":").at(-1))).toEqual(["1", "2"]);

    expect(answerCodexUserInputCallback({ payload: buttons[1]?.value?.slice(6) ?? "", ctx })).toBe(
      "Sent answer to Codex.",
    );
    await expect(answered).resolves.toBe("2");
  });

  it("reports whether user input callbacks consumed a pending request", async () => {
    let resolveText: (text: string) => void = () => undefined;
    const answered = new Promise<string>((resolve) => {
      resolveText = resolve;
    });
    const reply = createCodexUserInputPrompt({
      scope,
      resolveText,
      questions: [
        {
          id: "q1",
          header: "Mode",
          question: "Pick a mode",
          isOther: false,
          isSecret: false,
          options: [
            { label: "Execute", description: "Run now" },
            { label: "Plan", description: "Stay in planning" },
          ],
        },
      ],
    });
    const payload = readButtons(reply)[0]?.value?.slice(6) ?? "";

    expect(resolveCodexUserInputCallback({ payload, ctx })).toEqual({
      matched: true,
      consumed: true,
      message: "Sent answer to Codex.",
    });
    await expect(answered).resolves.toBe("1");
    expect(resolveCodexUserInputCallback({ payload, ctx })).toEqual({
      matched: true,
      consumed: false,
      message: "No pending Codex input request was found. The request may have expired.",
    });
    expect(resolveCodexUserInputCallback({ payload: "other:payload", ctx })).toEqual({
      matched: false,
    });
  });

  it("creates option buttons when a single question also allows an other reply", async () => {
    let resolveText: (text: string) => void = () => undefined;
    const answered = new Promise<string>((resolve) => {
      resolveText = resolve;
    });
    const reply = createCodexUserInputPrompt({
      scope,
      resolveText,
      questions: [
        {
          id: "target",
          header: "Plan Target",
          question: "Which OpenManager plan should we grill first?",
          isOther: true,
          isSecret: false,
          options: [
            { label: "Next implementation", description: "Use current alpha plan" },
            { label: "OpenClaw runtime", description: "Focus on runtime isolation" },
            { label: "Email connectors", description: "Focus on email strategy" },
          ],
        },
      ],
    });
    const buttons = readButtons(reply);

    expect(reply.text).toContain("Other: reply with your own answer.");
    expect(buttons.map((button) => button.label)).toEqual([
      "Next implementation",
      "OpenClaw runtime",
      "Email connectors",
    ]);
    expect(normalizeMessagePresentation(reply.presentation)).toBeDefined();

    expect(answerCodexUserInputCallback({ payload: buttons[2]?.value?.slice(6) ?? "", ctx })).toBe(
      "Sent answer to Codex.",
    );
    await expect(answered).resolves.toBe("3");
  });

  it("omits buttons for secret, freeform-only, or multi-question prompts", () => {
    const secret = createCodexUserInputPrompt({
      scope,
      resolveText: () => undefined,
      questions: [
        {
          id: "q1",
          header: "Secret",
          question: "Token?",
          isOther: false,
          isSecret: true,
          options: [{ label: "Yes", description: "" }],
        },
      ],
    });
    const freeform = createCodexUserInputPrompt({
      scope,
      resolveText: () => undefined,
      questions: [
        {
          id: "q1",
          header: "Other",
          question: "Type something",
          isOther: true,
          isSecret: false,
          options: null,
        },
      ],
    });
    const multi = createCodexUserInputPrompt({
      scope,
      resolveText: () => undefined,
      questions: [
        {
          id: "q1",
          header: "First",
          question: "One?",
          isOther: false,
          isSecret: false,
          options: [{ label: "Yes", description: "" }],
        },
        {
          id: "q2",
          header: "Second",
          question: "Two?",
          isOther: false,
          isSecret: false,
          options: [{ label: "No", description: "" }],
        },
      ],
    });

    expect(secret.presentation).toBeUndefined();
    expect(freeform.presentation).toBeUndefined();
    expect(multi.presentation).toBeUndefined();
  });
});

function readButtons(reply: { presentation?: { blocks?: unknown[] } }): TestButton[] {
  const block = reply.presentation?.blocks?.find((entry): entry is { buttons: TestButton[] } => {
    return (
      Boolean(entry) &&
      typeof entry === "object" &&
      Array.isArray((entry as { buttons?: unknown }).buttons)
    );
  });
  return block?.buttons ?? [];
}
