import { expect, it } from "vitest";
import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import { withPreparedEmbeddedRunToolAuthority } from "./tool-authority.runtime.js";

// Shared regression contract with #165122: compare actual admitted attempt and reply owners.
it.each([
  { level: "off" },
  { level: "on" },
  { level: "ask" },
  { level: "full" },
  { level: "off", forceRestartSafeTools: true },
  { level: "off", forceCodeModeTools: true },
] as const)(
  "captures the admitted $level execution and $forceRestartSafeTools/$forceCodeModeTools restrictions",
  async ({ level, ...toolMode }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const runId = `execution-level-${level}`;
      const bashElevated = { enabled: true, allowed: true, defaultLevel: level };
      const attempt = {
        sessionId: `session-${level}`,
        sessionKey: "agent:main:execution-level",
        runId,
        agentId: "main",
        config: {},
        sessionFile: state.path("execution-level.jsonl"),
        workspaceDir: state.workspaceDir,
        provider: "openai",
        modelId: "synthetic-model",
        senderIsOwner: true,
        messageProvider: "webchat",
        traceAuthorized: false,
        bashElevated,
        ...toolMode,
      };
      setRuntimeConfigSnapshot(attempt.config);
      const admission = prepareAgentRunAdmission({
        cfg: attempt.config,
        operationalRunInstance: createOperationalRunInstanceRef(runId),
        facts: {
          agentId: "main",
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
            const input = {
              ...toolMode,
              run: { ...attempt, model: attempt.modelId, elevatedLevel: level },
            };
            const matching = prepareReplyToolAuthority(input);
            const narrowed = prepareReplyToolAuthority({
              ...toolMode,
              run: { ...input.run, bashElevated: { ...bashElevated, allowed: false } },
            });
            try {
              expect(prepared.toolAuthorityFingerprint).toBe(await matching.fingerprintAsync());
              expect(prepared.toolAuthorityFingerprint).not.toBe(await narrowed.fingerprintAsync());
            } finally {
              matching.close();
              narrowed.close();
            }
          },
        );
      } finally {
        admission.close();
      }
    });
  },
);
