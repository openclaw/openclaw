import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReplyToolAuthorityOverlay } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import { createOperationalRunInstanceRef, prepareAgentRunAdmission } from "../admitted-run-context.js";
import {
  clearActiveEmbeddedRun,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  setActiveEmbeddedRun,
} from "../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle, testing } from "../embedded-agent-runner/runs.test-support.js";
import {
  getGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import { withPreparedEmbeddedRunToolAuthority } from "./tool-authority.runtime.js";

/**
 * Redacted terminal trace (not a behavior test): drives the production
 * admission path, reply-run registry, and `withPreparedEmbeddedRunToolAuthority`
 * through the #139847 sequence under controlled fault injection, logging each
 * evidence element to the terminal. Run with:
 *   vitest run src/agents/harness/tool-authority.runtime.authority-chain-trace.test.ts
 */

const sessionId = "trace-session";
const sessionKey = "agent:main:main";
const own: ReplyToolAuthorityOverlay = {
  senderIsOwner: true,
  disableTools: false,
  traceAuthorized: false,
  messageProvider: "webchat",
};
const attempt = {
  sessionId,
  sessionKey,
  runId: "trace-run",
  agentId: "main",
  config: { tools: { toolsBySender: { "*": { allow: [] } } } } as Record<string, unknown>,
  sessionFile: "/tmp/trace-session.jsonl",
  workspaceDir: "/tmp/trace-workspace",
  provider: "openai",
  modelId: "gpt-test",
  sandboxSessionKey: sessionKey,
  senderIsOwner: true,
  messageProvider: "webchat",
  traceAuthorized: false,
};

const t0 = Date.now();
const log = (element: string, step: string, detail: string) =>
  console.log(`[+${String(Date.now() - t0).padStart(4, "0")}ms] [${element}] ${step} :: ${detail}`);
const redact = (fp: string | undefined) =>
  fp ? `${fp.slice(0, 8)}…${fp.slice(-4)} (len=${fp.length})` : "(none)";

async function admitted<T>(
  run: (ctx: {
    admittedRunContext: Awaited<ReturnType<ReturnType<typeof prepareAgentRunAdmission>["admit"]>>;
    close: () => void;
  }) => Promise<T>,
) {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    operationalRunInstance: createOperationalRunInstanceRef(attempt.runId),
    facts: {
      agentId: "main",
      runId: attempt.runId,
      ingress: { kind: "system", state: "present", boundary: "authority-chain-trace" },
    },
  });
  try {
    return await run({
      admittedRunContext: await admission.admit("embedded", "authority-chain-trace"),
      close: admission.close,
    });
  } finally {
    admission.close();
  }
}

function steer(overlay: ReplyToolAuthorityOverlay, hash?: string) {
  return queueEmbeddedAgentMessageWithOutcomeAsync(sessionId, "Use the release branch", {
    isInboundUserMessage: true,
    toolAuthorityOverlay: overlay,
    toolAuthorityFingerprint: hash,
    taskSuggestionDeliveryMode: undefined,
  });
}

afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  replyTesting.resetReplyRunRegistry();
  vi.restoreAllMocks();
});

describe("retired-operation fallback: authority-chain terminal trace (#139847)", () => {
  it("produces the redacted evidence trace under controlled fault injection", async () => {
    console.log("=== retired-operation fallback authority-chain trace (#139847) ===");
    console.log("fault injection: captured reply operation retired before route bind");
    console.log("stack: real admission -> real reply-run registry -> production wrapper");
    console.log("");

    // --- #139847 sequence: an earlier reply run was active; the new message
    // retired that operation before this attempt binds its route.
    const retired = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
    retired.complete();
    log("1 identify", "captured reply operation", "retired via complete() before bind (controlled fault injection)");

    await admitted(async ({ admittedRunContext }) =>
      withPreparedEmbeddedRunToolAuthority(
        { admittedRunContext, replyOperation: retired },
        { ...attempt, toolAuthorityFingerprint: "stale-fingerprint" },
        undefined,
        async (prepared) => {
          log(
            "1 identify",
            "fallback authority fingerprint",
            `captured stale fp discarded; direct-prepared fp bound = ${redact(prepared.toolAuthorityFingerprint)} (nonempty)`,
          );

          const queue = async () => {};
          const handle = createEmbeddedRunHandle({
            runId: attempt.runId,
            toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
            queueMessage: queue,
          });
          setActiveEmbeddedRun(sessionId, handle, sessionKey, attempt.sessionFile);
          try {
            // element 2: the intended turn completes through the fallback authority
            const ownerOutcome = await steer(own, prepared.toolAuthorityFingerprint);
            log(
              "2 continuation",
              "owner steering accepted",
              `queued=${ownerOutcome.queued} - the retired-operation turn keeps working end-to-end`,
            );

            // element 3: policy-restricted caller rejected before effects
            const weakerOutcome = await steer(
              { ...own, senderIsOwner: false },
              prepared.toolAuthorityFingerprint,
            );
            log(
              "3 weaker caller",
              "policy-restricted caller rejected",
              `queued=${weakerOutcome.queued} - no delivery, no effects`,
            );

            // element 4a: superseded authority rejected before effects
            const overlay = {
              ...own,
              get permissionMode() {
                withoutGatewayToolCallerIdentity(() =>
                  setActiveEmbeddedRun(
                    sessionId,
                    createEmbeddedRunHandle({ runId: "superseding-run", queueMessage: queue }),
                    sessionKey,
                  ),
                );
                return undefined;
              },
            };
            const superseded = await steer(overlay, prepared.toolAuthorityFingerprint);
            log(
              "4 superseded",
              "superseding run mid-projection",
              `steer to old authority rejected: queued=${superseded.queued} - neither handle received effects`,
            );

            // element 4b: revoked authority (admission closed) rejected before effects
            const retained = getGatewayToolCallerIdentity();
            let revokeResult = "n/a";
            if (retained) {
              try {
                await withGatewayToolCallerIdentity(retained, () =>
                  setActiveEmbeddedRun(
                    sessionId,
                    createEmbeddedRunHandle({ runId: attempt.runId }),
                    sessionKey,
                    attempt.sessionFile,
                  ),
                );
                revokeResult = "NOT rejected (unexpected)";
              } catch (err) {
                revokeResult = `rejected: ${(err as Error).message}`;
              }
            }
            log("4 revoked", "closed claim republishing a run handle", revokeResult);

            expect(prepared.toolAuthorityFingerprint).toMatch(/^[a-f0-9]{64}$/);
            expect(prepared.toolAuthorityFingerprint).not.toBe("stale-fingerprint");
            expect(ownerOutcome.queued).toBe(true);
            expect(weakerOutcome.queued).toBe(false);
            expect(superseded.queued).toBe(false);
            expect(revokeResult).toContain("rejected");
          } finally {
            clearActiveEmbeddedRun(sessionId, handle, sessionKey);
          }
        },
      ),
    );

    console.log("");
    console.log("=== trace complete: 4/4 evidence elements observed, assertions passed ===");
  });
});
