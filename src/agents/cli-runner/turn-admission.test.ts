import { expect, it } from "vitest";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { runWithCliTurn } from "./turn-admission.js";

it("carries unbound mailbox cancellation into a borrowed CLI turn", async () => {
  const abort = new AbortController();
  const reason = new Error("mailbox owner stopped");
  const identity = {
    sessionKey: "agent:main:unbound-cli-cancellation",
    storePath: "/synthetic/unbound-cli-cancellation.sqlite",
  };

  await withSessionTurn({ ...identity, abortSignal: abort.signal }, async () => {
    await runWithCliTurn(
      {
        ...identity,
        sessionId: "",
        runId: "unbound-cli-cancellation",
        sessionFile: "/synthetic/unbound-cli-cancellation.jsonl",
        workspaceDir: "/synthetic",
        prompt: "synthetic input",
        provider: "fixture-cli",
        timeoutMs: 1_000,
      },
      async (params) => {
        expect(params.replyOperation).toBeUndefined();
        expect(params.abortSignal?.aborted).toBe(false);
        abort.abort(reason);
        expect(params.abortSignal?.aborted).toBe(true);
        expect(params.abortSignal?.reason).toBe(reason);
        return { meta: { durationMs: 0 } };
      },
    );
  });
});
