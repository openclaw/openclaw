import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import type { ExecAutoReviewTranscript } from "../../../infra/exec-auto-review.js";
import type { createOpenClawCodingTools } from "../../agent-tools.js";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../../test-helpers/agent-message-fixtures.js";
import { useContextEngineAttemptHarness } from "./attempt-context-engine.test-support.js";
import { createDefaultEmbeddedSession } from "./attempt-spawn-workspace.test-support.js";
const user = (content: string, timestamp = 1) => makeAgentUserMessage({ content, timestamp });

const { hoisted, runAttempt } = useContextEngineAttemptHarness("agent:main:exec-review-transcript");

it("reads live messages and releases the review transcript after prompt failure", async () => {
  let reviewTranscript: (() => ExecAutoReviewTranscript | undefined) | undefined;
  const atDispose = vi.fn();
  const seen: ExecAutoReviewTranscript[] = [];
  await runAttempt({
    sessionMessages: [],
    attemptOverrides: {
      disableTools: false,
      config: { logging: { redactPatterns: ["tenant-private-marker"] } },
    },
    createSession: () => {
      const options = hoisted.createOpenClawCodingToolsMock.mock.calls.at(-1)?.[0] as
        | Parameters<typeof createOpenClawCodingTools>[0]
        | undefined;
      reviewTranscript = options?.exec?.reviewTranscript;
      expect(reviewTranscript).toBeTypeOf("function");
      expect(reviewTranscript?.()).toBeUndefined();
      const session = createDefaultEmbeddedSession({
        prompt: async (activeSession) => {
          const originalUser = {
            ...user("Build the project."),
            __openclaw: { senderIsOwner: true },
          };
          const runtimeUser = user("Hook-rewritten build instructions.");
          const onUserMessagePersisted =
            hoisted.guardSessionManagerMock.mock.calls.at(-1)?.[1]?.onUserMessagePersisted;
          expect(onUserMessagePersisted).toBeTypeOf("function");
          await onUserMessagePersisted?.(originalUser, runtimeUser);
          activeSession.messages = [
            runtimeUser,
            makeAgentAssistantMessage({
              content: [{ type: "text", text: "tenant-private-marker" }],
            }),
          ];
          seen.push(expectDefined(reviewTranscript?.(), "first live transcript"));
          activeSession.messages.push({
            ...user("Keep the existing output directory.", 2),
            provenance: { kind: "inter_session" },
          });
          seen.push(expectDefined(reviewTranscript?.(), "updated live transcript"));
          throw new Error("synthetic prompt failure");
        },
      });
      const dispose = session.dispose;
      session.dispose = () => {
        atDispose(reviewTranscript?.());
        dispose();
      };
      return session;
    },
  });

  expect(seen[0]?.entries).toEqual([
    { kind: "user", origin: "operator", text: "Build the project." },
    { kind: "assistant", text: "tenant-private-marker" },
  ]);
  expect(seen[1]?.entries).toEqual([
    ...seen[0]!.entries,
    { kind: "user", origin: "inter_session", text: "Keep the existing output directory." },
  ]);
  expect(atDispose).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(reviewTranscript?.()).toBeUndefined();
});
