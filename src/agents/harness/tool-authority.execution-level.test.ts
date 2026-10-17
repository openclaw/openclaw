import { expect, it } from "vitest";
import {
  prepareReplyToolAuthority,
  ReplyToolExecutionMismatchError,
  resolveInboundReplyToolAuthorityOverlay,
} from "../../auto-reply/reply/reply-tool-authority.js";
import { captureRuntimeConfigAsyncReader } from "../../config/config.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import { prepareReplyToolAuthorityCallerRead } from "./host-private-capabilities.js";
import { withPreparedEmbeddedRunToolAuthority } from "./tool-authority.runtime.js";

it.each([
  { level: "off" },
  { level: "on" },
  { level: "ask" },
  { level: "full" },
  { level: "off", forceRestartSafeTools: true },
  { level: "off", forceCodeModeTools: true },
] as const)(
  "matches reply authority for the declared $level execution level ($forceRestartSafeTools/$forceCodeModeTools)",
  async ({ level, ...toolMode }) => {
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
      ...toolMode,
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
          const replyInput = {
            ...toolMode,
            run: { ...attempt, model: attempt.modelId, elevatedLevel: level },
          };
          const matching = prepareReplyToolAuthority(replyInput);
          const narrowed = prepareReplyToolAuthority({
            ...toolMode,
            run: { ...replyInput.run, bashElevated: { ...bashElevated, allowed: false } },
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
  },
);

it.each(["unchanged", "model", "profile", "elevated", "exec"] as const)(
  "retains direct-owner execution compatibility for %s input",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await state.writeConfig({});
      await captureRuntimeConfigAsyncReader()();
      const sessionKey = "agent:main:direct-execution-compatibility";
      const sessionId = "direct-execution-compatibility";
      await upsertSessionEntryCore({ agentId: "main", sessionKey }, { sessionId, updatedAt: 1 });
      const run = {
        config: {},
        agentId: "main",
        sessionKey,
        sessionId,
        sessionFile: state.path("execution-owner.jsonl"),
        agentDir: state.agentDir(),
        workspaceDir: state.path("workspace"),
        provider: "openai",
        model: "model-a",
        authProfileId: "account-a",
        authProfileIdSource: "user" as const,
        elevatedLevel: "full" as const,
        bashElevated: { enabled: true, allowed: true, defaultLevel: "full" as const },
        execOverrides: { security: "full" as const },
        senderIsOwner: false,
        traceAuthorized: false,
      };
      const authority = prepareReplyToolAuthority({ run });
      try {
        const route = { provider: run.provider, model: run.model };
        const expected = await authority.fingerprintAsync(route);
        const executionCompatibility = {
          ...run,
          ...(kind === "model" ? { model: "model-b" } : {}),
          ...(kind === "profile" ? { authProfileId: "account-b" } : {}),
          ...(kind === "elevated"
            ? {
                elevatedLevel: "off" as const,
                bashElevated: { ...run.bashElevated, defaultLevel: "off" as const },
              }
            : {}),
          ...(kind === "exec" ? { execOverrides: { security: "deny" as const } } : {}),
        };
        const overlay = {
          ...resolveInboundReplyToolAuthorityOverlay({
            ctx: {},
            senderIsOwner: false,
            disableTools: false,
          }),
          executionCompatibility,
        };
        const projected = await authority.projectAsync(overlay, route);
        if (kind === "unchanged") {
          expect(projected).toBe(expected);
          const caller = await prepareReplyToolAuthorityCallerRead(
            authority.projectAsync,
            overlay,
            expected,
            route,
            () => {},
          );
          expect(caller).toBeDefined();
          await caller?.prepareCurrent();
        } else {
          expect(projected).not.toBe(expected);
          await expect(
            prepareReplyToolAuthorityCallerRead(
              authority.projectAsync,
              overlay,
              expected,
              route,
              () => {},
            ),
          ).rejects.toThrow(ReplyToolExecutionMismatchError);
        }
      } finally {
        authority.close();
      }
    });
  },
);
