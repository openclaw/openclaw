import { expect, it } from "vitest";
import { resolveFollowupRunToolAuthorityFingerprint } from "../../auto-reply/reply/reply-tool-authority.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import { withPreparedEmbeddedRunToolAuthority } from "./tool-authority.runtime.js";

it.each(["off", "on", "ask", "full"] as const)(
  "matches reply authority for the declared %s execution level",
  async (level) => {
    const sessionKey = "agent:main:main";
    const runId = `execution-level-${level}`;
    const bashElevated = { enabled: true, allowed: true, defaultLevel: level };
    const attempt = {
      sessionId: `session-${level}`,
      sessionKey,
      runId,
      agentId: "main",
      config: {},
      sessionFile: `/tmp/execution-level-${level}.jsonl`,
      workspaceDir: "/tmp/execution-level-workspace",
      provider: "openai",
      modelId: "gpt-test",
      sandboxSessionKey: sessionKey,
      senderIsOwner: true,
      messageProvider: "webchat",
      traceAuthorized: false,
      bashElevated,
    };
    const admission = prepareAgentRunAdmission({
      cfg: attempt.config,
      operationalRunInstance: createOperationalRunInstanceRef(runId),
      facts: {
        agentId: attempt.agentId,
        runId,
        ingress: { kind: "system", state: "present", boundary: "execution-level-test" },
      },
    });
    try {
      const admittedRunContext = await admission.admit("embedded", "execution-level-test");
      await withPreparedEmbeddedRunToolAuthority(
        { admittedRunContext },
        attempt,
        undefined,
        async (prepared) => {
          const replyInput = { run: { ...attempt, model: attempt.modelId, elevatedLevel: level } };
          expect(prepared.toolAuthorityFingerprint).toBe(
            resolveFollowupRunToolAuthorityFingerprint(replyInput),
          );
          expect(prepared.toolAuthorityFingerprint).not.toBe(
            resolveFollowupRunToolAuthorityFingerprint({
              run: { ...replyInput.run, bashElevated: { ...bashElevated, allowed: false } },
            }),
          );
        },
      );
    } finally {
      admission.close();
    }
  },
);
