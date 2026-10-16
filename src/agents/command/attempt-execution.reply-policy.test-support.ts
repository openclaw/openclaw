import { expect, it, vi, type Mock } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import type { RunCliAgentParams } from "../cli-runner/types.js";
import { classifyEmbeddedAgentRunResultForModelFallback } from "../embedded-agent-runner/result-fallback-classifier.js";
import { FailoverError } from "../failover-error.js";
import { INTER_SESSION_REPLY_POLICY_CASES } from "./attempt-execution.announce.test-support.js";
import {
  makeSessionEntry,
  type RunAgentAttemptOverrides,
} from "./attempt-execution.cli.test-support.js";
import type { runAgentAttempt } from "./attempt-execution.js";

async function runPreparedCommandCliAttempt(params: RunCliAgentParams) {
  const { runPreparedCliAgent } =
    await vi.importActual<typeof import("../cli-runner.js")>("../cli-runner.js");
  const context = buildPreparedCliRunContext({
    workspaceDir: params.workspaceDir,
    model: params.model,
    backend: { sessionMode: "none" },
  });
  // Replace only backend preparation and I/O; command policy reaches the real
  // required-reply enforcement, recovery, and settlement owners unchanged.
  context.params = {
    ...params,
    admittedRunContext: context.params.admittedRunContext,
  };
  return runPreparedCliAgent(context);
}

export function registerCommandReplyPolicyTests({
  runStoredAttempt,
  seedSessionStore,
  runEmbeddedAgentMock,
  runCliAgentMock,
  executePreparedCliRunMock,
  expectMockArgFields,
}: {
  runStoredAttempt: (
    overrides: Omit<RunAgentAttemptOverrides, "agentDir" | "storePath" | "workspaceDir">,
  ) => ReturnType<typeof runAgentAttempt>;
  seedSessionStore: (
    sessionKey: string,
    entry: SessionEntry,
  ) => Promise<Record<string, SessionEntry>>;
  runEmbeddedAgentMock: ReturnType<typeof vi.fn>;
  runCliAgentMock: Mock<typeof runPreparedCommandCliAttempt>;
  executePreparedCliRunMock: ReturnType<typeof vi.fn>;
  expectMockArgFields: (
    mock: ReturnType<typeof vi.fn>,
    fields: Record<string, unknown>,
    callIndex?: number,
  ) => void;
}) {
  it.each(["openai", "claude-cli"])(
    "applies %s inter-session reply policy to internal, direct, and group sessions",
    async (providerOverride) => {
      const selectedRunner = providerOverride === "openai" ? runEmbeddedAgentMock : runCliAgentMock;
      for (const [
        sessionKey,
        messageChannel,
        privateCompletion,
        allowSilence,
        sourceTool = "subagent_settle",
        replyExpectation,
      ] of INTER_SESSION_REPLY_POLICY_CASES) {
        const sessionEntry = makeSessionEntry(`session-${messageChannel}`);
        const sessionStore = await seedSessionStore(sessionKey, sessionEntry);
        const expectation =
          replyExpectation === "optional"
            ? "optional"
            : privateCompletion || sessionKey.includes(":subagent:") || messageChannel === "webchat"
              ? "result-required"
              : (replyExpectation ?? (allowSilence ? "optional" : "required"));
        const resultRequired = expectation === "result-required";
        const cli = providerOverride === "claude-cli";
        if (cli) {
          runCliAgentMock.mockImplementationOnce(runPreparedCommandCliAttempt);
          executePreparedCliRunMock.mockResolvedValueOnce({
            text: "NO_REPLY",
            rawText: "NO_REPLY",
          });
        } else {
          selectedRunner.mockResolvedValueOnce({ meta: { durationMs: 1 } });
        }

        const attempt = runStoredAttempt({
          providerOverride,
          modelOverride: providerOverride === "openai" ? "gpt-5.4" : "opus",
          sessionEntry,
          sessionKey,
          sessionStore,
          messageChannel,
          cfg: { surfaces: { telegram: { silentReply: { group: "allow" } } } },
          opts: {
            privateCompletion: privateCompletion || undefined,
            replyExpectation,
            inputProvenance: sourceTool
              ? { kind: "inter_session", sourceTool }
              : { kind: "external_user" },
          },
        });
        if (cli && resultRequired) {
          await expect(attempt).rejects.toThrow("CLI backend returned an empty response.");
        } else {
          const result = await attempt;
          if (cli) {
            expect(result.payloads).toBeUndefined();
            expect(result.meta.terminalReply).toEqual({ disposition: "silent" });
            expect(result.meta.finalAssistantRawText).toBe("NO_REPLY");
            expect(result.meta.error).toBeUndefined();
            expect(
              classifyEmbeddedAgentRunResultForModelFallback({
                result,
                provider: providerOverride,
                model: "opus",
              }),
            ).toBeNull();
          }
        }

        expectMockArgFields(
          selectedRunner,
          {
            terminalReplyExpectation: expectation,
            silentReplyPromptMode: resultRequired ? "none" : undefined,
          },
          selectedRunner.mock.calls.length - 1,
        );
      }
    },
  );

  it("preserves a genuine CLI failure while consuming a private completion", async () => {
    const sessionKey = "agent:main:direct:failed-private-completion";
    const sessionEntry = makeSessionEntry("failed-private-completion");
    const failure = new FailoverError("backend unavailable", { reason: "server_error" });
    runCliAgentMock.mockImplementationOnce(runPreparedCommandCliAttempt);
    executePreparedCliRunMock.mockRejectedValueOnce(failure);

    await expect(
      runStoredAttempt({
        providerOverride: "claude-cli",
        modelOverride: "opus",
        sessionEntry,
        sessionKey,
        sessionStore: await seedSessionStore(sessionKey, sessionEntry),
        messageChannel: "webchat",
        opts: {
          privateCompletion: true,
          replyExpectation: "optional",
          inputProvenance: { kind: "inter_session", sourceTool: "subagent_settle" },
        },
      }),
    ).rejects.toBe(failure);
    expect(executePreparedCliRunMock).toHaveBeenCalledOnce();
  });
}
