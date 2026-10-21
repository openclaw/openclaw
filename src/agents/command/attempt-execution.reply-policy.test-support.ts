import { expect, it, vi, type Mock } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import type { RunCliAgentParams } from "../cli-runner/types.js";
import { classifyEmbeddedAgentRunResultForModelFallback as classifyFallback } from "../embedded-agent-runner/result-fallback-classifier.js";
import { FailoverError } from "../failover-error.js";
import { INTER_SESSION_REPLY_POLICY_CASES } from "./attempt-execution.announce.test-support.js";
import {
  makeSessionEntry,
  type RunAgentAttemptOverrides,
} from "./attempt-execution.cli.test-support.js";
import type { runAgentAttempt } from "./attempt-execution.js";

async function runPreparedAttempt(params: RunCliAgentParams) {
  const { runPreparedCliAgent } =
    await vi.importActual<typeof import("../cli-runner.js")>("../cli-runner.js");
  const context = buildPreparedCliRunContext({
    workspaceDir: params.workspaceDir,
    model: params.model,
    backend: { sessionMode: "none" },
  });
  // Stub backend I/O, preserving real reply enforcement, recovery, and settlement.
  context.params = {
    ...params,
    admittedRunContext: context.params.admittedRunContext,
  };
  return runPreparedCliAgent(context);
}

export function registerCommandReplyPolicyTests({
  runStoredAttempt,
  seedSessionStore,
  runCliAgentMock: cliRunner,
  executePreparedCliRunMock: execute,
}: {
  runStoredAttempt: (
    overrides: Omit<RunAgentAttemptOverrides, "agentDir" | "storePath" | "workspaceDir">,
  ) => ReturnType<typeof runAgentAttempt>;
  seedSessionStore: (
    sessionKey: string,
    entry: SessionEntry,
  ) => Promise<Record<string, SessionEntry>>;
  runCliAgentMock: Mock<typeof runPreparedAttempt>;
  executePreparedCliRunMock: ReturnType<typeof vi.fn>;
}) {
  it("applies inter-session reply policy through the CLI runtime", async () => {
    for (const [
      sessionKey,
      messageChannel,
      privateCompletion,
      replyExpectation,
      expectation,
    ] of INTER_SESSION_REPLY_POLICY_CASES) {
      const sessionEntry = makeSessionEntry(`session-${messageChannel}`);
      cliRunner.mockImplementationOnce(runPreparedAttempt);
      execute.mockResolvedValueOnce({ text: "NO_REPLY", rawText: "NO_REPLY" });
      const attempt = runStoredAttempt({
        providerOverride: "claude-cli",
        modelOverride: "opus",
        sessionEntry,
        sessionKey,
        sessionStore: await seedSessionStore(sessionKey, sessionEntry),
        messageChannel,
        cfg: { surfaces: { telegram: { silentReply: { group: "allow" } } } },
        opts: {
          privateCompletion,
          replyExpectation,
          inputProvenance: { kind: "inter_session", sourceTool: "subagent_settle" },
        },
      });
      const resultRequired = expectation === "result-required";
      if (resultRequired) {
        await expect(attempt).rejects.toThrow("CLI backend returned an empty response.");
      } else {
        const result = await attempt;
        expect([result.payloads, result.meta.error]).toEqual([undefined, undefined]);
        expect(result.meta.terminalReply).toEqual({ disposition: "silent" });
        expect(result.meta.finalAssistantRawText).toBe("NO_REPLY");
        expect(classifyFallback({ result, provider: "claude-cli", model: "opus" })).toBeNull();
      }
      expect(cliRunner.mock.calls.at(-1)?.[0]).toMatchObject({
        terminalReplyExpectation: expectation,
        silentReplyPromptMode: resultRequired ? "none" : undefined,
      });
    }
  });

  it("preserves a genuine CLI failure while consuming a private completion", async () => {
    const sessionKey = "agent:main:direct:failed-private-completion";
    const sessionEntry = makeSessionEntry("failed-private-completion");
    const failure = new FailoverError("backend unavailable", { reason: "server_error" });
    cliRunner.mockImplementationOnce(runPreparedAttempt);
    execute.mockRejectedValueOnce(failure);

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
    expect(execute).toHaveBeenCalledOnce();
  });
}
