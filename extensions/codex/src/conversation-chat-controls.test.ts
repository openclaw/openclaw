import { normalizeMessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  answerCodexUserInputFreeform,
  answerCodexUserInputCallback,
  buildCodexUserInputSequentialPrompt,
  buildCodexPlanDecisionReply,
  consumeCodexPlanDecision,
  createCodexUserInputPrompt,
  createCodexUserInputSequentialControl,
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
    expect(reply.text).toBe("do this");
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

  it("records multi-question option buttons until every option question is answered", async () => {
    let resolveText: (text: string) => void = () => undefined;
    const answered = new Promise<string>((resolve) => {
      resolveText = resolve;
    });
    const reply = createCodexUserInputPrompt({
      scope,
      resolveText,
      questions: [
        {
          id: "shape",
          header: "Plan",
          question: "Which plan shape?",
          isOther: false,
          isSecret: false,
          options: [
            { label: "Small Patch", description: "Narrow" },
            { label: "Feature Slice", description: "Broad" },
          ],
        },
        {
          id: "approval",
          header: "Approval",
          question: "Approve?",
          isOther: false,
          isSecret: false,
          options: [
            { label: "Approve", description: "Proceed" },
            { label: "Hold", description: "Wait" },
          ],
        },
      ],
    });
    const buttons = readButtons(reply);

    expect(buttons.map((button) => button.label)).toEqual([
      "Plan: Small Patch",
      "Plan: Feature Slice",
      "Approval: Approve",
      "Approval: Hold",
    ]);
    expect(normalizeMessagePresentation(reply.presentation)).toBeDefined();

    // Legacy one-shot path: click the first button and the second click
    // finishes the request. Partial click is "consumed: false" so the
    // user can still click buttons for the remaining question; the
    // merged answer is sent only when the final answer is recorded.
    expect(
      resolveCodexUserInputCallback({ payload: buttons[0]?.value?.slice(6) ?? "", ctx }),
    ).toEqual({
      matched: true,
      consumed: false,
      message: "Recorded answer for Plan.",
    });
    expect(
      resolveCodexUserInputCallback({ payload: buttons[2]?.value?.slice(6) ?? "", ctx }),
    ).toEqual({
      matched: true,
      consumed: true,
      message: "Sent answer to Codex.",
    });
    await expect(answered).resolves.toBe("shape: Small Patch\napproval: Approve");
  });

  it("completes multi-question prompts with a button answer and a typed other answer", async () => {
    let resolveText: (text: string) => void = () => undefined;
    const answered = new Promise<string>((resolve) => {
      resolveText = resolve;
    });
    const reply = createCodexUserInputPrompt({
      scope,
      resolveText,
      questions: [
        {
          id: "shape",
          header: "Plan",
          question: "Which plan shape?",
          isOther: false,
          isSecret: false,
          options: [
            { label: "Small Patch", description: "Narrow" },
            { label: "Feature Slice", description: "Broad" },
          ],
        },
        {
          id: "approval",
          header: "Approval",
          question: "Approve?",
          isOther: true,
          isSecret: false,
          options: [
            { label: "Approve", description: "Proceed" },
            { label: "Hold", description: "Wait" },
          ],
        },
      ],
    });
    const buttons = readButtons(reply);

    // Legacy one-shot path: first click records but does not resolve
    // (consumed=false so the user can still answer the second question);
    // the typed other answer for the second question completes the
    // request.
    expect(
      resolveCodexUserInputCallback({ payload: buttons[0]?.value?.slice(6) ?? "", ctx }),
    ).toEqual({
      matched: true,
      consumed: false,
      message: "Recorded answer for Plan.",
    });
    expect(
      answerCodexUserInputFreeform({
        answerText: "approve after updating the fake plan",
        ctx,
        sessionFile: scope.sessionFile,
      }),
    ).toEqual({ matched: true, consumed: true, message: "Sent answer to Codex." });
    await expect(answered).resolves.toBe(
      "shape: Small Patch\napproval: approve after updating the fake plan",
    );
  });

  it("consumes scoped freeform replies only for prompts that allow other answers", async () => {
    let resolveText: (text: string) => void = () => undefined;
    const answered = new Promise<string>((resolve) => {
      resolveText = resolve;
    });
    createCodexUserInputPrompt({
      scope,
      resolveText,
      questions: [
        {
          id: "target",
          header: "Plan Target",
          question: "Which plan?",
          isOther: true,
          isSecret: false,
          options: [{ label: "Runtime", description: "" }],
        },
      ],
    });

    expect(
      answerCodexUserInputFreeform({
        answerText: "can openmanager execute?",
        ctx,
        sessionFile: scope.sessionFile,
      }),
    ).toEqual({ matched: true, consumed: true, message: "Sent answer to Codex." });
    await expect(answered).resolves.toBe("can openmanager execute?");
  });

  it("leaves typed messages alone for non-other prompts and slash commands", () => {
    createCodexUserInputPrompt({
      scope,
      resolveText: () => undefined,
      questions: [
        {
          id: "target",
          header: "Plan Target",
          question: "Which plan?",
          isOther: false,
          isSecret: false,
          options: [{ label: "Runtime", description: "" }],
        },
      ],
    });

    expect(
      answerCodexUserInputFreeform({
        answerText: "Runtime",
        ctx,
        sessionFile: scope.sessionFile,
      }),
    ).toEqual({ matched: false });
    expect(
      answerCodexUserInputFreeform({
        answerText: "/codex input token Runtime",
        ctx,
        sessionFile: scope.sessionFile,
      }),
    ).toEqual({ matched: false });
  });

  it("leaves incomplete multi-question freeform text alone", () => {
    createCodexUserInputPrompt({
      scope,
      resolveText: () => undefined,
      questions: [
        {
          id: "shape",
          header: "Plan",
          question: "Which plan shape?",
          isOther: true,
          isSecret: false,
          options: [
            { label: "Small Patch", description: "Narrow" },
            { label: "Feature Slice", description: "Broad" },
          ],
        },
        {
          id: "approval",
          header: "Approval",
          question: "Approve?",
          isOther: true,
          isSecret: false,
          options: [
            { label: "Approve", description: "Proceed" },
            { label: "Hold", description: "Wait" },
          ],
        },
      ],
    });

    expect(
      answerCodexUserInputFreeform({
        answerText: "the questions should have interactive buttons",
        ctx,
        sessionFile: scope.sessionFile,
      }),
    ).toEqual({ matched: false });
  });

  it("does not consume freeform replies from another control scope", () => {
    createCodexUserInputPrompt({
      scope,
      resolveText: () => undefined,
      questions: [
        {
          id: "target",
          header: "Plan Target",
          question: "Which plan?",
          isOther: true,
          isSecret: false,
          options: [{ label: "Runtime", description: "" }],
        },
      ],
    });

    expect(
      answerCodexUserInputFreeform({
        answerText: "custom answer",
        ctx: { ...ctx, senderId: "user-2" },
        sessionFile: scope.sessionFile,
      }),
    ).toEqual({ matched: false });
  });

  it("accepts typed numeric or label replies for sequential prompts as a fallback to button clicks", async () => {
    // Regression: a user that replies '1' (or pastes the option label
    // instead of pressing a rendered button) should still resolve the
    // active request_user_input instead of being routed to a new
    // turn. Channels that cannot render or keep buttons (e.g. plain
    // text relays) rely on this fallback.
    let resolveText: (text: string) => void = () => undefined;
    const answered = new Promise<string>((resolve) => {
      resolveText = resolve;
    });
    const emittedPayloads: Array<{ labels: string[] }> = [];
    const { token, payload } = createCodexUserInputSequentialControl({
      scope,
      resolveText,
      questions: [
        {
          id: "feature",
          header: "Feature",
          question: "Which feature?",
          isOther: false,
          isSecret: false,
          options: [
            { label: "Demo panel (Recommended)", description: "Visible" },
            { label: "CLI flag", description: "No-op" },
          ],
        },
        {
          id: "approval",
          header: "Approval",
          question: "Approve?",
          isOther: true,
          isSecret: false,
          options: [{ label: "Approve (Recommended)", description: "Proceed" }],
        },
      ],
      emitNextPrompt: async (nextIndex) => {
        const next = buildCodexUserInputSequentialPrompt({
          token,
          questions: [
            {
              id: "feature",
              header: "Feature",
              question: "Which feature?",
              isOther: false,
              isSecret: false,
              options: [
                { label: "Demo panel (Recommended)", description: "Visible" },
                { label: "CLI flag", description: "No-op" },
              ],
            },
            {
              id: "approval",
              header: "Approval",
              question: "Approve?",
              isOther: true,
              isSecret: false,
              options: [{ label: "Approve (Recommended)", description: "Proceed" }],
            },
          ],
          questionIndex: nextIndex,
        });
        emittedPayloads.push({ labels: readButtons(next).map((b) => b.label) });
      },
    });
    emittedPayloads.push({ labels: readButtons(payload).map((b) => b.label) });

    // User types the numeric prefix instead of pressing the button.
    const result = answerCodexUserInputFreeform({
      answerText: "2",
      ctx,
      sessionFile: scope.sessionFile,
    });
    expect(result).toEqual({ matched: true, consumed: true, message: "" });
    expect(emittedPayloads).toHaveLength(2);
    expect(emittedPayloads[1]?.labels).toEqual(["Approve (Recommended)"]);

    // The label-form reply should also resolve the final question.
    const q2Callback = readButtons(
      buildCodexUserInputSequentialPrompt({
        token,
        questions: [
          {
            id: "feature",
            header: "Feature",
            question: "Which feature?",
            isOther: false,
            isSecret: false,
            options: [
              { label: "Demo panel (Recommended)", description: "Visible" },
              { label: "CLI flag", description: "No-op" },
            ],
          },
          {
            id: "approval",
            header: "Approval",
            question: "Approve?",
            isOther: true,
            isSecret: false,
            options: [{ label: "Approve (Recommended)", description: "Proceed" }],
          },
        ],
        questionIndex: 1,
      }),
    )[0]?.value?.slice(6) ?? "";
    expect(
      answerCodexUserInputFreeform({
        answerText: "Approve (Recommended)",
        ctx,
        sessionFile: scope.sessionFile,
      }),
    ).toEqual({ matched: true, consumed: true, message: "Sent answer to Codex." });
    await expect(answered).resolves.toBe(
      "feature: CLI flag\napproval: Approve (Recommended)",
    );
    expect(q2Callback).toBeTypeOf("string");
  });

  it("omits buttons for secret or freeform-only prompts", () => {
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
    expect(secret.presentation).toBeUndefined();
    expect(freeform.presentation).toBeUndefined();
  });

  it("omits buttons for mixed multi-question prompts that cannot be completed by controls", () => {
    const mixed = createCodexUserInputPrompt({
      scope,
      resolveText: () => undefined,
      questions: [
        {
          id: "mode",
          header: "Mode",
          question: "Pick a mode",
          isOther: false,
          isSecret: false,
          options: [{ label: "Fast", description: "" }],
        },
        {
          id: "note",
          header: "Note",
          question: "Add a note",
          isOther: true,
          isSecret: false,
          options: null,
        },
      ],
    });

    expect(mixed.presentation).toBeUndefined();
  });

  it("renders only the first question's buttons in sequential mode and posts the next question after each answer", async () => {
    let resolveText: (text: string) => void = () => undefined;
    const answered = new Promise<string>((resolve) => {
      resolveText = resolve;
    });
    const emittedPayloads: Array<{ text: string; labels: string[] }> = [];
    const { token, payload } = createCodexUserInputSequentialControl({
      scope,
      resolveText,
      questions: [
        {
          id: "shape",
          header: "Plan",
          question: "Which plan shape?",
          isOther: false,
          isSecret: false,
          options: [
            { label: "Small Patch", description: "Narrow" },
            { label: "Feature Slice", description: "Broad" },
          ],
        },
        {
          id: "approval",
          header: "Approval",
          question: "Approve?",
          isOther: false,
          isSecret: false,
          options: [
            { label: "Approve", description: "Proceed" },
            { label: "Hold", description: "Wait" },
          ],
        },
      ],
      emitNextPrompt: async (nextIndex) => {
        const nextPayload = buildCodexUserInputSequentialPrompt({
          token,
          questions: [
            {
              id: "shape",
              header: "Plan",
              question: "Which plan shape?",
              isOther: false,
              isSecret: false,
              options: [
                { label: "Small Patch", description: "Narrow" },
                { label: "Feature Slice", description: "Broad" },
              ],
            },
            {
              id: "approval",
              header: "Approval",
              question: "Approve?",
              isOther: false,
              isSecret: false,
              options: [
                { label: "Approve", description: "Proceed" },
                { label: "Hold", description: "Wait" },
              ],
            },
          ],
          questionIndex: nextIndex,
        });
        emittedPayloads.push({
          text: nextPayload.text,
          labels: readButtons(nextPayload).map((button) => button.label),
        });
      },
    });
    emittedPayloads.push({
      text: payload.text,
      labels: readButtons(payload).map((button) => button.label),
    });

    // First prompt must show only Q1's buttons (no Plan: prefix).
    expect(emittedPayloads[0]?.labels).toEqual(["Small Patch", "Feature Slice"]);
    expect(emittedPayloads[0]?.text).toContain("Codex needs input:");
    expect(emittedPayloads[0]?.text).toContain("Plan");

    // Click Q1 button 0 -> emitNextPrompt(1) should fire and post Q2.
    const q1Callback = readButtons(payload)[0]?.value?.slice(6) ?? "";
    expect(resolveCodexUserInputCallback({ payload: q1Callback, ctx })).toEqual({
      matched: true,
      consumed: true,
      message: "",
    });

    expect(emittedPayloads).toHaveLength(2);
    expect(emittedPayloads[1]?.labels).toEqual(["Approve", "Hold"]);
    expect(emittedPayloads[1]?.text).toContain("Approval");

    // Click Q2 button 0 -> final resolution.
    const q2Payload = buildCodexUserInputSequentialPrompt({
      token,
      questions: [
        {
          id: "shape",
          header: "Plan",
          question: "Which plan shape?",
          isOther: false,
          isSecret: false,
          options: [
            { label: "Small Patch", description: "Narrow" },
            { label: "Feature Slice", description: "Broad" },
          ],
        },
        {
          id: "approval",
          header: "Approval",
          question: "Approve?",
          isOther: false,
          isSecret: false,
          options: [
            { label: "Approve", description: "Proceed" },
            { label: "Hold", description: "Wait" },
          ],
        },
      ],
      questionIndex: 1,
    });
    const q2Callback = readButtons(q2Payload)[0]?.value?.slice(6) ?? "";
    expect(resolveCodexUserInputCallback({ payload: q2Callback, ctx })).toEqual({
      matched: true,
      consumed: true,
      message: "Sent answer to Codex.",
    });

    await expect(answered).resolves.toBe("shape: Small Patch\napproval: Approve");
    expect(emittedPayloads).toHaveLength(2);
  });

  it("rejects out-of-order button clicks in sequential mode", async () => {
    let resolveText: (text: string) => void = () => undefined;
    const answered = new Promise<string>((resolve) => {
      resolveText = resolve;
    });
    const { payload, token } = createCodexUserInputSequentialControl({
      scope,
      resolveText,
      questions: [
        {
          id: "shape",
          header: "Plan",
          question: "Which plan shape?",
          isOther: false,
          isSecret: false,
          options: [{ label: "Small Patch", description: "Narrow" }],
        },
        {
          id: "approval",
          header: "Approval",
          question: "Approve?",
          isOther: false,
          isSecret: false,
          options: [{ label: "Approve", description: "Proceed" }],
        },
      ],
      emitNextPrompt: async () => undefined,
    });
    const q1Callback = readButtons(payload)[0]?.value?.slice(6) ?? "";

    // Build a Q2 callback manually (the user clicked the stale Q2 row
    // before Q1 was answered; in practice Q2 is not yet posted, but the
    // callback value is still parseable).
    const q2Payload = buildCodexUserInputSequentialPrompt({
      token,
      questions: [
        {
          id: "shape",
          header: "Plan",
          question: "Which plan shape?",
          isOther: false,
          isSecret: false,
          options: [{ label: "Small Patch", description: "Narrow" }],
        },
        {
          id: "approval",
          header: "Approval",
          question: "Approve?",
          isOther: false,
          isSecret: false,
          options: [{ label: "Approve", description: "Proceed" }],
        },
      ],
      questionIndex: 1,
    });
    const q2Callback = readButtons(q2Payload)[0]?.value?.slice(6) ?? "";

    // First, the Q2 click before Q1 is rejected as "awaiting Plan".
    expect(resolveCodexUserInputCallback({ payload: q2Callback, ctx })).toEqual({
      matched: true,
      consumed: false,
      message: "Awaiting answer for Plan.",
    });
    expect(await Promise.race([answered, Promise.resolve("unresolved")])).toBe("unresolved");

    // Then Q1 click is accepted and advances the index; the merge is
    // completed by the Q2 click that follows.
    expect(resolveCodexUserInputCallback({ payload: q1Callback, ctx })).toEqual({
      matched: true,
      consumed: true,
      message: "",
    });
    expect(resolveCodexUserInputCallback({ payload: q2Callback, ctx })).toEqual({
      matched: true,
      consumed: true,
      message: "Sent answer to Codex.",
    });
    await expect(answered).resolves.toBe("shape: Small Patch\napproval: Approve");
  });

  it("answers the currently-shown question via freeform text in sequential mode", async () => {
    let resolveText: (text: string) => void = () => undefined;
    const answered = new Promise<string>((resolve) => {
      resolveText = resolve;
    });
    const emittedPayloads: Array<{ labels: string[] }> = [];
    const { token, payload } = createCodexUserInputSequentialControl({
      scope,
      resolveText,
      questions: [
        {
          id: "shape",
          header: "Plan",
          question: "Which plan shape?",
          isOther: false,
          isSecret: false,
          options: [{ label: "Small Patch", description: "Narrow" }],
        },
        {
          id: "approval",
          header: "Approval",
          question: "Approve?",
          isOther: true,
          isSecret: false,
          options: [{ label: "Approve", description: "Proceed" }],
        },
      ],
      emitNextPrompt: async (nextIndex) => {
        const next = buildCodexUserInputSequentialPrompt({
          token,
          questions: [
            {
              id: "shape",
              header: "Plan",
              question: "Which plan shape?",
              isOther: false,
              isSecret: false,
              options: [{ label: "Small Patch", description: "Narrow" }],
            },
            {
              id: "approval",
              header: "Approval",
              question: "Approve?",
              isOther: true,
              isSecret: false,
              options: [{ label: "Approve", description: "Proceed" }],
            },
          ],
          questionIndex: nextIndex,
        });
        emittedPayloads.push({ labels: readButtons(next).map((b) => b.label) });
      },
    });
    emittedPayloads.push({ labels: readButtons(payload).map((b) => b.label) });

    // Q1 has a numbered/label button row. A user reply that
    // matches neither the numeric prefix nor an option label is
    // rejected (the legacy safety net stays in place).
    expect(
      answerCodexUserInputFreeform({
        answerText: "totally unrelated reply",
        ctx,
        sessionFile: scope.sessionFile,
      }),
    ).toEqual({ matched: false });

    // Q1 has a numeric prefix; a user typing "1" instead of pressing
    // the button should still resolve the active turn.
    expect(
      answerCodexUserInputFreeform({
        answerText: "1",
        ctx,
        sessionFile: scope.sessionFile,
      }),
    ).toEqual({ matched: true, consumed: true, message: "" });
    expect(emittedPayloads).toHaveLength(2);
    expect(emittedPayloads[1]?.labels).toEqual(["Approve"]);

    // Freeform text now answers Q2 and resolves the request.
    expect(
      answerCodexUserInputFreeform({
        answerText: "approve after revising the plan",
        ctx,
        sessionFile: scope.sessionFile,
      }),
    ).toEqual({ matched: true, consumed: true, message: "Sent answer to Codex." });
    await expect(answered).resolves.toBe(
      "shape: Small Patch\napproval: approve after revising the plan",
    );
  });

  it("answers the first question of a sequential prompt via freeform text when Other is allowed", async () => {
    let resolveText: (text: string) => void = () => undefined;
    const answered = new Promise<string>((resolve) => {
      resolveText = resolve;
    });
    const emittedPayloads: Array<{ labels: string[] }> = [];
    const { token, payload } = createCodexUserInputSequentialControl({
      scope,
      resolveText,
      questions: [
        {
          id: "feature",
          header: "Feature",
          question: "Which feature?",
          isOther: true,
          isSecret: false,
          options: [
            { label: "Demo panel (Recommended)", description: "Visible" },
            { label: "CLI flag", description: "No-op" },
          ],
        },
        {
          id: "approval",
          header: "Approval",
          question: "Approve?",
          isOther: true,
          isSecret: false,
          options: [{ label: "Approve (Recommended)", description: "Proceed" }],
        },
      ],
      emitNextPrompt: async (nextIndex) => {
        const next = buildCodexUserInputSequentialPrompt({
          token,
          questions: [
            {
              id: "feature",
              header: "Feature",
              question: "Which feature?",
              isOther: true,
              isSecret: false,
              options: [
                { label: "Demo panel (Recommended)", description: "Visible" },
                { label: "CLI flag", description: "No-op" },
              ],
            },
            {
              id: "approval",
              header: "Approval",
              question: "Approve?",
              isOther: true,
              isSecret: false,
              options: [{ label: "Approve (Recommended)", description: "Proceed" }],
            },
          ],
          questionIndex: nextIndex,
        });
        emittedPayloads.push({ labels: readButtons(next).map((b) => b.label) });
      },
    });
    emittedPayloads.push({ labels: readButtons(payload).map((b) => b.label) });

    // Q1 has isOther=true. Typing a custom answer should match the
    // currently-shown question (not the legacy all-question merge
    // rule) and advance to Q2.
    expect(
      answerCodexUserInputFreeform({
        answerText: "Custom feature scope for the demo",
        ctx,
        sessionFile: scope.sessionFile,
      }),
    ).toEqual({ matched: true, consumed: true, message: "" });
    expect(emittedPayloads).toHaveLength(2);
    expect(emittedPayloads[1]?.labels).toEqual(["Approve (Recommended)"]);

    // Q2 typed answer finalizes.
    expect(
      answerCodexUserInputFreeform({
        answerText: "Approve with caveats noted in plan",
        ctx,
        sessionFile: scope.sessionFile,
      }),
    ).toEqual({ matched: true, consumed: true, message: "Sent answer to Codex." });
    await expect(answered).resolves.toBe(
      "feature: Custom feature scope for the demo\napproval: Approve with caveats noted in plan",
    );
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
