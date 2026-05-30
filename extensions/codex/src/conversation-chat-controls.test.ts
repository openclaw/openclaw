import { afterEach, describe, expect, it } from "vitest";
import {
  answerCodexUserInput,
  buildCodexPlanDecisionReply,
  consumeCodexPlanDecision,
  createCodexUserInputPrompt,
  hasCodexProposedPlan,
  resetCodexConversationChatControlsForTests,
} from "./conversation-chat-controls.js";

type TestButton = {
  label: string;
  value: string;
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
    expect(buttons.map((button) => button.value.split(" ").slice(0, 3).join(" "))).toEqual([
      "/codex plan approve",
      "/codex plan approve-clean",
      "/codex plan stay",
    ]);

    const token = buttons[0]?.value.split(" ").at(-1) ?? "";
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
    const token = readButtons(reply)[0]?.value.split(" ").at(-1) ?? "";

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
    expect(buttons.map((button) => button.value.split(" ").at(-1))).toEqual(["1", "2"]);

    const [token, answer] = buttons[1]?.value.split(" ").slice(2) ?? [];
    expect(answerCodexUserInput({ token: token ?? "", answerText: answer ?? "", ctx })).toBe(
      "Sent answer to Codex.",
    );
    await expect(answered).resolves.toBe("2");
  });

  it("omits buttons for secret, freeform, or multi-question prompts", () => {
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
          options: [{ label: "Yes", description: "" }],
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

    expect(secret.interactive).toBeUndefined();
    expect(freeform.interactive).toBeUndefined();
    expect(multi.interactive).toBeUndefined();
  });
});

function readButtons(reply: { interactive?: { blocks?: unknown[] } }): TestButton[] {
  const block = reply.interactive?.blocks?.find((entry): entry is { buttons: TestButton[] } => {
    return (
      Boolean(entry) &&
      typeof entry === "object" &&
      Array.isArray((entry as { buttons?: unknown }).buttons)
    );
  });
  return block?.buttons ?? [];
}
