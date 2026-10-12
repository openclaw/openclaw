import { describe, expect, it } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { captureCliRunToolAuthority } from "./tool-authority.js";

describe("CLI question creator binding", () => {
  it("carries the host-issued profile and refuses it after its source is revoked", async () => {
    let active = true;
    const source = createAdmittedRunOperatorAuthority({
      profileId: "creator-profile",
      scopes: ["operator.write"],
      assertCurrent: () => {
        if (!active) {
          throw new Error("source revoked");
        }
      },
    });
    const authority = captureCliRunToolAuthority(
      {
        sessionId: "agent:main:question",
        sessionFile: "/workspace/session.jsonl",
        workspaceDir: "/workspace",
        provider: "fixture",
        prompt: "question",
        timeoutMs: 1_000,
        runId: "question-creator",
      },
      { agentId: "main", workspaceDir: "/workspace", cwd: "/workspace" },
    );
    const bound = await authority.bindQuestions(
      { provider: "fixture", model: "fixture" },
      () => source,
    );
    const question = bound.bindQuestionAnswerAuthority(() => {});
    expect(question.requesterProfileId).toBe("creator-profile");
    expect(() => question.assertActive()).not.toThrow();
    active = false;
    expect(() => question.assertActive()).toThrow("source revoked");
  });
});
