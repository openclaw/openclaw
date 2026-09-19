import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import {
  prepareSystemAgentRunAdmission,
  type AdmittedRunContext,
} from "../../admitted-run-context.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { prepareTerminalWithSettledTurnFinalization } from "./settled-turn-finalization.js";
import { createSettledFinalizationTestInput } from "./settled-turn-finalization.test-support.js";

const backendMocks = vi.hoisted(() => ({ runSettledFinalization: vi.fn() }));
const transcriptMocks = vi.hoisted(() => ({ appendAssistantMirrorMessageByIdentity: vi.fn() }));

vi.mock("./backend.js", () => ({
  resolveRuntimeModelAttempt: vi.fn(),
  runEmbeddedSettledTurnFinalizationWithBackend: backendMocks.runSettledFinalization,
}));
vi.mock("../../../plugin-sdk/session-transcript-runtime.js", () => ({
  appendAssistantMirrorMessageByIdentity: transcriptMocks.appendAssistantMirrorMessageByIdentity,
}));

describe("prepareTerminalWithSettledTurnFinalization canonical silence", () => {
  let admission: ReturnType<typeof prepareSystemAgentRunAdmission>;
  let admittedRunContext: AdmittedRunContext;
  beforeEach(async () => {
    backendMocks.runSettledFinalization.mockReset();
    transcriptMocks.appendAssistantMirrorMessageByIdentity.mockReset();
    admission = prepareSystemAgentRunAdmission({}, "run-settled", "main", "finalization-test");
    admittedRunContext = await admission.admit("embedded");
  });
  afterEach(() => admission.close());

  it.each(
    [true, false, undefined].flatMap((allowEmptyAssistantReplyAsSilent) =>
      [
        { name: "reaction only", earlierText: undefined, phased: false },
        {
          name: "formatted answer",
          earlierText: "## Result\n\n- **Saved** the note.",
          phased: false,
        },
        { name: "commentary and phased silence", earlierText: "Finishing the task.", phased: true },
      ].map(({ name, earlierText, phased }) => ({
        name,
        earlierText,
        phased,
        allowEmptyAssistantReplyAsSilent,
      })),
    ),
  )(
    "preserves canonical silence after $name (allow empty: $allowEmptyAssistantReplyAsSilent)",
    async ({ earlierText, phased, allowEmptyAssistantReplyAsSilent }) => {
      const attempt = makeEmbeddedRunnerAttempt({
        sessionIdUsed: "session-settled",
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      });
      const toolAssistant = buildEmbeddedRunnerAssistant({
        stopReason: "toolUse",
        content: [
          { type: "toolCall", id: "reaction", name: "message", arguments: { action: "react" } },
        ],
      });
      const earlierAnswer = buildEmbeddedRunnerAssistant({
        stopReason: "toolUse",
        content: [
          {
            type: "text",
            text: earlierText ?? "",
            textSignature: JSON.stringify({ v: 1, id: "earlier-answer", phase: "final_answer" }),
          },
        ],
      });
      const assistant = buildEmbeddedRunnerAssistant({
        content: phased
          ? [
              {
                type: "text",
                text: "Nothing else to add.",
                textSignature: JSON.stringify({ v: 1, id: "progress", phase: "commentary" }),
              },
              {
                type: "text",
                text: SILENT_REPLY_TOKEN,
                textSignature: JSON.stringify({ v: 1, id: "silent-answer", phase: "final_answer" }),
              },
            ]
          : [{ type: "text", text: SILENT_REPLY_TOKEN }],
      });
      attempt.messagesSnapshot = [
        toolAssistant,
        {
          role: "toolResult",
          toolCallId: "reaction",
          toolName: "message",
          content: [{ type: "text", text: "Reaction added" }],
          isError: false,
          timestamp: 1,
        },
        ...(earlierText ? [earlierAnswer] : []),
        assistant,
      ];
      attempt.toolMetas = [{ toolName: "message", meta: "react", replaySafe: false }];
      attempt.itemLifecycle = { startedCount: 1, completedCount: 1, activeCount: 0 };
      attempt.assistantTexts = [...(earlierText ? [earlierText] : []), SILENT_REPLY_TOKEN];
      attempt.lastAssistant = assistant;
      attempt.currentAttemptAssistant = assistant;
      attempt.currentAttemptCompletedAssistant = assistant;
      attempt.settledTurnFinalizationContext = undefined;
      const input = createSettledFinalizationTestInput(attempt, admittedRunContext);
      input.terminalBase.runParams.trigger = "user";
      input.terminalBase.runParams.allowEmptyAssistantReplyAsSilent =
        allowEmptyAssistantReplyAsSilent;

      const result = await prepareTerminalWithSettledTurnFinalization(input);

      expect(backendMocks.runSettledFinalization).not.toHaveBeenCalled();
      expect(transcriptMocks.appendAssistantMirrorMessageByIdentity).not.toHaveBeenCalled();
      expect(result.finalizationOutcome).toBe("not-attempted");
      if (!phased) {
        expect(result.prepared.finalAssistantRawText).toBe(SILENT_REPLY_TOKEN);
      }
      expect(result.prepared.payloadsWithToolMedia).toEqual([]);
      expect(result.attempt).toBe(attempt);
    },
  );
});
