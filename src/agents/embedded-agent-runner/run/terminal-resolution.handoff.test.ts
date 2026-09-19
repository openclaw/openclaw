import { describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import {
  emptyAssistant,
  makeTerminalInput,
  type TerminalInput,
} from "./terminal-resolution.test-support.js";

vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));

const handoffParams = {
  allowEmptyAssistantReplyAsSilent: true,
  sourceReplyDeliveryMode: "message_tool_only",
  inputProvenance: {
    kind: "inter_session",
    sourceTool: "sessions_send",
    sourceSessionKey: "agent:sender:main",
  },
} satisfies Partial<TerminalInput["runParams"]>;

function handoffInput(
  assistant: ReturnType<typeof emptyAssistant> | undefined,
  runParams: Partial<TerminalInput["runParams"]> = {},
) {
  const attempt = makeEmbeddedRunnerAttempt({
    assistantTexts: [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptCompletedAssistant: assistant,
    currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
  });
  return makeTerminalInput({ attempt, runParams: { ...handoffParams, ...runParams } });
}

describe("inter-session terminal replies", () => {
  it.each([{ content: [] }, { content: [{ type: "text", text: " \n" }] }] as const)(
    "accepts a clean empty sessions_send stop with content $content",
    async ({ content }) => {
      const input = handoffInput(emptyAssistant({ content: [...content] }));
      const result = await resolveEmbeddedRunTerminal(input);
      expect(result).toMatchObject({
        action: "complete",
        result: {
          payloads: [{ text: SILENT_REPLY_TOKEN }],
          meta: { terminalReplyKind: "silent-empty" },
        },
      });
      expect(input.activateInternalPrompt).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "explicit required reply", terminalReplyExpectation: "required" },
    { name: "disabled silence", allowEmptyAssistantReplyAsSilent: false },
    { name: "automatic source delivery", sourceReplyDeliveryMode: "automatic" },
    { name: "unknown source", inputProvenance: { kind: "inter_session", sourceTool: "unknown" } },
    { name: "missing source", inputProvenance: { kind: "inter_session" } },
    {
      name: "external user",
      inputProvenance: { kind: "external_user", sourceTool: "sessions_send" },
    },
  ] satisfies Array<Partial<TerminalInput["runParams"]> & { name: string }>)(
    "keeps $name on the empty-response recovery path",
    async ({ name: _name, ...runParams }) => {
      const input = handoffInput(emptyAssistant(), runParams);
      await expect(resolveEmbeddedRunTerminal(input)).resolves.toEqual({ action: "retry" });
      expect(input.retryState.emptyResponseAttempts).toBe(1);
      expect(input.activateInternalPrompt).toHaveBeenCalledWith(
        expect.stringContaining("previous attempt did not produce a user-visible answer"),
      );
    },
  );

  it.each(["sessions_send", "exec_approval_followup"])(
    "recovers signed and unsigned reasoning from %s",
    async (sourceTool) => {
      for (const thinkingSignature of [undefined, '{"id":"rs_handoff","type":"reasoning"}']) {
        const assistant = buildEmbeddedRunnerAssistant({
          content: [
            { type: "thinking", thinking: "Still considering the result.", thinkingSignature },
          ],
        });
        const input = handoffInput(assistant, {
          inputProvenance: { kind: "inter_session", sourceTool },
        });
        await expect(resolveEmbeddedRunTerminal(input)).resolves.toEqual({ action: "retry" });
        expect(input.retryState.reasoningOnlyAttempts).toBe(1);
        expect(input.activateInternalPrompt).toHaveBeenCalledWith(
          expect.stringContaining("recorded reasoning but did not produce a user-visible answer"),
        );
      }
    },
  );

  it("recovers an empty approval followup even when silence is allowed", async () => {
    const input = handoffInput(emptyAssistant(), {
      inputProvenance: { kind: "inter_session", sourceTool: "exec_approval_followup" },
      terminalReplyExpectation: "required",
    });
    await expect(resolveEmbeddedRunTerminal(input)).resolves.toEqual({ action: "retry" });
    expect(input.retryState.emptyResponseAttempts).toBe(1);
  });

  it("does not mistake a missing assistant for a clean completion", async () => {
    const input = handoffInput(undefined);
    await expect(resolveEmbeddedRunTerminal(input)).resolves.toEqual({ action: "retry" });
    expect(input.retryState.missingAssistantAttempts).toBe(1);
  });

  it("continues a provider compaction checkpoint instead of declaring silence", async () => {
    const input = handoffInput(
      emptyAssistant({
        providerReplay: {
          v: 1,
          type: "anthropic-compaction",
          data: "synthetic-checkpoint",
          provider: "anthropic",
          api: "anthropic-messages",
          model: "proof-model",
          baseUrlHash: "proof-base-url",
        },
      }),
    );
    await expect(resolveEmbeddedRunTerminal(input)).resolves.toEqual({ action: "retry" });
  });

  it("does not authorize silence or replay after side effects", async () => {
    const input = handoffInput(emptyAssistant());
    input.attempt.replayMetadata = { hadPotentialSideEffects: true, replaySafe: false };
    input.attempt.currentAttemptReplayMetadata = input.attempt.replayMetadata;
    input.replayState = { ...input.attempt.replayMetadata, replayInvalid: true };
    const result = await resolveEmbeddedRunTerminal(input);
    expect(result).toMatchObject({
      action: "complete",
      result: { meta: { error: { kind: "incomplete_turn" } } },
    });
    if (result.action === "complete") {
      expect(result.result.meta.terminalReplyKind).not.toBe("silent-empty");
    }
    expect(input.activateInternalPrompt).not.toHaveBeenCalled();
  });
});
