import { describe, expect, it } from "vitest";
import type { ExecAutoReviewTranscript } from "../infra/exec-auto-review.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { createReviewerHarness, input } from "./exec-auto-reviewer.test-support.js";
import { makeAssistantMessageFixture } from "./test-helpers/assistant-message-fixtures.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

describe("exec reviewer person authority", () => {
  it.each([
    { scopes: undefined, direct: false },
    { scopes: ["operator.write"], direct: false },
    { scopes: ["operator.admin"], direct: true },
  ])(
    "separates live permission from historical origin and high-risk intent: $scopes",
    async ({ scopes, direct }) => {
      const { reviewer, complete } = createReviewerHarness();
      const profileId = "private-person-identifier";
      const authority =
        scopes &&
        createAdmittedRunOperatorAuthority({ profileId, scopes, assertCurrent: () => {} });
      const transcript: ExecAutoReviewTranscript = {
        entries: [{ kind: "user", origin: "channel", text: "Start a task for this investigation" }],
        omittedEntries: 0,
        truncated: false,
      };
      complete.mockResolvedValueOnce(
        makeAssistantMessageFixture({
          stopReason: "stop",
          errorMessage: undefined,
          content: [
            {
              type: "text",
              text: JSON.stringify({ decision: "allow", risk: "high", user_authorization: "high" }),
            },
          ],
        }),
      );
      const decision = await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:shared",
          operatorAuthority: authority,
          directHumanRequesterProfileId: direct ? profileId : undefined,
        },
        () => reviewer({ ...input, transcript }),
      );
      expect(decision).toMatchObject({ decision: "ask", risk: "high", userAuthorization: "high" });
      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            systemPrompt: expect.stringContaining(
              `HOST_VERIFIED_CURRENT_AUTHORITY_JSON: ${JSON.stringify({ verifiedPerson: Boolean(scopes), directHumanRequest: direct, scopes: scopes ?? [] })}`,
            ),
            messages: [
              expect.objectContaining({
                content: expect.stringContaining(
                  "[user|origin=channel] Start a task for this investigation",
                ),
              }),
            ],
          }),
        }),
      );
      expect(JSON.stringify(complete.mock.calls)).not.toContain(profileId);
      expect(transcript.entries[0]?.origin).toBe("channel");
    },
  );

  it.each(["before", "preparation", "completion"] as const)(
    "never publishes an allow when person authority is revoked during %s",
    async (stage) => {
      const { reviewer, prepare, complete } = createReviewerHarness();
      let revoked = stage === "before";
      const authority = createAdmittedRunOperatorAuthority({
        profileId: "person",
        scopes: ["operator.write"],
        assertCurrent: () => {
          if (revoked) {
            throw new Error("person authority revoked");
          }
        },
      });
      if (stage === "preparation") {
        const original = prepare.getMockImplementation()!;
        prepare.mockImplementationOnce(async (request) => {
          const result = await original(request);
          revoked = true;
          return result;
        });
      } else if (stage === "completion") {
        const original = complete.getMockImplementation()!;
        complete.mockImplementationOnce(async (request) => {
          const result = await original(request);
          revoked = true;
          return result;
        });
      }
      await expect(
        withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: "agent:main:shared",
            operatorAuthority: authority,
          },
          () => reviewer(input),
        ),
      ).resolves.toMatchObject({
        decision: "ask",
        rationale: expect.stringContaining("person authority revoked"),
      });
      expect(prepare).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
      expect(complete).toHaveBeenCalledTimes(stage === "completion" ? 1 : 0);
    },
  );
});
